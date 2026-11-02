const express = require("express");
const crypto = require("node:crypto");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendError, asyncHandler } = require("../lib/errors");
const { rateLimit } = require("../lib/rateLimit");
const { formatBreaker, connectionStatus, iso } = require("../lib/health");
const { ID_PATTERN } = require("../validation/readings");
const {
  commandTtlSeconds,
  expireStaleCommands,
  formatCommand,
  COMMAND_SELECT,
} = require("../lib/commands");

const router = express.Router();
router.use(requireAuth);

const MAX_CHANNELS = () => (Number(process.env.MAX_BREAKERS_PER_CONTROLLER) > 0 ? Number(process.env.MAX_BREAKERS_PER_CONTROLLER) : 8);

const commandLimiter = rateLimit({ name: "commands", windowMs: 60_000, max: 30, key: (req) => `user:${req.userId}` });

// Loads a breaker only if the logged-in user owns its controller. Unknown and not-yours
// both return 404 so other users' ids can't be probed.
async function loadOwnedBreaker(db, userId, controllerId, breakerId, { lock = false } = {}) {
  const result = await db.query(
    `SELECT b.* FROM breakers b
     JOIN devices d ON d.device_id = b.controller_id
     WHERE b.controller_id = $1 AND b.breaker_id = $2 AND d.user_id = $3
     ${lock ? "FOR UPDATE OF b" : ""}`,
    [controllerId, breakerId, userId]
  );
  return result.rows[0] || null;
}

function breakerNotFound(res) {
  return sendError(res, 404, "BREAKER_NOT_FOUND", "Breaker not found");
}

function formatController(device, breakers, now = Date.now()) {
  return {
    controller_id: device.device_id,
    name: device.nickname,
    location: device.location,
    health: { connection: connectionStatus(device.last_seen, now), last_seen: iso(device.last_seen) },
    created_at: iso(device.created_at),
    breakers: breakers.map((b) => formatBreaker(b, now)),
  };
}

function optionalNonNegative(value, field) {
  if (value === undefined || value === null) return { value: null };
  const n = Number(value);
  if (value === "" || typeof value === "boolean" || !Number.isFinite(n) || n < 0) {
    return { error: `${field} must be a non-negative number` };
  }
  return { value: n };
}

function parseTime(value, field) {
  if (value === undefined) return { value: null };
  const t = new Date(value);
  if (typeof value !== "string" || Number.isNaN(t.getTime())) {
    return { error: `${field} must be an ISO 8601 timestamp, e.g. 2026-11-01T12:00:00Z` };
  }
  return { value: t };
}

// Resolves ?from=&to= into a window. Defaults to the last 24 h; at most MAX_HISTORY_DAYS (7).
function parseWindow(query, res) {
  const from = parseTime(query.from, "from");
  const to = parseTime(query.to, "to");
  const bad = from.error || to.error;
  if (bad) {
    sendError(res, 400, "INVALID_QUERY", bad);
    return null;
  }
  const end = to.value || new Date();
  const start = from.value || new Date(end.getTime() - 24 * 3600 * 1000);
  const maxDays = Number(process.env.MAX_HISTORY_DAYS) > 0 ? Number(process.env.MAX_HISTORY_DAYS) : 7;
  if (start >= end) {
    sendError(res, 400, "INVALID_QUERY", "from must be before to");
    return null;
  }
  if (end - start > maxDays * 24 * 3600 * 1000) {
    sendError(res, 400, "INVALID_QUERY", `The time window can be at most ${maxDays} days`);
    return null;
  }
  return { start, end };
}

// ---------------------------------------------------------
// GET /api/controllers — the user's controllers with their breakers and health
// ---------------------------------------------------------
router.get(
  "/",
  asyncHandler("List controllers", async (req, res) => {
    const devices = await pool.query(
      `SELECT device_id, nickname, location, last_seen, created_at FROM devices WHERE user_id = $1 ORDER BY created_at, device_id`,
      [req.userId]
    );
    const breakers = await pool.query(
      `SELECT b.* FROM breakers b JOIN devices d ON d.device_id = b.controller_id
       WHERE d.user_id = $1 ORDER BY b.controller_id, b.channel_number`,
      [req.userId]
    );
    const now = Date.now();
    res.json({
      server_time: new Date(now).toISOString(),
      controllers: devices.rows.map((d) =>
        formatController(d, breakers.rows.filter((b) => b.controller_id === d.device_id), now)
      ),
    });
  })
);

