const express = require("express");
const { pool } = require("../db");
const { requireDeviceAuth } = require("../middleware/deviceAuth");
const { sendError, asyncHandler } = require("../lib/errors");
const { rateLimit } = require("../lib/rateLimit");
const { UUID_PATTERN, expireStaleCommands, formatCommand, COMMAND_SELECT } = require("../lib/commands");
const { CONTACTOR_STATES } = require("../validation/readings");

// ESP32-facing command endpoints, authenticated with X-API-Key only.
const router = express.Router();

const ipLimiter = rateLimit({ name: "device_ip", windowMs: 60_000, max: 600, key: (req) => req.ip });
const pollLimiter = rateLimit({ name: "command_poll", windowMs: 60_000, max: 120, key: (req) => req.controllerId });

router.use(ipLimiter, requireDeviceAuth, pollLimiter);

// ---------------------------------------------------------
// POST /api/device/commands/poll
// Returns this controller's in-flight, unexpired commands and marks them delivered.
// A command stays in the list (same command_id, delivery_count + 1) until it is acknowledged
// or expires, so a lost response is simply redelivered. Firmware must:
//   - remember command_ids it already executed and never execute one twice;
//   - not execute a command once its expires_at has passed (compare with server_time).
// ---------------------------------------------------------
router.post(
  "/poll",
  asyncHandler("Poll commands", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expireStaleCommands(client, { controllerId: req.controllerId });
      const result = await client.query(
        `UPDATE commands SET status = 'delivered',
                             delivered_at = COALESCE(delivered_at, NOW()),
                             delivery_count = delivery_count + 1
         WHERE controller_id = $1 AND status IN ('pending', 'delivered') AND expires_at > NOW()
         RETURNING command_id`,
        [req.controllerId]
      );
      // Polling also proves the controller is connected.
      await client.query(`UPDATE devices SET last_seen = NOW() WHERE device_id = $1`, [req.controllerId]);
      const ids = result.rows.map((r) => r.command_id);
      const commands = ids.length
        ? (await client.query(`${COMMAND_SELECT} WHERE c.command_id = ANY($1::uuid[]) ORDER BY c.created_at`, [ids])).rows
        : [];
      await client.query("COMMIT");

      res.json({
        server_time: new Date().toISOString(),
        commands: commands.map((c) => ({
          command_id: c.command_id,
          breaker_id: c.breaker_id,
          channel_number: c.channel_number,
          requested_state: c.requested_state,
          created_at: c.created_at.toISOString(),
          expires_at: c.expires_at.toISOString(),
          delivery_count: c.delivery_count,
        })),
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })
);

// ---------------------------------------------------------
// POST /api/device/commands/:command_id/ack
// Body: { "status": "succeeded" | "failed", "contactor_state": "ON", "error": "..." }
// Repeating the same acknowledgement is harmless (200, duplicate: true). An acknowledgement
// that arrives after expiry is still recorded, because it describes what the device did.
// ---------------------------------------------------------
router.post(
  "/:command_id/ack",
  asyncHandler("Acknowledge command", async (req, res) => {
    const { status, contactor_state, error } = req.body || {};
    if (status !== "succeeded" && status !== "failed") {
      return sendError(res, 400, "VALIDATION_FAILED", "status must be succeeded or failed", { field: "status" });
    }
    const reported = typeof contactor_state === "string" ? contactor_state.toUpperCase() : contactor_state ?? null;
    if (reported !== null && !CONTACTOR_STATES.includes(reported)) {
      return sendError(res, 400, "VALIDATION_FAILED", "contactor_state must be ON, OFF, TRIPPED or UNKNOWN", { field: "contactor_state" });
    }
    if (status === "failed" && (typeof error !== "string" || !error.trim())) {
      return sendError(res, 400, "VALIDATION_FAILED", "error is required when status is failed", { field: "error" });
    }
    // Commands of other controllers are reported as not found, never as "forbidden".
    if (!UUID_PATTERN.test(req.params.command_id)) {
      return sendError(res, 404, "COMMAND_NOT_FOUND", "Command not found");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        `SELECT * FROM commands WHERE command_id = $1 AND controller_id = $2 FOR UPDATE`,
        [req.params.command_id, req.controllerId]
      );
      const command = found.rows[0];
      if (!command) {
        await client.query("ROLLBACK");
        return sendError(res, 404, "COMMAND_NOT_FOUND", "Command not found");
      }

      if (command.status === "succeeded" || command.status === "failed") {
        await client.query("COMMIT");
        if (command.status !== status) {
          return sendError(res, 409, "COMMAND_ALREADY_ACKNOWLEDGED", `Command was already acknowledged as ${command.status}`);
        }
        const current = await pool.query(`${COMMAND_SELECT} WHERE c.command_id = $1`, [command.command_id]);
        return res.json({ ...formatCommand(current.rows[0]), duplicate: true });
      }

      const late = new Date(command.expires_at).getTime() <= Date.now();
      await client.query(
        `UPDATE commands SET status = $2, acknowledged_at = NOW(),
                             delivered_at = COALESCE(delivered_at, NOW()),
                             reported_contactor_state = $3, error = $4
         WHERE command_id = $1`,
        [
          command.command_id,
          status,
          reported ?? (status === "succeeded" ? command.requested_state : null),
          status === "failed" ? error.trim().slice(0, 500) : null,
        ]
      );
      // The breaker's reported state follows what the firmware says it commanded.
      const newState = reported ?? (status === "succeeded" ? command.requested_state : null);
      if (newState) {
        await client.query(`UPDATE breakers SET contactor_state = $2 WHERE id = $1`, [command.breaker_pk, newState]);
      }
      await client.query(`UPDATE devices SET last_seen = NOW() WHERE device_id = $1`, [req.controllerId]);
      const updated = await client.query(`${COMMAND_SELECT} WHERE c.command_id = $1`, [command.command_id]);
      await client.query("COMMIT");
      res.json({ ...formatCommand(updated.rows[0]), duplicate: false, late });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })
);

module.exports = router;