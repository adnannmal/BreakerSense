const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

/* COMMENTED OUT — the dashboard has no "possible cause" / appliance guess UI yet.
   (It was also a latent crash: it's declared as guessApplicances but was called as
   guessAppliances, which would throw a ReferenceError the first time power went over its limit.)

// Temp for the AI
function guessAppliances(excessWatts) {
  return [];
}
*/

// Which metrics the dashboard shows + may raise alerts on. Power is still stored from the
// ESP32's payload, but the frontend doesn't display it, so its threshold check is parked below.
const METRICS = [
  { key: "current",     label: "Current",     unit: "A",  thresholdCol: "current_threshold" },
  { key: "voltage",     label: "Voltage",     unit: "V",  thresholdCol: "voltage_threshold" },
  { key: "temperature", label: "Temperature", unit: "°C", thresholdCol: "temperature_threshold" },
];

function toNumberOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// POST /readings — the ESP32 calls this, no login required (devices don't
// have accounts, people do). It only succeeds if device_id was already
// registered to some user via POST /api/devices — that's what ties a
// reading back to the right account.
// Body example: { "device_id": "esp32-1", "voltage": 120.5, "current": 3.2, "power": 385.6, "temperature": 41.5 }
// (temperature is optional)
router.post("/", async (req, res) => {
  const { device_id } = req.body;
  const voltage = toNumberOrNull(req.body.voltage);
  const current = toNumberOrNull(req.body.current);
  const power = toNumberOrNull(req.body.power);
  const temperature = toNumberOrNull(req.body.temperature);

  if (!device_id) {
    return res.status(400).json({ error: "device_id is required" });
  }

  try {
    const owned = await pool.query(
      `SELECT device_id, nickname, voltage_threshold, current_threshold, power_threshold, temperature_threshold
       FROM devices WHERE device_id = $1`,
      [device_id]
    );
    if (owned.rows.length === 0) {
      return res.status(404).json({ error: "This device_id hasn't been registered to an account yet" });
    }
    const device = owned.rows[0];

    // 1) latest value (overwritten each time)
    const result = await pool.query(
      `INSERT INTO readings (device_id, voltage, current, power, temperature, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET voltage = $2, current = $3, power = $4, temperature = $5, updated_at = NOW()
       RETURNING *`,
      [device_id, voltage, current, power, temperature]
    );

    // 2) history (appended every time) — feeds the trend chart + uptime
    await pool.query(
      `INSERT INTO readings_log (device_id, voltage, current, power, temperature) VALUES ($1, $2, $3, $4, $5)`,
      [device_id, voltage, current, power, temperature]
    );
    // keep the log from growing forever: occasionally drop anything older than 7 days
    if (Math.random() < 0.01) {
      pool
        .query(`DELETE FROM readings_log WHERE created_at < NOW() - INTERVAL '7 days'`)
        .catch((e) => console.error("Log prune error:", e));
    }

    // 3) thresholds -> alerts
    const values = { current, voltage, temperature };
    const label = device.nickname || device_id;

    for (const m of METRICS) {
      const value = values[m.key];
      const limit = device[m.thresholdCol];
      if (value === null || limit === null || limit === undefined) continue;

      if (value > limit) {
        // Only one open alert per device+metric (otherwise a sensor stuck over its limit
        // would insert a new alert on every single POST).
        const open = await pool.query(
          `SELECT id FROM alerts WHERE device_id = $1 AND metric = $2 AND resolved = FALSE LIMIT 1`,
          [device_id, m.key]
        );
        if (open.rows.length === 0) {
          const severity = value >= limit * 1.2 ? "High" : "Medium";
          await pool.query(
            `INSERT INTO alerts (device_id, metric, title, message, severity) VALUES ($1, $2, $3, $4, $5)`,
            [
              device_id,
              m.key,
              `${m.label} above threshold`,
              `${label} reported ${value}${m.unit}, over its ${limit}${m.unit} limit.`,
              severity,
            ]
          );
        }
      } else {
        // Back within limits -> the alert no longer "needs attention".
        // (The history still shows up as the dashboard's "Last event".)
        await pool.query(
          `UPDATE alerts SET resolved = TRUE WHERE device_id = $1 AND metric = $2 AND resolved = FALSE`,
          [device_id, m.key]
        );
      }
    }

    /* COMMENTED OUT — the dashboard doesn't show power, so power alerts are parked.
    if (device.power_threshold != null && power > device.power_threshold) {
      const excess = power - device.power_threshold;
      const guesses = guessAppliances(excess);
      let message = `${device_id} power ${power}W is over its ${device.power_threshold}W limit.`;
      if (guesses.length > 0) message += ` Possible cause: ${guesses.join(" or ")}.`;
      await pool.query("INSERT INTO alerts (device_id, message) VALUES ($1, $2)", [device_id, message]);
    }
    */

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Insert reading error:", err);
    res.status(500).json({ error: "Could not save reading" });
  }
});

// GET /readings — the logged-in user's devices' latest readings only
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
    console.error("Fetch readings error:", err);
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
    console.error("Fetch reading error:", err);
    res.status(500).json({ error: "Could not load reading" });
  }
});

module.exports = router;
