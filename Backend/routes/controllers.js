// /api/controllers — the user's ESP32 controllers with their breakers (channels). JWT, owner-scoped.
// A controller is registered with POST /api/devices (which also creates its channel-1 breaker);
// extra channels are added here.

const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { apiError } = require("../middleware/errors");
const { BREAKER_ID_RE, BREAKER_SELECT, serializeBreaker, latestFromRow, controllerHealth, iso } = require("../services/breakers");

function serializeController(d, breakers) {
  return {
    controller_id: d.device_id,
    name: d.nickname,
    location: d.location,
    firmware_version: d.firmware_version,
    ...controllerHealth(d),
    api_key_status: d.api_key_hash ? "active" : d.key_revoked_at ? "revoked" : "none",
    key_rotated_at: iso(d.key_rotated_at),
    channel_count: breakers.length,
    breakers,
    created_at: iso(d.created_at),
  };
}

async function load(userId, controllerId) {
  const params = [userId];
  let filter = "";
  if (controllerId) {
    params.push(controllerId);
    filter = "AND device_id = $2";
  }
  const devices = await pool.query(
    `SELECT device_id, nickname, location, firmware_version, last_seen_at, api_key_hash, key_revoked_at, key_rotated_at, created_at
     FROM devices WHERE user_id = $1 ${filter} ORDER BY created_at`,
    params
  );
  const breakers = await pool.query(
    `${BREAKER_SELECT} WHERE b.user_id = $1 ${controllerId ? "AND b.controller_id = $2" : ""} ORDER BY b.controller_id, b.channel_number`,
    params
  );
  const byCtrl = new Map();
  for (const row of breakers.rows) {
    if (!byCtrl.has(row.controller_id)) byCtrl.set(row.controller_id, []);
    byCtrl.get(row.controller_id).push(serializeBreaker(row, { latest: latestFromRow(row) }));
  }
  return devices.rows.map((d) => serializeController(d, byCtrl.get(d.device_id) || []));
}

function createControllerRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
    try {
      return res.json({ controllers: await load(req.userId) });
    } catch (err) {
      console.error("List controllers error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not load controllers");
    }
  });

  router.get("/:controller_id", async (req, res) => {
    try {
      const [c] = await load(req.userId, req.params.controller_id);
      if (!c) return apiError(res, 404, "CONTROLLER_NOT_FOUND", "Controller not found");
      return res.json(c);
    } catch (err) {
      console.error("Get controller error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not load controller");
    }
  });

  // POST /api/controllers/:controller_id/breakers
  // { breaker_id, channel_number (2-8), name?, location?, rated_current_a?, thresholds? }
  router.post("/:controller_id/breakers", async (req, res) => {
    const b = req.body || {};
    if (typeof b.breaker_id !== "string" || !BREAKER_ID_RE.test(b.breaker_id)) {
      return apiError(res, 400, "VALIDATION_ERROR", "breaker_id must be 1-64 characters: letters, numbers, . _ : -", { field: "breaker_id" });
    }
    if (!Number.isInteger(b.channel_number) || b.channel_number < 1 || b.channel_number > 8) {
      return apiError(res, 400, "VALIDATION_ERROR", "channel_number must be an integer 1-8", { field: "channel_number" });
    }
    for (const f of ["name", "location"]) {
      if (b[f] !== undefined && b[f] !== null && (typeof b[f] !== "string" || b[f].length > 100)) {
        return apiError(res, 400, "VALIDATION_ERROR", `${f} must be a string of at most 100 characters`, { field: f });
      }
    }
    const nums = {};
    for (const f of ["rated_current_a", "voltage_threshold", "current_threshold", "power_threshold", "temperature_threshold"]) {
      const raw = f === "rated_current_a" ? b.rated_current_a : b.thresholds?.[f];
      if (raw === undefined || raw === null) {
        nums[f] = null;
        continue;
      }
      const n = Number(raw);
      if (typeof raw === "boolean" || !Number.isFinite(n) || n < 0) {
        return apiError(res, 400, "VALIDATION_ERROR", `${f} must be a non-negative number`, { field: f });
      }
      nums[f] = n;
    }

    try {
      const owned = await pool.query(`SELECT device_id FROM devices WHERE device_id = $1 AND user_id = $2`, [req.params.controller_id, req.userId]);
      if (!owned.rows[0]) return apiError(res, 404, "CONTROLLER_NOT_FOUND", "Controller not found");

      const clash = await pool.query(
        `SELECT 'breaker' AS kind FROM breakers WHERE breaker_id = $1
         UNION ALL SELECT 'device' FROM devices WHERE device_id = $1`,
        [b.breaker_id]
      );
      if (clash.rows.length) return apiError(res, 409, "BREAKER_ID_TAKEN", "That breaker_id is already in use");
      const channel = await pool.query(`SELECT breaker_id FROM breakers WHERE controller_id = $1 AND channel_number = $2`, [req.params.controller_id, b.channel_number]);
      if (channel.rows.length) {
        return apiError(res, 409, "CHANNEL_IN_USE", `Channel ${b.channel_number} is already assigned`, { breaker_id: channel.rows[0].breaker_id });
      }

      await pool.query(
        `INSERT INTO breakers (breaker_id, controller_id, channel_number, user_id, name, location, rated_current_a,
                               voltage_threshold, current_threshold, power_threshold, temperature_threshold)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [b.breaker_id, req.params.controller_id, b.channel_number, req.userId, b.name || null, b.location || null,
          nums.rated_current_a, nums.voltage_threshold, nums.current_threshold ?? nums.rated_current_a, nums.power_threshold, nums.temperature_threshold]
      );
      const row = await pool.query(`${BREAKER_SELECT} WHERE b.breaker_id = $1`, [b.breaker_id]);
      return res.status(201).json(serializeBreaker(row.rows[0], { latest: null }));
    } catch (err) {
      if (err.code === "23505") return apiError(res, 409, "CHANNEL_IN_USE", "Breaker id or channel already in use");
      console.error("Create breaker error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not create breaker");
    }
  });

  return router;
}

module.exports = { createControllerRouter };
