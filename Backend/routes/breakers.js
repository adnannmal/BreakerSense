// /api/breakers — per-breaker (per-channel) reads, history, settings and commands. JWT, owner-scoped.

const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { apiError } = require("../middleware/errors");
const { BREAKER_SELECT, serializeBreaker, latestFromRow, loadOwnedBreaker, iso } = require("../services/breakers");
const { createCommand, serializeCommand, expirePending, CommandError } = require("../services/commands");

const METRICS = {
  voltage: { unit: "V", aggregation: "avg" },
  current: { unit: "A", aggregation: "avg" },
  power: { unit: "W", aggregation: "avg" },
  apparent_power: { unit: "VA", aggregation: "avg" },
  power_factor: { unit: "", aggregation: "avg" },
  frequency: { unit: "Hz", aggregation: "avg" },
  temperature: { unit: "°C", aggregation: "avg" },
  // Cumulative meter counter -> energy USED per bucket (sum of positive deltas; a drop = meter reset).
  energy_kwh: { unit: "kWh", aggregation: "interval_sum_from_counter" },
};
const RESOLUTIONS = { "10s": 10, "30s": 30, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 };
const MAX_RANGE_MS = 31 * 24 * 3600 * 1000;
const MAX_POINTS = 2000;

function parseRange(query, defaultMs) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - defaultMs);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) return { error: "from/to must be ISO 8601 timestamps" };
  if (from >= to) return { error: "from must be before to" };
  if (to - from > MAX_RANGE_MS) return { error: "range may be at most 31 days" };
  return { from, to };
}

