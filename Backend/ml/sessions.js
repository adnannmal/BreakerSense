// Labeled recording sessions: validation helpers + "finalize" (copy readings permanently).

const { extractApplianceEvent } = require("./features");

const MAX_SESSION_MS = Number(process.env.ML_MAX_SESSION_MINUTES || 360) * 60 * 1000;
const MIN_SESSION_MS = 10 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
// readings_log is pruned at 7 days; leave an hour of margin for retroactive labels.
const LOG_RETENTION_MS = (7 * 24 - 1) * 3600 * 1000;

const LABEL_RE = /^[a-z0-9][a-z0-9 _-]{0,39}$/;
const RESERVED_LABELS = new Set(["unknown", "none", "no load", "no_load", "off"]);

// "Space Heater " -> "space heater". Returns { value } or { error }.
function normalizeLabel(raw) {
  if (typeof raw !== "string") return { error: "appliance_label is required" };
  const value = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!LABEL_RE.test(value)) {
    return { error: "appliance_label must be 1-40 characters: letters, numbers, spaces, - or _" };
  }
  if (RESERVED_LABELS.has(value)) return { error: `"${value}" is reserved; use a real appliance name` };
  return { value };
}

// Returns { value: Date | null } or { error }.
function parseTime(raw, field) {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  if (typeof raw !== "string") return { error: `${field} must be an ISO 8601 timestamp` };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { error: `${field} must be an ISO 8601 timestamp` };
  return { value: d };
}

// Checks a [start, end] window. end may be null (still recording). Returns an error string or null.
function checkWindow(start, end, now = Date.now()) {
  if (start.getTime() > now + CLOCK_SKEW_MS) return "started_at is in the future";
  if (start.getTime() < now - LOG_RETENTION_MS) return "started_at is older than the 7-day reading history";
  if (end) {
    if (end.getTime() > now + CLOCK_SKEW_MS) return "ended_at is in the future";
    const ms = end.getTime() - start.getTime();
    if (ms <= 0) return "ended_at must be after started_at";
    if (ms < MIN_SESSION_MS) return "recording must be at least 10 seconds long";
    if (ms > MAX_SESSION_MS) return `recording must be at most ${MAX_SESSION_MS / 60000} minutes; pass an explicit ended_at`;
  }
  return null;
}

// API shape for a session row.
function serializeSession(s) {
  return {
    session_id: String(s.id),
    breaker_id: s.breaker_id,
    appliance_label: s.appliance_label,
    status: s.status,
    started_at: s.started_at ? new Date(s.started_at).toISOString() : null,
    ended_at: s.ended_at ? new Date(s.ended_at).toISOString() : null,
    is_simulated: s.is_simulated,
    notes: s.notes,
    sample_count: s.sample_count,
    quality: s.quality,
    quality_details: s.quality_details,
    created_at: s.created_at ? new Date(s.created_at).toISOString() : null,
    completed_at: s.completed_at ? new Date(s.completed_at).toISOString() : null,
  };
}

// Copy the session's readings out of readings_log into ml_session_readings (permanent),
// score their quality, and mark the session COMPLETE. Runs in one transaction.
// Returns { session } or { error: { status, code, message } }.
async function finalizeSession(pool, sessionId, endedAt) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(`SELECT * FROM ml_learning_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
    const s = locked.rows[0];
    if (!s || s.status !== "RECORDING") {
      await client.query("ROLLBACK");
      return { error: { status: 409, code: "SESSION_NOT_RECORDING", message: "Session is not recording" } };
    }

    await client.query(
      `INSERT INTO ml_session_readings
         (session_id, source_log_id, recorded_at, voltage, current, power, power_factor, frequency, energy_kwh)
       SELECT $1, id, created_at, voltage, current, power, power_factor, frequency, energy_kwh
       FROM readings_log
       WHERE breaker_id = $2 AND created_at >= $3 AND created_at <= $4
       ON CONFLICT (session_id, source_log_id) DO NOTHING`,
      [s.id, s.breaker_id, s.started_at, endedAt]
    );

    const { rows: readings } = await client.query(
      `SELECT recorded_at, voltage, current, power, power_factor FROM ml_session_readings
       WHERE session_id = $1 ORDER BY recorded_at`,
      [s.id]
    );

    const ev = extractApplianceEvent(readings);
    const quality = ev.ok ? "OK" : ev.reason;
    const details = ev.ok
      ? {
          onset_detected: ev.onset_detected,
          onset_at: ev.onset_at,
          off_at: ev.off_at,
          baseline_power_w: ev.baseline_power_w,
          steady_samples: ev.steady_samples,
          features: ev.features,
          feature_version: ev.feature_version,
        }
      : { reason: ev.reason, samples: ev.total_samples, feature_version: ev.feature_version };
    if (ev.ok && !ev.onset_detected) {
      details.note = "No turn-on jump found: start recording with the appliance OFF for ~15 s so the startup spike and baseline are captured.";
    }

    const updated = await client.query(
      `UPDATE ml_learning_sessions
       SET status = 'COMPLETE', ended_at = $2, sample_count = $3, quality = $4,
           quality_details = $5::jsonb, completed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [s.id, endedAt, readings.length, quality, JSON.stringify(details)]
    );
    await client.query("COMMIT");
    return { session: updated.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  MAX_SESSION_MS,
  normalizeLabel,
  parseTime,
  checkWindow,
  serializeSession,
  finalizeSession,
};
