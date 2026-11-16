const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { requireDeviceAuth } = require("../middleware/deviceAuth");
const { parseReading } = require("../validation/readings");
const { recordReport } = require("../services/ingest");

const router = express.Router();

// POST /readings/command — legacy firmware polls for a pending ON/OFF request on channel 1.
// (New firmware should use POST /api/device/v1/commands/poll, which returns command IDs.)
router.post("/command", requireDeviceAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT CASE WHEN command_expires_at > NOW() THEN requested_status ELSE NULL END AS requested_status,
              CASE WHEN command_expires_at > NOW() THEN command_expires_at ELSE NULL END AS command_expires_at
       FROM devices WHERE device_id = $1`,
      [req.deviceId]
    );
    await pool.query(
      `UPDATE commands SET status = 'DELIVERED', delivered_at = COALESCE(delivered_at, NOW()), delivery_count = delivery_count + 1
       WHERE breaker_id = $1 AND controller_id = $1 AND status IN ('QUEUED', 'DELIVERED') AND expires_at > NOW()`,
      [req.deviceId]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error("Fetch breaker command error:", error.message);
    return res.status(500).json({ error: "Could not fetch breaker command" });
  }
});

// POST /readings — ESP32 telemetry (legacy path, still supported).
//
// Body (all measurements optional, at least one measurement or a status is required):
//   { "device_id": "esp32-1",            // or "controller_id"
//     "breaker_id": "esp32-1-ch2",       // optional; default = the controller's channel-1 breaker
//     "voltage": 120.4, "current": 0.509, "power": 61.3, "apparent_power": 61.28,
//     "energy_kwh": 0.004, "frequency": 60.0, "power_factor": 1.0, "temperature": null,
//     "status": "ON",                    // or "contactor_state" (reported GPIO state, ON|OFF)
//     "sensor_status": "online" }        // "error"/"offline" reports must not carry numbers
//
// The X-API-Key must belong to device_id, and breaker_id must be a channel OF that controller.
router.post("/", requireDeviceAuth, async (req, res) => {
  const parsed = parseReading(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error, ...(parsed.field && { field: parsed.field }) });
  }

  try {
    const breakerResult = parsed.breakerId
      ? await pool.query(`SELECT * FROM breakers WHERE breaker_id = $1`, [parsed.breakerId])
      : await pool.query(`SELECT * FROM breakers WHERE controller_id = $1 AND channel_number = 1`, [req.deviceId]);
    const breaker = breakerResult.rows[0];

    if (!breaker) {
      if (parsed.breakerId) return res.status(404).json({ error: "Unknown breaker_id", code: "BREAKER_NOT_FOUND" });
      return res.status(404).json({ error: "This device has no channel-1 breaker registered", code: "CHANNEL_NOT_ASSIGNED" });
    }
    if (breaker.controller_id !== req.deviceId) {
      // Authenticated controller tried to write another controller's breaker.
      return res.status(403).json({ error: "breaker_id does not belong to this device", code: "BREAKER_NOT_ON_CONTROLLER" });
    }

    const out = await recordReport(pool, {
      breaker,
      values: parsed.values,
      contactorState: parsed.status,
      sensorStatus: parsed.sensorStatus,
      source: "legacy",
    });

    if (!out.stored) {
      return res.status(200).json({
        device_id: req.deviceId,
        breaker_id: breaker.breaker_id,
        status: parsed.status,
        sensor_status: out.sensor_status,
        stored: false,
      });
    }
    // Same shape as before (the `readings` row) for channel 1, plus breaker_id.
    const row = out.legacyRow || { device_id: req.deviceId, ...parsed.values, updated_at: out.measured_at };
    return res.status(200).json({ ...row, breaker_id: breaker.breaker_id, stored: true, latest_updated: out.latest_updated });
  } catch (err) {
    console.error("Insert reading error:", err.message);
    return res.status(500).json({ error: "Could not save reading" });
  }
});

// GET /readings — the logged-in user's devices' latest (channel-1) readings
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, d.nickname FROM readings r
       JOIN devices d ON d.device_id = r.device_id
       WHERE d.user_id = $1
       ORDER BY r.device_id`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Fetch readings error:", err.message);
    res.status(500).json({ error: "Could not load readings" });
  }
});

// GET /readings/:device_id — one device's latest reading, only if it belongs to the logged-in user
router.get("/:device_id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, d.nickname FROM readings r
       JOIN devices d ON d.device_id = r.device_id
       WHERE r.device_id = $1 AND d.user_id = $2`,
      [req.params.device_id, req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No reading found for that device" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fetch reading error:", err.message);
    res.status(500).json({ error: "Could not load reading" });
  }
});

module.exports = router;
