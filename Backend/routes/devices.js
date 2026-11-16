// /api/devices — legacy device (= controller + its channel-1 breaker) management.
// Kept response shapes so the current frontend keeps working. New code should prefer
// /api/controllers and /api/breakers (docs/API_CONTRACT.md).

const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { generateDeviceKey, hashDeviceKey } = require("../security/deviceKeys");
const { createCommand, CommandError } = require("../services/commands");
const { BREAKER_ID_RE } = require("../services/breakers");

const DEFAULT_VOLTAGE_THRESHOLD = 264;
const DEFAULT_TEMPERATURE_THRESHOLD = 60;

// Columns returned to the frontend. Never include api_key_hash.
const DEVICE_COLUMNS = `
  device_id, nickname, location, capacity_amps, status,
  voltage_threshold, current_threshold, power_threshold, temperature_threshold, created_at
`;

function parseOptionalNumber(raw, { positive = false } = {}) {
  if (raw === undefined) return { skip: true };
  if (raw === null || raw === "") return { value: null };
  const n = Number(raw);
  if (typeof raw === "boolean" || !Number.isFinite(n) || n < 0 || (positive && n === 0)) return { error: true };
  return { value: n };
}

function createDeviceRouter() {
  const router = express.Router();
  router.use(requireAuth);

  const commandLimiter = rateLimit({ name: "command", windowMs: 60_000, max: 20, key: (req) => req.userId, legacy: true });
  const keyLimiter = rateLimit({ name: "key", windowMs: 15 * 60_000, max: 10, key: (req) => req.userId, legacy: true });

  // GET /api/devices — the logged-in user's registered devices
  router.get("/", async (req, res) => {
    try {
      const result = await pool.query(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE user_id = $1 ORDER BY created_at`, [req.userId]);
      return res.json(result.rows);
    } catch (error) {
      console.error("Fetch devices error:", error.message);
      return res.status(500).json({ error: "Could not load devices" });
    }
  });

  // POST /api/devices/:device_id/command { status: "ON"|"OFF" }
  // Queues a command for the channel-1 breaker (same lifecycle as POST /api/breakers/:id/commands).
  router.post("/:device_id/command", commandLimiter, async (req, res) => {
    const requestedStatus = req.body?.status;
    if (!["ON", "OFF"].includes(requestedStatus)) {
      return res.status(400).json({ error: "status must be ON or OFF" });
    }
    try {
      const dev = await pool.query(`SELECT device_id, status FROM devices WHERE device_id = $1 AND user_id = $2`, [req.params.device_id, req.userId]);
      if (!dev.rows[0]) return res.status(404).json({ error: "Device not found" });

      if (dev.rows[0].status === requestedStatus) {
        // Already in that (reported) state: clear any pending request, as before.
        await pool.query(`UPDATE commands SET status = 'SUPERSEDED' WHERE breaker_id = $1 AND controller_id = $1 AND status IN ('QUEUED', 'DELIVERED')`, [req.params.device_id]);
        const r = await pool.query(
          `UPDATE devices SET requested_status = NULL, command_expires_at = NULL WHERE device_id = $1
           RETURNING device_id, status, requested_status, command_expires_at`,
          [req.params.device_id]
        );
        return res.json(r.rows[0]);
      }

      const { command } = await createCommand(pool, { userId: req.userId, breakerId: req.params.device_id, action: requestedStatus });
      return res.json({
        device_id: req.params.device_id,
        status: dev.rows[0].status,
        requested_status: command.action,
        command_expires_at: command.expires_at,
        command_id: command.command_id,
      });
    } catch (error) {
      if (error instanceof CommandError) {
        if (error.code === "BREAKER_NOT_FOUND") return res.status(404).json({ error: "Device not found" });
        if (error.code === "BREAKER_TRIPPED") return res.status(409).json({ error: "A tripped breaker cannot be turned on", code: error.code });
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error("Queue breaker command error:", error.message);
      return res.status(500).json({ error: "Could not send breaker command" });
    }
  });

  // POST /api/devices — register a device (controller) + its channel-1 breaker, issue its API key.
  router.post("/", keyLimiter, async (req, res) => {
    const { device_id, nickname, location, capacity_amps, voltage_threshold, current_threshold, power_threshold, temperature_threshold } = req.body || {};

    if (typeof device_id !== "string" || !device_id.trim()) {
      return res.status(400).json({ error: "device_id is required" });
    }
    const deviceId = device_id.trim();
    if (!BREAKER_ID_RE.test(deviceId)) {
      return res.status(400).json({ error: "device_id may only use letters, numbers, . _ : - (max 64)" });
    }
    // NOTE: a "status" field from the browser is ignored on purpose. Contactor state is only ever
    // set from what the device reports, never from a browser payload.

    const capacity = parseOptionalNumber(capacity_amps, { positive: true });
    if (capacity.error) return res.status(400).json({ error: "capacity_amps must be a positive number" });
    const cap = capacity.skip ? null : capacity.value;

    const t = {};
    for (const [name, raw] of Object.entries({ voltage_threshold, current_threshold, power_threshold, temperature_threshold })) {
      const p = parseOptionalNumber(raw);
      if (p.error) return res.status(400).json({ error: "Thresholds must be non-negative numbers" });
      t[name] = p.skip ? undefined : p.value;
    }
    const thresholds = {
      voltage_threshold: t.voltage_threshold === undefined ? DEFAULT_VOLTAGE_THRESHOLD : t.voltage_threshold,
      current_threshold: t.current_threshold === undefined ? cap : t.current_threshold,
      power_threshold: t.power_threshold === undefined ? null : t.power_threshold,
      temperature_threshold: t.temperature_threshold === undefined ? DEFAULT_TEMPERATURE_THRESHOLD : t.temperature_threshold,
    };

    const apiKey = generateDeviceKey();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const taken = await client.query(
        `SELECT 1 FROM devices WHERE device_id = $1 UNION ALL SELECT 1 FROM breakers WHERE breaker_id = $1`,
        [deviceId]
      );
      if (taken.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "That device_id is already registered" });
      }
      const result = await client.query(
        `INSERT INTO devices (device_id, user_id, nickname, location, capacity_amps, status,
                              voltage_threshold, current_threshold, power_threshold, temperature_threshold,
                              api_key_hash, key_rotated_at)
         VALUES ($1, $2, $3, $4, $5, 'OFF', $6, $7, $8, $9, $10, NOW())
         RETURNING ${DEVICE_COLUMNS}`,
        [deviceId, req.userId, nickname || null, location || null, cap, thresholds.voltage_threshold,
          thresholds.current_threshold, thresholds.power_threshold, thresholds.temperature_threshold, hashDeviceKey(apiKey)]
      );
      await client.query(
        `INSERT INTO breakers (breaker_id, controller_id, channel_number, user_id, name, location, rated_current_a,
                               voltage_threshold, current_threshold, power_threshold, temperature_threshold)
         VALUES ($1, $1, 1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [deviceId, req.userId, nickname || null, location || null, cap, thresholds.voltage_threshold,
          thresholds.current_threshold, thresholds.power_threshold, thresholds.temperature_threshold]
      );
      await client.query("COMMIT");

      // The plaintext key is returned exactly once; only its hash is stored.
      res.set("Cache-Control", "no-store");
      return res.status(201).json({ ...result.rows[0], api_key: apiKey });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error.code === "23505") return res.status(409).json({ error: "That device_id is already registered" });
      console.error("Register device error:", error.message);
      return res.status(500).json({ error: "Could not register device" });
    } finally {
      client.release();
    }
  });

  // PATCH /api/devices/:device_id — edit name/location/capacity/thresholds (mirrored to channel-1 breaker)
  router.patch("/:device_id", async (req, res) => {
    const body = req.body || {};
    const sets = [];
    const breakerSets = [];
    const params = [];
    const add = (devCol, brkCol, value) => {
      params.push(value);
      sets.push(`${devCol} = $${params.length}`);
      breakerSets.push(`${brkCol} = $${params.length}`);
    };

    for (const [field, col] of [["nickname", "name"], ["location", "location"]]) {
      if (body[field] === undefined) continue;
      if (body[field] !== null && (typeof body[field] !== "string" || body[field].length > 100)) {
        return res.status(400).json({ error: `${field} must be a string of at most 100 characters` });
      }
      add(field, col, body[field] || null);
    }
    const cap = parseOptionalNumber(body.capacity_amps, { positive: true });
    if (cap.error) return res.status(400).json({ error: "capacity_amps must be a positive number" });
    if (!cap.skip) add("capacity_amps", "rated_current_a", cap.value);
    for (const name of ["voltage_threshold", "current_threshold", "power_threshold", "temperature_threshold"]) {
      const p = parseOptionalNumber(body[name]);
      if (p.error) return res.status(400).json({ error: "Thresholds must be non-negative numbers" });
      if (!p.skip) add(name, name, p.value);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

    try {
      params.push(req.params.device_id, req.userId);
      const n = params.length;
      const r = await pool.query(
        `UPDATE devices SET ${sets.join(", ")} WHERE device_id = $${n - 1} AND user_id = $${n} RETURNING ${DEVICE_COLUMNS}`,
        params
      );
      if (!r.rows[0]) return res.status(404).json({ error: "Device not found" });
      await pool.query(
        `UPDATE breakers SET ${breakerSets.join(", ")}, updated_at = NOW()
         WHERE breaker_id = $${n - 1} AND controller_id = $${n - 1} AND channel_number = 1 AND user_id = $${n}`,
        params
      );
      return res.json(r.rows[0]);
    } catch (error) {
      console.error("Update device error:", error.message);
      return res.status(500).json({ error: "Could not update device" });
    }
  });

  // DELETE /api/devices/:device_id — removes the controller, ALL its breakers, their readings,
  // alerts and commands (database cascade). Labeled ML recordings are kept.
  // The ESP32's key stops working immediately.
  router.delete("/:device_id", async (req, res) => {
    try {
      const breakers = await pool.query(
        `SELECT breaker_id FROM breakers WHERE controller_id = $1 AND user_id = $2 ORDER BY channel_number`,
        [req.params.device_id, req.userId]
      );
      const r = await pool.query(`DELETE FROM devices WHERE device_id = $1 AND user_id = $2 RETURNING device_id`, [req.params.device_id, req.userId]);
      if (!r.rows[0]) return res.status(404).json({ error: "Device not found" });
      return res.json({ deleted: true, device_id: r.rows[0].device_id, breakers_removed: breakers.rows.map((b) => b.breaker_id) });
    } catch (error) {
      console.error("Delete device error:", error.message);
      return res.status(500).json({ error: "Could not delete device" });
    }
  });

  // POST /api/devices/:device_id/rotate-key — new key, old key invalid immediately
  router.post("/:device_id/rotate-key", keyLimiter, async (req, res) => {
    try {
      const apiKey = generateDeviceKey();
      const result = await pool.query(
        `UPDATE devices SET api_key_hash = $1, key_rotated_at = NOW(), key_revoked_at = NULL
         WHERE device_id = $2 AND user_id = $3 RETURNING device_id`,
        [hashDeviceKey(apiKey), req.params.device_id, req.userId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: "Device not found" });
      res.set("Cache-Control", "no-store");
      return res.status(200).json({ device_id: result.rows[0].device_id, api_key: apiKey, message: "API key rotated successfully. Save this key now." });
    } catch (error) {
      console.error("Device key rotation error:", error.message);
      return res.status(500).json({ error: "Could not rotate device key" });
    }
  });

  // POST /api/devices/:device_id/revoke-key — disable the key without issuing a new one
  router.post("/:device_id/revoke-key", keyLimiter, async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE devices SET api_key_hash = NULL, key_revoked_at = NOW() WHERE device_id = $1 AND user_id = $2 RETURNING device_id, key_revoked_at`,
        [req.params.device_id, req.userId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: "Device not found" });
      return res.json({ device_id: result.rows[0].device_id, revoked: true, key_revoked_at: result.rows[0].key_revoked_at });
    } catch (error) {
      console.error("Device key revoke error:", error.message);
      return res.status(500).json({ error: "Could not revoke device key" });
    }
  });

  return router;
}

module.exports = { createDeviceRouter };