function createBreakerRouter() {
  const router = express.Router();
  router.use(requireAuth);
  const commandLimiter = rateLimit({ name: "command", windowMs: 60_000, max: 20, key: (req) => req.userId });

  // GET /api/breakers?controller_id=
  router.get("/", async (req, res) => {
    try {
      const params = [req.userId];
      let filter = "";
      if (typeof req.query.controller_id === "string" && req.query.controller_id) {
        params.push(req.query.controller_id);
        filter = "AND b.controller_id = $2";
      }
      const r = await pool.query(`${BREAKER_SELECT} WHERE b.user_id = $1 ${filter} ORDER BY b.controller_id, b.channel_number`, params);
      return res.json({ breakers: r.rows.map((row) => serializeBreaker(row, { latest: latestFromRow(row) })) });
    } catch (err) {
      console.error("List breakers error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not load breakers");
    }
  });

  // GET /api/breakers/:breaker_id — settings + latest good reading + health
  router.get("/:breaker_id", async (req, res) => {
    try {
      const row = await loadOwnedBreaker(pool, req.userId, req.params.breaker_id);
      if (!row) return apiError(res, 404, "BREAKER_NOT_FOUND", "Breaker not found");
      const alerts = await pool.query(`SELECT COUNT(*)::int AS n FROM alerts WHERE breaker_id = $1 AND resolved = FALSE`, [row.breaker_id]);
      return res.json({ ...serializeBreaker(row, { latest: latestFromRow(row) }), active_alert_count: alerts.rows[0].n });
    } catch (err) {
      console.error("Get breaker error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not load breaker");
    }
  });

  // PATCH /api/breakers/:breaker_id — name, location, rated_current_a, thresholds
  // Thresholds are notification settings only; they do not change any physical trip current.
  router.patch("/:breaker_id", async (req, res) => {
    const body = req.body || {};
    const sets = [];
    const params = [];
    for (const f of ["name", "location"]) {
      if (body[f] === undefined) continue;
      if (body[f] !== null && (typeof body[f] !== "string" || body[f].length > 100)) {
        return apiError(res, 400, "VALIDATION_ERROR", `${f} must be a string of at most 100 characters`, { field: f });
      }
      params.push(body[f] || null);
      sets.push(`${f} = $${params.length}`);
    }
    const numeric = { rated_current_a: body.rated_current_a, ...(body.thresholds || {}) };
    for (const [f, raw] of Object.entries(numeric)) {
      if (!["rated_current_a", "voltage_threshold", "current_threshold", "power_threshold", "temperature_threshold"].includes(f)) {
        return apiError(res, 400, "VALIDATION_ERROR", `unknown field ${f}`, { field: f });
      }
      if (raw === undefined) continue;
      const n = raw === null ? null : Number(raw);
      if (n !== null && (typeof raw === "boolean" || !Number.isFinite(n) || n < 0)) {
        return apiError(res, 400, "VALIDATION_ERROR", `${f} must be a non-negative number or null`, { field: f });
      }
      params.push(n);
      sets.push(`${f} = $${params.length}`);
    }
    if (!sets.length) return apiError(res, 400, "VALIDATION_ERROR", "Nothing to update");

    try {
      params.push(req.params.breaker_id, req.userId);
      const n = params.length;
      const r = await pool.query(
        `UPDATE breakers SET ${sets.join(", ")}, updated_at = NOW() WHERE breaker_id = $${n - 1} AND user_id = $${n} RETURNING *`,
        params
      );
      const b = r.rows[0];
      if (!b) return apiError(res, 404, "BREAKER_NOT_FOUND", "Breaker not found");
      if (b.breaker_id === b.controller_id && b.channel_number === 1) {
        // Keep the legacy device row (used by /api/devices and /api/dashboard) in sync.
        await pool.query(
          `UPDATE devices SET nickname = $2, location = $3, capacity_amps = $4, voltage_threshold = $5,
                  current_threshold = $6, power_threshold = $7, temperature_threshold = $8
           WHERE device_id = $1`,
          [b.controller_id, b.name, b.location, b.rated_current_a, b.voltage_threshold, b.current_threshold, b.power_threshold, b.temperature_threshold]
        );
      }
      const row = await loadOwnedBreaker(pool, req.userId, b.breaker_id);
      return res.json(serializeBreaker(row, { latest: latestFromRow(row) }));
    } catch (err) {
      console.error("Update breaker error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not update breaker");
    }
  });

  // DELETE /api/breakers/:breaker_id — removes a NON-channel-1 breaker and its readings/alerts/commands.
  // The channel-1 alias is deleted together with its controller via DELETE /api/devices/:device_id.
  router.delete("/:breaker_id", async (req, res) => {
    try {
      const row = await loadOwnedBreaker(pool, req.userId, req.params.breaker_id);
      if (!row) return apiError(res, 404, "BREAKER_NOT_FOUND", "Breaker not found");
      if (row.breaker_id === row.controller_id && row.channel_number === 1) {
        return apiError(res, 409, "LEGACY_ALIAS_BREAKER", "This is the controller's channel-1 breaker; delete the device instead", {
          delete_path: `/api/devices/${encodeURIComponent(row.controller_id)}`,
        });
      }
      await pool.query(`DELETE FROM breakers WHERE breaker_id = $1 AND user_id = $2`, [row.breaker_id, req.userId]);
      return res.json({ deleted: true, breaker_id: row.breaker_id, controller_id: row.controller_id, channel_number: row.channel_number });
    } catch (err) {
      console.error("Delete breaker error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not delete breaker");
    }
  });

  // GET /api/breakers/:breaker_id/readings?from=&to=&limit=&cursor=
  // Raw stored readings, oldest first, paginated with next_cursor. Default window: last hour.
  router.get("/:breaker_id/readings", async (req, res) => {
    const range = parseRange(req.query, 3600 * 1000);
    if (range.error) return apiError(res, 400, "VALIDATION_ERROR", range.error);
    const limit = req.query.limit === undefined ? 500 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) return apiError(res, 400, "VALIDATION_ERROR", "limit must be 1-2000", { field: "limit" });
    const cursor = req.query.cursor ?? null;
    if (cursor !== null && !/^\d{1,18}$/.test(cursor)) return apiError(res, 400, "VALIDATION_ERROR", "invalid cursor", { field: "cursor" });

    try {
      const row = await loadOwnedBreaker(pool, req.userId, req.params.breaker_id);
      if (!row) return apiError(res, 404, "BREAKER_NOT_FOUND", "Breaker not found");
      const r = await pool.query(
        `SELECT id, created_at, device_recorded_at, sequence, voltage, current, power, apparent_power,
                power_factor, frequency, energy_kwh, temperature
         FROM readings_log
         WHERE breaker_id = $1 AND created_at >= $2 AND created_at < $3 AND ($4::bigint IS NULL OR id > $4::bigint)
         ORDER BY id LIMIT $5`,
        [row.breaker_id, range.from, range.to, cursor, limit + 1]
      );
      const hasMore = r.rows.length > limit;
      const rows = r.rows.slice(0, limit);
      return res.json({
        breaker_id: row.breaker_id,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        units: { voltage: "V", current: "A", power: "W", apparent_power: "VA", power_factor: "", frequency: "Hz", energy_kwh: "kWh (meter counter)", temperature: "°C" },
        readings: rows.map(({ id, created_at, device_recorded_at, ...v }) => ({ t: iso(created_at), device_recorded_at: iso(device_recorded_at), ...v, sequence: v.sequence === null ? null : Number(v.sequence) })),
        count: rows.length,
        has_more: hasMore,
        next_cursor: hasMore ? String(rows[rows.length - 1].id) : null,
      });
    } catch (err) {
      console.error("Breaker readings error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not load readings");
    }
  });

  // GET /api/breakers/:breaker_id/measurements?metric=power&from=&to=&resolution=auto|10s|1m|5m|15m|1h|6h|1d
  // Chart series. Buckets with no data are value:null (never 0). Default window: last 24 h.
  router.get("/:breaker_id/measurements", async (req, res) => {
    const metric = req.query.metric || "power";
    if (!METRICS[metric]) return apiError(res, 400, "VALIDATION_ERROR", `metric must be one of ${Object.keys(METRICS).join(", ")}`, { field: "metric" });
    const range = parseRange(req.query, 24 * 3600 * 1000);
    if (range.error) return apiError(res, 400, "VALIDATION_ERROR", range.error);

    const spanS = (range.to - range.from) / 1000;
    let resolution = req.query.resolution || "auto";
    let bucket;
    if (resolution === "auto") {
      const [name, s] = Object.entries(RESOLUTIONS).find(([, s]) => spanS / s <= 300) || ["1d", 86400];
      resolution = name;
      bucket = s;
    } else if (RESOLUTIONS[resolution]) {
      bucket = RESOLUTIONS[resolution];
    } else {
      return apiError(res, 400, "VALIDATION_ERROR", `resolution must be auto or one of ${Object.keys(RESOLUTIONS).join(", ")}`, { field: "resolution" });
    }
    if (spanS / bucket > MAX_POINTS) return apiError(res, 400, "VALIDATION_ERROR", `too many points; use a coarser resolution (max ${MAX_POINTS})`);

    try {
      const row = await loadOwnedBreaker(pool, req.userId, req.params.breaker_id);
      if (!row) return apiError(res, 404, "BREAKER_NOT_FOUND", "Breaker not found");

      const bucketExpr = `to_timestamp(floor(extract(epoch FROM created_at) / $4::float8) * $4::float8)`;
      const sql =
        METRICS[metric].aggregation === "avg"
          ? `SELECT ${bucketExpr} AS t, AVG(${metric})::float8 AS value, COUNT(*)::int AS samples
             FROM readings_log WHERE breaker_id = $1 AND created_at >= $2 AND created_at < $3 AND ${metric} IS NOT NULL
             GROUP BY 1 ORDER BY 1`
          : `WITH s AS (
               SELECT created_at, energy_kwh,
                      energy_kwh - LAG(energy_kwh) OVER (ORDER BY created_at, id) AS d
               FROM readings_log WHERE breaker_id = $1 AND created_at >= $2 AND created_at < $3 AND energy_kwh IS NOT NULL)
             SELECT ${bucketExpr} AS t,
                    SUM(CASE WHEN d IS NULL THEN 0 WHEN d >= 0 THEN d ELSE energy_kwh END)::float8 AS value,
                    COUNT(*)::int AS samples
             FROM s GROUP BY 1 ORDER BY 1`;
      const r = await pool.query(sql, [row.breaker_id, range.from, range.to, bucket]);
      const byT = new Map(r.rows.map((p) => [new Date(p.t).getTime(), p]));

      const points = [];
      const start = Math.floor(range.from.getTime() / 1000 / bucket) * bucket * 1000;
      for (let t = start; t < range.to.getTime(); t += bucket * 1000) {
        const p = byT.get(t);
        points.push({ t: new Date(t).toISOString(), value: p ? Math.round(p.value * 10000) / 10000 : null, samples: p ? p.samples : 0 });
      }
      return res.json({
        breaker_id: row.breaker_id,
        metric,
        unit: METRICS[metric].unit,
        aggregation: METRICS[metric].aggregation,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        resolution,
        bucket_seconds: bucket,
        points,
        count: points.length,
        has_more: false,
      });
    } catch (err) {
      console.error("Breaker measurements error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not load measurements");
    }
  });

  // POST /api/breakers/:breaker_id/commands { action: "ON"|"OFF" }   (optional header Idempotency-Key)
  router.post("/:breaker_id/commands", commandLimiter, async (req, res) => {
    try {
      const { command, replayed } = await createCommand(pool, {
        userId: req.userId,
        breakerId: req.params.breaker_id,
        action: req.body?.action,
        idempotencyKey: req.get("Idempotency-Key") ?? null,
      });
      return res.status(replayed ? 200 : 202).json({ ...serializeCommand(command), replayed });
    } catch (err) {
      if (err instanceof CommandError) return apiError(res, err.status, err.code, err.message, err.details);
      console.error("Create command error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not create command");
    }
  });

  // GET /api/breakers/:breaker_id/commands?limit=20 — newest first
  router.get("/:breaker_id/commands", async (req, res) => {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return apiError(res, 400, "VALIDATION_ERROR", "limit must be 1-100", { field: "limit" });
    try {
      const row = await loadOwnedBreaker(pool, req.userId, req.params.breaker_id);
      if (!row) return apiError(res, 404, "BREAKER_NOT_FOUND", "Breaker not found");
      await expirePending(pool, row.controller_id);
      const r = await pool.query(`SELECT * FROM commands WHERE breaker_id = $1 ORDER BY created_at DESC LIMIT $2`, [row.breaker_id, limit]);
      return res.json({ commands: r.rows.map(serializeCommand) });
    } catch (err) {
      console.error("List commands error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not load commands");
    }
  });

  return router;
}

module.exports = { createBreakerRouter };
