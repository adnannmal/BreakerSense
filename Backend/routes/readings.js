const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { requireDeviceAuth } = require("../middleware/deviceAuth");
const { parseReading } = require("../validation/readings");
const { sendError, asyncHandler } = require("../lib/errors");
const { rateLimit } = require("../lib/rateLimit");
const { formatBreaker } = require("../lib/health");

const router = express.Router();

// Which metrics may raise alerts. Power is stored, but the frontend doesn't display it,
// so its threshold check stays parked.
const METRICS = [
  { key: "current",     label: "Current",     unit: "A",  thresholdCol: "current_threshold" },
  { key: "voltage",     label: "Voltage",     unit: "V",  thresholdCol: "voltage_threshold" },
  { key: "temperature", label: "Temperature", unit: "°C", thresholdCol: "temperature_threshold" },
];

// Unauthenticated floods are limited per IP; authenticated controllers per controller.
// An ESP32 with two breakers reporting every 3 s sends 40 requests/minute.
const ipLimiter = rateLimit({ name: "device_ip", windowMs: 60_000, max: 600, key: (req) => req.ip });
const controllerLimiter = rateLimit({ name: "readings", windowMs: 60_000, max: 240, key: (req) => req.controllerId });

// Opens an alert for (breaker, metric) unless one is already open; or resolves it.
async function setAlert(client, breaker, metric, active, alert) {
  if (active) {
    const open = await client.query(
      `SELECT id FROM alerts WHERE breaker_pk = $1 AND metric = $2 AND resolved = FALSE LIMIT 1`,
      [breaker.id, metric]
    );
    if (open.rows.length === 0) {
      await client.query(
        `INSERT INTO alerts (device_id, breaker_pk, metric, title, message, severity) VALUES ($1, $2, $3, $4, $5, $6)`,
        [breaker.controller_id, breaker.id, metric, alert.title, alert.message, alert.severity]
      );
    }
  } else {
    await client.query(
      `UPDATE alerts SET resolved = TRUE WHERE breaker_pk = $1 AND metric = $2 AND resolved = FALSE`,
      [breaker.id, metric]
    );
  }
}