// GET /api/controllers/:controller_id
router.get(
  "/:controller_id",
  asyncHandler("Get controller", async (req, res) => {
    const device = await pool.query(
      `SELECT device_id, nickname, location, last_seen, created_at FROM devices WHERE device_id = $1 AND user_id = $2`,
      [req.params.controller_id, req.userId]
    );
    if (device.rows.length === 0) return sendError(res, 404, "CONTROLLER_NOT_FOUND", "Controller not found");
    const breakers = await pool.query(`SELECT * FROM breakers WHERE controller_id = $1 ORDER BY channel_number`, [
      req.params.controller_id,
    ]);
    const now = Date.now();
    res.json({ server_time: new Date(now).toISOString(), ...formatController(device.rows[0], breakers.rows, now) });
  })
);

// ---------------------------------------------------------
// POST /api/controllers/:controller_id/breakers — register another channel
// ---------------------------------------------------------
router.post(
  "/:controller_id/breakers",
  asyncHandler("Create breaker", async (req, res) => {
    const { breaker_id, channel_number, name, capacity_amps } = req.body || {};

    if (typeof breaker_id !== "string" || !ID_PATTERN.test(breaker_id.trim())) {
      return sendError(res, 400, "VALIDATION_FAILED", "breaker_id must be 1-64 characters of letters, digits, '.', '_' or '-'", { field: "breaker_id" });
    }
    const channel = Number(channel_number);
    if (!Number.isInteger(channel) || channel < 1 || channel > MAX_CHANNELS()) {
      return sendError(res, 400, "VALIDATION_FAILED", `channel_number must be an integer from 1 to ${MAX_CHANNELS()}`, { field: "channel_number" });
    }
    if (name !== undefined && name !== null && (typeof name !== "string" || name.length > 100)) {
      return sendError(res, 400, "VALIDATION_FAILED", "name must be a string of at most 100 characters", { field: "name" });
    }

    const numbers = {};
    for (const field of ["capacity_amps", "voltage_threshold", "current_threshold", "power_threshold", "temperature_threshold"]) {
      const parsed = optionalNonNegative(req.body?.[field], field);
      if (parsed.error) return sendError(res, 400, "VALIDATION_FAILED", parsed.error, { field });
      numbers[field] = parsed.value;
    }
    if (numbers.capacity_amps === 0) {
      return sendError(res, 400, "VALIDATION_FAILED", "capacity_amps must be a positive number", { field: "capacity_amps" });
    }

    const owned = await pool.query(`SELECT device_id FROM devices WHERE device_id = $1 AND user_id = $2`, [
      req.params.controller_id,
      req.userId,
    ]);
    if (owned.rows.length === 0) return sendError(res, 404, "CONTROLLER_NOT_FOUND", "Controller not found");

    try {
      const result = await pool.query(
        `INSERT INTO breakers (controller_id, breaker_id, channel_number, name, capacity_amps,
                               voltage_threshold, current_threshold, power_threshold, temperature_threshold)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          req.params.controller_id,
          breaker_id.trim(),
          channel,
          name || null,
          numbers.capacity_amps,
          numbers.voltage_threshold ?? 264,
          numbers.current_threshold ?? numbers.capacity_amps,
          numbers.power_threshold,
          numbers.temperature_threshold ?? 60,
        ]
      );
      res.status(201).json(formatBreaker(result.rows[0]));
    } catch (err) {
      if (err.code === "23505") {
        return sendError(res, 409, "BREAKER_EXISTS", "That breaker_id or channel_number is already used on this controller");
      }
      throw err;
    }
  })
);

// GET /api/controllers/:controller_id/breakers/:breaker_id — latest reading + health
router.get(
  "/:controller_id/breakers/:breaker_id",
  asyncHandler("Get breaker", async (req, res) => {
    const breaker = await loadOwnedBreaker(pool, req.userId, req.params.controller_id, req.params.breaker_id);
    if (!breaker) return breakerNotFound(res);

    await expireStaleCommands(pool, { breakerPk: breaker.id });
    const active = await pool.query(
      `${COMMAND_SELECT} WHERE c.breaker_pk = $1 AND c.status IN ('pending', 'delivered') LIMIT 1`,
      [breaker.id]
    );
    const now = Date.now();
    res.json({
      server_time: new Date(now).toISOString(),
      ...formatBreaker(breaker, now),
      active_command: active.rows[0] ? formatCommand(active.rows[0]) : null,
    });
  })
);

// ---------------------------------------------------------
// GET /api/controllers/:controller_id/breakers/:breaker_id/readings
//   ?from=ISO&to=ISO              window (default last 24 h, max 7 days)
//   &limit=500&cursor=...         raw rows, newest first, paginated
//   &bucket_seconds=60            OR averaged buckets, oldest first (no pagination)
// ---------------------------------------------------------
router.get(
  "/:controller_id/breakers/:breaker_id/readings",
  asyncHandler("Breaker history", async (req, res) => {
    const breaker = await loadOwnedBreaker(pool, req.userId, req.params.controller_id, req.params.breaker_id);
    if (!breaker) return breakerNotFound(res);
    const window = parseWindow(req.query, res);
    if (!window) return;

    if (req.query.bucket_seconds !== undefined) {
      const bucket = Number(req.query.bucket_seconds);
      if (!Number.isInteger(bucket) || bucket < 3 || bucket > 86400) {
        return sendError(res, 400, "INVALID_QUERY", "bucket_seconds must be an integer from 3 to 86400");
      }
      if ((window.end - window.start) / 1000 / bucket > 5000) {
        return sendError(res, 400, "INVALID_QUERY", "Too many buckets; use a larger bucket_seconds or a shorter window");
      }
      const result = await pool.query(
        `SELECT to_timestamp(floor(extract(epoch FROM created_at) / $2::float8) * $2::float8) AS t,
                COUNT(*)::int AS samples,
                AVG(voltage)::float8 AS voltage,
                AVG(current)::float8 AS current,
                AVG(power)::float8 AS power,
                AVG(apparent_power)::float8 AS apparent_power,
                MAX(energy_kwh)::float8 AS energy_kwh,
                AVG(frequency)::float8 AS frequency,
                AVG(power_factor)::float8 AS power_factor,
                AVG(temperature)::float8 AS temperature
         FROM readings_log
         WHERE breaker_pk = $1 AND created_at >= $3 AND created_at < $4
         GROUP BY 1 ORDER BY 1`,
        [breaker.id, bucket, window.start, window.end]
      );
      return res.json({
        controller_id: breaker.controller_id,
        breaker_id: breaker.breaker_id,
        from: window.start.toISOString(),
        to: window.end.toISOString(),
        bucket_seconds: bucket,
        buckets: result.rows.map(({ t, ...rest }) => ({ t: iso(t), ...rest })),
      });
    }

    const limit = req.query.limit === undefined ? 500 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
      return sendError(res, 400, "INVALID_QUERY", "limit must be an integer from 1 to 2000");
    }

    // Cursor = "<created_at ISO>|<id>" of the last row of the previous page, base64url encoded.
    let cursorTime = null;
    let cursorId = null;
    if (req.query.cursor !== undefined) {
      const decoded = Buffer.from(String(req.query.cursor), "base64url").toString("utf8");
      const [t, id] = decoded.split("|");
      cursorTime = new Date(t);
      cursorId = Number(id);
      if (Number.isNaN(cursorTime.getTime()) || !Number.isInteger(cursorId)) {
        return sendError(res, 400, "INVALID_QUERY", "Invalid cursor");
      }
    }

    const params = [breaker.id, window.start, window.end, limit + 1];
    let cursorFilter = "";
    if (cursorTime) {
      params.push(cursorTime, cursorId);
      cursorFilter = "AND (created_at, id) < ($5, $6)";
    }
    const result = await pool.query(
      `SELECT id, created_at, voltage, current, power, apparent_power, energy_kwh, frequency, power_factor, temperature
       FROM readings_log
       WHERE breaker_pk = $1 AND created_at >= $2 AND created_at < $3 ${cursorFilter}
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
      params
    );

    const rows = result.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    const nextCursor =
      result.rows.length > limit
        ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`, "utf8").toString("base64url")
        : null;

    res.json({
      controller_id: breaker.controller_id,
      breaker_id: breaker.breaker_id,
      from: window.start.toISOString(),
      to: window.end.toISOString(),
      readings: rows.map(({ id, created_at, ...rest }) => ({ measured_at: iso(created_at), ...rest })),
      next_cursor: nextCursor,
    });
  })
);

// ---------------------------------------------------------
// GET /api/controllers/:controller_id/breakers/:breaker_id/energy?from=&to=
// Energy used in a window from the PZEM's cumulative kWh counter. A drop in the counter is
// treated as a meter reset (power loss / PZEM reset): consumption after the reset is counted
// from zero instead of producing a negative total.
// ---------------------------------------------------------
router.get(
  "/:controller_id/breakers/:breaker_id/energy",
  asyncHandler("Breaker energy", async (req, res) => {
    const breaker = await loadOwnedBreaker(pool, req.userId, req.params.controller_id, req.params.breaker_id);
    if (!breaker) return breakerNotFound(res);
    const window = parseWindow(req.query, res);
    if (!window) return;

    const result = await pool.query(
      `SELECT COUNT(*)::int AS samples,
              COALESCE(SUM(CASE WHEN prev IS NULL THEN 0
                                WHEN energy_kwh >= prev THEN energy_kwh - prev
                                ELSE energy_kwh END), 0)::float8 AS energy_used_kwh,
              (COUNT(*) FILTER (WHERE prev IS NOT NULL AND energy_kwh < prev))::int AS resets_detected,
              MIN(created_at) AS first_sample_at,
              MAX(created_at) AS last_sample_at
       FROM (
         SELECT energy_kwh, created_at,
                LAG(energy_kwh) OVER (ORDER BY created_at, id) AS prev
         FROM readings_log
         WHERE breaker_pk = $1 AND created_at >= $2 AND created_at < $3 AND energy_kwh IS NOT NULL
       ) s`,
      [breaker.id, window.start, window.end]
    );
    const row = result.rows[0];
    res.json({
      controller_id: breaker.controller_id,
      breaker_id: breaker.breaker_id,
      from: window.start.toISOString(),
      to: window.end.toISOString(),
      energy_used_kwh: Math.round(row.energy_used_kwh * 1e6) / 1e6,
      resets_detected: row.resets_detected,
      samples: row.samples,
      first_sample_at: iso(row.first_sample_at),
      last_sample_at: iso(row.last_sample_at),
    });
  })
);

// ---------------------------------------------------------
// POST /api/controllers/:controller_id/breakers/:breaker_id/commands
// Body: { "requested_state": "ON" | "OFF" }   Optional header: Idempotency-Key
// ---------------------------------------------------------
router.post(
  "/:controller_id/breakers/:breaker_id/commands",
  commandLimiter,
  asyncHandler("Create command", async (req, res) => {
    const requested = typeof req.body?.requested_state === "string" ? req.body.requested_state.toUpperCase() : null;
    if (requested !== "ON" && requested !== "OFF") {
      return sendError(res, 400, "VALIDATION_FAILED", "requested_state must be ON or OFF", { field: "requested_state" });
    }
    const idempotencyKey = req.get("Idempotency-Key") ?? null;
    if (idempotencyKey !== null && (idempotencyKey.length < 8 || idempotencyKey.length > 100)) {
      return sendError(res, 400, "VALIDATION_FAILED", "Idempotency-Key must be 8-100 characters");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const breaker = await loadOwnedBreaker(client, req.userId, req.params.controller_id, req.params.breaker_id, { lock: true });
      if (!breaker) {
        await client.query("ROLLBACK");
        return breakerNotFound(res);
      }

      // Retried request with the same Idempotency-Key -> return the original command.
      if (idempotencyKey) {
        const existing = await client.query(`${COMMAND_SELECT} WHERE c.requested_by = $1 AND c.idempotency_key = $2`, [
          req.userId,
          idempotencyKey,
        ]);
        if (existing.rows[0]) {
          await client.query("COMMIT");
          const cmd = existing.rows[0];
          if (cmd.breaker_pk !== breaker.id || cmd.requested_state !== requested) {
            return sendError(res, 409, "IDEMPOTENCY_KEY_REUSED", "That Idempotency-Key was already used for a different command");
          }
          return res.status(200).json(formatCommand(cmd));
        }
      }

      await expireStaleCommands(client, { breakerPk: breaker.id });

      const active = await client.query(
        `${COMMAND_SELECT} WHERE c.breaker_pk = $1 AND c.status IN ('pending', 'delivered') LIMIT 1`,
        [breaker.id]
      );
      if (active.rows[0]) {
        await client.query("ROLLBACK");
        return sendError(res, 409, "COMMAND_IN_PROGRESS", "This breaker already has a command in progress", {
          command: formatCommand(active.rows[0]),
        });
      }

      const controller = await client.query(`SELECT last_seen FROM devices WHERE device_id = $1`, [breaker.controller_id]);
      if (connectionStatus(controller.rows[0].last_seen) !== "online") {
        await client.query("ROLLBACK");
        return sendError(res, 409, "CONTROLLER_OFFLINE", "The controller is not online, so the command could not be delivered");
      }

      // Never re-energize a faulted circuit from the cloud. Turning OFF is always allowed.
      if (requested === "ON" && (breaker.contactor_state === "TRIPPED" || breaker.sensor_status === "error")) {
        await client.query("ROLLBACK");
        return sendError(
          res,
          409,
          "BREAKER_FAULTED",
          breaker.contactor_state === "TRIPPED"
            ? "The breaker reported a trip; it must be reset locally before it can be switched ON remotely"
            : "The breaker's sensor is reporting an error; it cannot be switched ON remotely until it reports normally"
        );
      }

      const commandId = crypto.randomUUID();
      await client.query(
        `INSERT INTO commands (command_id, breaker_pk, controller_id, requested_state, requested_by, idempotency_key, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(secs => $7::int))`,
        [commandId, breaker.id, breaker.controller_id, requested, req.userId, idempotencyKey, commandTtlSeconds()]
      );
      const created = await client.query(`${COMMAND_SELECT} WHERE c.command_id = $1`, [commandId]);
      await client.query("COMMIT");
      res.status(201).json(formatCommand(created.rows[0]));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err.code === "23505") {
        return sendError(res, 409, "COMMAND_IN_PROGRESS", "This breaker already has a command in progress");
      }
      throw err;
    } finally {
      client.release();
    }
  })
);

// GET /api/controllers/:controller_id/breakers/:breaker_id/commands?limit=20 — recent commands
router.get(
  "/:controller_id/breakers/:breaker_id/commands",
  asyncHandler("List commands", async (req, res) => {
    const breaker = await loadOwnedBreaker(pool, req.userId, req.params.controller_id, req.params.breaker_id);
    if (!breaker) return breakerNotFound(res);
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return sendError(res, 400, "INVALID_QUERY", "limit must be an integer from 1 to 100");
    }
    await expireStaleCommands(pool, { breakerPk: breaker.id });
    const result = await pool.query(`${COMMAND_SELECT} WHERE c.breaker_pk = $1 ORDER BY c.created_at DESC LIMIT $2`, [
      breaker.id,
      limit,
    ]);
    res.json({ commands: result.rows.map(formatCommand) });
  })
);

module.exports = router;