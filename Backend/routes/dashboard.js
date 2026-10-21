const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

// GET /api/dashboard/:device_id?hours=6
//
// NEW — everything the dashboard page needs for ONE breaker in a single call, so the frontend
// can poll one URL every few seconds:
//   device      – name, location, capacity, status, thresholds
//   latest      – newest voltage / current / power / temperature (null until the ESP32 has posted)
//   uptime_pct  – % of the last 24h (or since the breaker was added) that had at least one reading
//   last_event  – most recent alert in the last 24h (open or resolved), or null
//   alerts      – open alerts that still "need attention"
//   history     – averaged current draw over the last N hours, for the line chart
router.get("/:device_id", async (req, res) => {
  const deviceId = req.params.device_id;
  const hours = Math.min(Math.max(Number(req.query.hours) || 6, 1), 24);

  try {
    // 1) the device (also enforces "only your own devices")
    const deviceResult = await pool.query(
      `SELECT device_id, nickname, location, capacity_amps, status,
              voltage_threshold, current_threshold, power_threshold, temperature_threshold, created_at
       FROM devices WHERE device_id = $1 AND user_id = $2`,
      [deviceId, req.userId]
    );
    if (deviceResult.rows.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }
    const device = deviceResult.rows[0];

    // 2) latest reading
    const latestResult = await pool.query(
      `SELECT voltage, current, power, temperature, updated_at FROM readings WHERE device_id = $1`,
      [deviceId]
    );
    const latest = latestResult.rows[0] || null;

    // 3) uptime over the last 24h (or since the device was added, if newer)
    const now = Date.now();
    const uptimeStart = new Date(Math.max(new Date(device.created_at).getTime(), now - 24 * 3600 * 1000));
    const totalMinutes = Math.max(1, Math.ceil((now - uptimeStart.getTime()) / 60000));
    const coveredResult = await pool.query(
      `SELECT COUNT(DISTINCT date_trunc('minute', created_at))::int AS covered
       FROM readings_log WHERE device_id = $1 AND created_at >= $2`,
      [deviceId, uptimeStart]
    );
    const covered = coveredResult.rows[0].covered;
    const uptime_pct = covered === 0 ? null : Math.min(100, Math.round((covered / totalMinutes) * 10000) / 100);

    // 4) last event in the last 24h
    const lastEventResult = await pool.query(
      `SELECT title, message, severity, created_at FROM alerts
       WHERE device_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [deviceId]
    );
    const last_event = lastEventResult.rows[0] || null;

    // 5) open alerts
    const alertsResult = await pool.query(
      `SELECT id, title, message, severity, metric, created_at FROM alerts
       WHERE device_id = $1 AND resolved = FALSE
       ORDER BY created_at DESC LIMIT 20`,
      [deviceId]
    );

    // 6) chart history. Aim for ~30 points: if the breaker has only been reporting for a few
    //    minutes the buckets are tiny (10s) so the chart isn't a single dot; over the full window
    //    they grow so it stays readable.
    const since = new Date(now - hours * 3600 * 1000);
    const firstResult = await pool.query(
      `SELECT MIN(created_at) AS first FROM readings_log WHERE device_id = $1 AND created_at >= $2`,
      [deviceId, since]
    );
    let history = [];
    let bucket_seconds = 60;
    const first = firstResult.rows[0].first;
    if (first) {
      const spanSeconds = Math.max(1, (now - new Date(first).getTime()) / 1000);
      bucket_seconds = Math.max(10, Math.ceil(spanSeconds / 30 / 10) * 10);
      const historyResult = await pool.query(
        `SELECT to_timestamp(floor(extract(epoch FROM created_at) / $2::float8) * $2::float8) AS t,
                AVG(current)::float8 AS current
         FROM readings_log
         WHERE device_id = $1 AND created_at >= $3 AND current IS NOT NULL
         GROUP BY 1 ORDER BY 1`,
        [deviceId, bucket_seconds, since]
      );
      history = historyResult.rows;
    }

    res.json({
      device,
      latest,
      uptime_pct,
      last_event,
      alerts: alertsResult.rows,
      history,
      bucket_seconds,
      server_time: new Date(now).toISOString(),
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json({ error: "Could not load dashboard" });
  }
});

module.exports = router;
