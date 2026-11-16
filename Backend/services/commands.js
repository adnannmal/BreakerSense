// Remote ON/OFF command lifecycle.
//
//   user  POST /api/breakers/:id/commands  -> QUEUED (older pending ones for that breaker -> SUPERSEDED)
//   ESP32 POST /api/device/v1/commands/poll -> DELIVERED (re-sent until acked or expired; the
//         firmware must execute each command_id at most once)
//   ESP32 POST /api/device/v1/commands/:id/ack -> APPLIED | FAILED | REJECTED
//   no ack before expires_at -> EXPIRED (an expired command is never handed out again)
//
// Legacy firmware (POST /readings/command + status in POST /readings) is supported for the
// channel-1 alias breaker: the command is mirrored into devices.requested_status, and a matching
// status report marks it APPLIED (ack_source = legacy_status_report).
//
// APPLIED = the controller REPORTED it set its output. Without auxiliary-contact wiring the
// physical contactor position is UNKNOWN; never show it as confirmed.

const { config } = require("../config");
const { loadOwnedBreaker, isRecent, iso } = require("./breakers");

const ACTIONS = ["ON", "OFF"];
const ACK_RESULTS = ["APPLIED", "FAILED", "REJECTED"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class CommandError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function serializeCommand(c) {
  return {
    command_id: c.command_id,
    breaker_id: c.breaker_id,
    controller_id: c.controller_id,
    channel_number: c.channel_number,
    action: c.action,
    status: c.status,
    requested_at: iso(c.created_at),
    expires_at: iso(c.expires_at),
    delivered_at: iso(c.delivered_at),
    delivery_count: c.delivery_count,
    acknowledged_at: iso(c.acknowledged_at),
    ack_source: c.ack_source,
    reported_output_state: c.reported_state || "UNKNOWN",
    physical_feedback_state: "UNKNOWN",
    failure_reason: c.failure_reason,
  };
}

function isAliasBreaker(b) {
  return b.breaker_id === b.controller_id && b.channel_number === 1;
}

async function expirePending(db, controllerId) {
  await db.query(
    `UPDATE commands SET status = 'EXPIRED'
     WHERE controller_id = $1 AND status IN ('QUEUED', 'DELIVERED') AND expires_at <= NOW()`,
    [controllerId]
  );
}

// Throws CommandError. Returns { command, replayed }.
async function createCommand(pool, { userId, breakerId, action, idempotencyKey = null }) {
  if (!ACTIONS.includes(action)) throw new CommandError(400, "VALIDATION_ERROR", "action must be ON or OFF", { field: "action" });
  if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || !/^[\x21-\x7e]{1,100}$/.test(idempotencyKey))) {
    throw new CommandError(400, "VALIDATION_ERROR", "Idempotency-Key must be 1-100 printable characters");
  }

  const breaker = await loadOwnedBreaker(pool, userId, breakerId);
  if (!breaker) throw new CommandError(404, "BREAKER_NOT_FOUND", "Breaker not found");

  if (idempotencyKey) {
    const prior = await pool.query(`SELECT * FROM commands WHERE requested_by = $1 AND idempotency_key = $2`, [userId, idempotencyKey]);
    if (prior.rows[0]) {
      const c = prior.rows[0];
      if (c.breaker_id !== breakerId || c.action !== action) {
        throw new CommandError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different command");
      }
      return { command: c, replayed: true };
    }
  }

  if (action === "ON") {
    // Safety gates. OFF is always allowed to be queued.
    if (breaker.contactor_state === "TRIPPED" || (isAliasBreaker(breaker) && breaker.c_status === "TRIPPED")) {
      throw new CommandError(409, "BREAKER_TRIPPED", "A tripped breaker cannot be turned on remotely");
    }
    const { onlineAfterSeconds } = config();
    if (!isRecent(breaker.c_last_seen_at, onlineAfterSeconds)) {
      throw new CommandError(409, "CONTROLLER_OFFLINE", `Controller has not reported in the last ${onlineAfterSeconds} s; ON is not allowed`);
    }
    if (breaker.sensor_status === "error" || breaker.sensor_status === "offline") {
      throw new CommandError(409, "SENSOR_FAULT", "The breaker's meter is reporting a fault; ON is not allowed until it reads normally");
    }
  }

  const { commandTtlSeconds } = config();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE commands SET status = 'SUPERSEDED' WHERE breaker_id = $1 AND status IN ('QUEUED', 'DELIVERED')`,
      [breakerId]
    );
    const inserted = await client.query(
      `INSERT INTO commands (breaker_id, controller_id, channel_number, action, requested_by, idempotency_key, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(secs => $7::int))
       RETURNING *`,
      [breakerId, breaker.controller_id, breaker.channel_number, action, userId, idempotencyKey, commandTtlSeconds]
    );
    const command = inserted.rows[0];
    if (isAliasBreaker(breaker)) {
      await client.query(
        `UPDATE devices SET requested_status = $1, command_expires_at = $2 WHERE device_id = $3`,
        [action, command.expires_at, breaker.controller_id]
      );
    }
    await client.query("COMMIT");
    return { command, replayed: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") throw new CommandError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key is already in use");
    throw err;
  } finally {
    client.release();
  }
}

// Owner-scoped read (expires stale commands first so status is honest).
async function getCommand(pool, userId, commandId) {
  if (!UUID_RE.test(commandId)) return null;
  const r = await pool.query(
    `SELECT c.* FROM commands c JOIN breakers b ON b.breaker_id = c.breaker_id
     WHERE c.command_id = $1 AND b.user_id = $2`,
    [commandId, userId]
  );
  const c = r.rows[0];
  if (!c) return null;
  await expirePending(pool, c.controller_id);
  const again = await pool.query(`SELECT * FROM commands WHERE command_id = $1`, [commandId]);
  return again.rows[0];
}

// Device poll: everything still pending for this controller, marked DELIVERED.
async function pollCommands(pool, controllerId) {
  await expirePending(pool, controllerId);
  const r = await pool.query(
    `UPDATE commands
     SET status = 'DELIVERED', delivered_at = COALESCE(delivered_at, NOW()), delivery_count = delivery_count + 1
     WHERE controller_id = $1 AND status IN ('QUEUED', 'DELIVERED') AND expires_at > NOW()
     RETURNING *`,
    [controllerId]
  );
  return r.rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

// Device ack. Throws CommandError. Returns { command, duplicate }.
async function ackCommand(pool, controllerId, commandId, { result, reportedState = null, reason = null }) {
  if (!UUID_RE.test(commandId)) throw new CommandError(404, "COMMAND_NOT_FOUND", "Command not found");
  if (!ACK_RESULTS.includes(result)) {
    throw new CommandError(400, "VALIDATION_ERROR", "result must be APPLIED, FAILED or REJECTED", { field: "result" });
  }
  if (reportedState !== null && !["ON", "OFF", "UNKNOWN"].includes(reportedState)) {
    throw new CommandError(400, "VALIDATION_ERROR", "reported_output_state must be ON, OFF or UNKNOWN", { field: "reported_output_state" });
  }
  if (reason !== null && (typeof reason !== "string" || reason.length > 200)) {
    throw new CommandError(400, "VALIDATION_ERROR", "reason must be a string of at most 200 characters", { field: "reason" });
  }

  const r = await pool.query(`SELECT * FROM commands WHERE command_id = $1 AND controller_id = $2`, [commandId, controllerId]);
  const c = r.rows[0];
  if (!c) throw new CommandError(404, "COMMAND_NOT_FOUND", "Command not found");

  if (ACK_RESULTS.includes(c.status)) {
    if (c.status === result) return { command: c, duplicate: true };
    throw new CommandError(409, "COMMAND_ALREADY_ACKNOWLEDGED", `Command was already acknowledged as ${c.status}`);
  }
  if (c.status === "QUEUED") throw new CommandError(409, "COMMAND_NOT_DELIVERED", "Command was never delivered to this controller");
  if (c.status === "SUPERSEDED") throw new CommandError(409, "COMMAND_SUPERSEDED", "A newer command replaced this one");

  const { commandAckGraceSeconds } = config();
  const deadline = new Date(c.expires_at).getTime() + commandAckGraceSeconds * 1000;
  if (Date.now() > deadline) {
    await pool.query(`UPDATE commands SET status = 'EXPIRED' WHERE command_id = $1 AND status IN ('QUEUED', 'DELIVERED')`, [commandId]);
    throw new CommandError(409, "COMMAND_EXPIRED", "Command expired before it was acknowledged");
  }

  const updated = await pool.query(
    `UPDATE commands
     SET status = $2, acknowledged_at = NOW(), ack_source = 'v1_ack', reported_state = $3, failure_reason = $4
     WHERE command_id = $1 AND status IN ('DELIVERED', 'EXPIRED') AND delivered_at IS NOT NULL
     RETURNING *`,
    [commandId, result, reportedState, reason]
  );
  if (!updated.rows[0]) throw new CommandError(409, "COMMAND_STATE_CHANGED", "Command changed state, fetch it again");
  const command = updated.rows[0];

  const alias = command.breaker_id === command.controller_id && command.channel_number === 1;
  if (result === "APPLIED") {
    const state = reportedState && reportedState !== "UNKNOWN" ? reportedState : command.action;
    await pool.query(
      `UPDATE breakers SET contactor_state = $2, contactor_state_at = NOW(), updated_at = NOW() WHERE breaker_id = $1`,
      [command.breaker_id, state]
    );
    if (alias) {
      await pool.query(
        `UPDATE devices SET status = $2,
                requested_status = CASE WHEN requested_status = $3 THEN NULL ELSE requested_status END,
                command_expires_at = CASE WHEN requested_status = $3 THEN NULL ELSE command_expires_at END
         WHERE device_id = $1`,
        [command.controller_id, state, command.action]
      );
    }
  } else if (alias) {
    await pool.query(
      `UPDATE devices SET requested_status = NULL, command_expires_at = NULL WHERE device_id = $1 AND requested_status = $2`,
      [command.controller_id, command.action]
    );
  }
  return { command, duplicate: false };
}

module.exports = {
  ACTIONS,
  UUID_RE,
  CommandError,
  serializeCommand,
  createCommand,
  getCommand,
  pollCommands,
  ackCommand,
  expirePending,
};