// POST /readings — the ESP32 calls this with its X-API-Key.
//
// Current (still supported) body:
//   { "device_id": "esp32-1", "voltage": 120.4, "current": 0.5, "power": 60.2 }
// PZEM body (see docs/API_CONTRACT.md):
//   { "controller_id": "esp32-1", "breaker_id": "breaker-001", "voltage": 120.4, "current": 0.509,
//     "power": 61.3, "apparent_power": 61.28, "energy_kwh": 0.004, "frequency": 60.0,
//     "power_factor": 1.0, "contactor_state": "ON", "sensor_status": "online" }
// Without breaker_id the reading goes to the controller's channel-1 breaker.
// sensor_status "error"/"offline" reports a sensor failure: no numbers are stored and the
// last good measurement is kept.
router.post(
  "/",
  ipLimiter,
  requireDeviceAuth,
  controllerLimiter,
  asyncHandler("Insert reading", async (req, res) => {
    const controllerId = req.controllerId;

    const parsed = parseReading(req.body);
    if (parsed.error) {
      return sendError(res, 400, parsed.code, parsed.error, parsed.field ? { field: parsed.field } : {});
    }
    const { values, sensorStatus, contactorState, sensorError } = parsed;
    const isGood = sensorStatus === "online";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const breakerResult = parsed.breakerId
        ? await client.query(
            `SELECT * FROM breakers WHERE controller_id = $1 AND breaker_id = $2 FOR UPDATE`,
            [controllerId, parsed.breakerId]
          )
        : await client.query(
            `SELECT * FROM breakers WHERE controller_id = $1 AND channel_number = 1 FOR UPDATE`,
            [controllerId]
          );
      let breaker = breakerResult.rows[0];
      if (!breaker) {
        await client.query("ROLLBACK");
        return sendError(
          res,
          404,
          "BREAKER_NOT_FOUND",
          parsed.breakerId
            ? `Breaker ${parsed.breakerId} is not registered on controller ${controllerId}`
            : `Controller ${controllerId} has no channel-1 breaker`
        );
      }

      // 1) breaker state. Measurements only move forward on a good report.
      const updated = await client.query(
        `UPDATE breakers SET
           last_seen = NOW(),
           sensor_status = $2,
           sensor_error = $3,
           contactor_state = COALESCE($4, contactor_state),
           voltage        = CASE WHEN $5 THEN $6::numeric  ELSE voltage END,
           current        = CASE WHEN $5 THEN $7::numeric  ELSE current END,
           power          = CASE WHEN $5 THEN $8::numeric  ELSE power END,
           apparent_power = CASE WHEN $5 THEN $9::numeric  ELSE apparent_power END,
           energy_kwh     = CASE WHEN $5 THEN $10::numeric ELSE energy_kwh END,
           frequency      = CASE WHEN $5 THEN $11::numeric ELSE frequency END,
           power_factor   = CASE WHEN $5 THEN $12::numeric ELSE power_factor END,
           temperature    = CASE WHEN $5 THEN $13::numeric ELSE temperature END,
           last_good_at   = CASE WHEN $5 THEN NOW() ELSE last_good_at END
         WHERE id = $1
         RETURNING *`,
        [
          breaker.id, sensorStatus, sensorError, contactorState, isGood,
          values.voltage, values.current, values.power, values.apparent_power,
          values.energy_kwh, values.frequency, values.power_factor, values.temperature,
        ]
      );
      breaker = updated.rows[0];
      await client.query(`UPDATE devices SET last_seen = NOW() WHERE device_id = $1`, [controllerId]);

      let legacy = null;
      if (isGood) {
        // 2) history (one row per good report)
        await client.query(
          `INSERT INTO readings_log (device_id, breaker_pk, voltage, current, power, apparent_power,
                                     energy_kwh, frequency, power_factor, temperature)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            controllerId, breaker.id, values.voltage, values.current, values.power, values.apparent_power,
            values.energy_kwh, values.frequency, values.power_factor, values.temperature,
          ]
        );

        // 3) legacy "latest per device" row, which GET /api/dashboard/:device_id reads. Channel 1 only.
        if (breaker.channel_number === 1) {
          const legacyResult = await client.query(
            `INSERT INTO readings (device_id, voltage, current, power, temperature, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (device_id)
             DO UPDATE SET voltage = $2, current = $3, power = $4, temperature = $5, updated_at = NOW()
             RETURNING *`,
            [controllerId, values.voltage, values.current, values.power, values.temperature]
          );
          legacy = legacyResult.rows[0];
        }

        // 4) thresholds -> alerts
        const label = breaker.name || `${controllerId}/${breaker.breaker_id}`;
        for (const m of METRICS) {
          const value = values[m.key];
          const max = breaker[m.thresholdCol];
          if (value === null || max === null || max === undefined) continue;
          await setAlert(client, breaker, m.key, value > max, {
            title: `${m.label} above threshold`,
            message: `${label} reported ${value}${m.unit}, over its ${max}${m.unit} limit.`,
            severity: value >= max * 1.2 ? "High" : "Medium",
          });
        }
      }

      // Sensor health and trips are alerts too, so failures are visible instead of silent.
      const label = breaker.name || `${controllerId}/${breaker.breaker_id}`;
      await setAlert(client, breaker, "sensor", !isGood, {
        title: "Sensor not reporting",
        message: `${label} reported sensor_status "${sensorStatus}"${sensorError ? `: ${sensorError}` : ""}. Showing the last good measurement.`,
        severity: "Medium",
      });
      if (contactorState) {
        await setAlert(client, breaker, "trip", contactorState === "TRIPPED", {
          title: "Breaker tripped",
          message: `${label} reported its contactor as TRIPPED.`,
          severity: "High",
        });
      }

      await client.query("COMMIT");

      const formatted = formatBreaker(breaker);
      return res.status(200).json({
        // Legacy fields first, so the response still looks like before for channel-1 uploads.
        device_id: controllerId,
        voltage: legacy ? legacy.voltage : values.voltage,
        current: legacy ? legacy.current : values.current,
        power: legacy ? legacy.power : values.power,
        temperature: legacy ? legacy.temperature : values.temperature,
        updated_at: formatted.health.last_seen,
        controller_id: controllerId,
        breaker_id: breaker.breaker_id,
        stored: isGood ? "measurement" : "status_only",
        breaker: formatted,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })
);

// GET /readings — the logged-in user's devices' latest (channel-1) readings. Legacy.
router.get(
  "/",
  requireAuth,
  asyncHandler("Fetch readings", async (req, res) => {
    const result = await pool.query(
      `SELECT r.*, d.nickname FROM readings r
       JOIN devices d ON d.device_id = r.device_id
       WHERE d.user_id = $1
       ORDER BY r.device_id`,
      [req.userId]
    );
    res.json(result.rows);
  })
);

// GET /readings/:device_id — one device's latest (channel-1) reading, owner only. Legacy.
router.get(
  "/:device_id",
  requireAuth,
  asyncHandler("Fetch reading", async (req, res) => {
    const result = await pool.query(
      `SELECT r.*, d.nickname FROM readings r
       JOIN devices d ON d.device_id = r.device_id
       WHERE r.device_id = $1 AND d.user_id = $2`,
      [req.params.device_id, req.userId]
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, "NOT_FOUND", "No reading found for that device");
    }
    res.json(result.rows[0]);
  })
);

module.exports = router;