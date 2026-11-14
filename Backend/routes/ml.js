// /api/ml — labeled appliance recordings, training, evaluation and live appliance guesses.
// All routes need a user JWT and only ever touch the caller's own breakers/sessions/models.
// Errors use the Sprint 3 envelope: { "error": { "code", "message", "details"? } }.
// See docs/ML_APPLIANCE_CLASSIFIER.md for the full contract and the recording protocol.

const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { normalizeLabel, parseTime, checkWindow, serializeSession, finalizeSession } = require("../ml/sessions");
const { runTraining, TrainingDataError, TARGET_SESSIONS_PER_LABEL, MIN_SESSIONS_PER_LABEL } = require("../ml/train");
const { extractApplianceEvent, recentEventWindow, toVector, DEFAULTS: FEATURE_DEFAULTS, FEATURE_VERSION } = require("../ml/features");
const { predictKnn, MODEL_TYPE } = require("../ml/classifier");
const { median } = require("../ml/stats");

const router = express.Router();
router.use(requireAuth);

const STALE_AFTER_MS = 30 * 1000;

function fail(res, status, code, message, details) {
  return res.status(status).json({ error: { code, message, ...(details !== undefined && { details }) } });
}

function isId(v) {
  return typeof v === "string" && /^\d{1,18}$/.test(v);
}

async function ownsBreaker(userId, breakerId) {
  const r = await pool.query(`SELECT 1 FROM breakers WHERE breaker_id = $1 AND user_id = $2`, [breakerId, userId]);
  return r.rows.length > 0;
}

async function loadOwnedSession(userId, id) {
  if (!isId(id)) return null;
  const r = await pool.query(`SELECT * FROM ml_learning_sessions WHERE id = $1 AND user_id = $2`, [id, userId]);
  return r.rows[0] || null;
}

async function findOverlap(breakerId, start, end, excludeId = null) {
  const r = await pool.query(
    `SELECT id, appliance_label FROM ml_learning_sessions
     WHERE breaker_id = $1 AND status <> 'DISCARDED' AND ($4::bigint IS NULL OR id <> $4::bigint)
       AND tstzrange(started_at, COALESCE(ended_at, 'infinity'::timestamptz))
           && tstzrange($2::timestamptz, COALESCE($3::timestamptz, 'infinity'::timestamptz))
     LIMIT 1`,
    [breakerId, start, end, excludeId]
  );
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// POST /api/ml/sessions
// { breaker_id (or legacy device_id), appliance_label, started_at?, ended_at?, notes?, is_simulated? }
//   no ended_at  -> starts a RECORDING session (stop it with /stop)
//   ended_at     -> labels a past window (within the last 7 days) and saves it immediately
// ---------------------------------------------------------------------------
router.post("/sessions", async (req, res) => {
  const body = req.body || {};
  const rawId = body.breaker_id ?? body.device_id;
  const breakerId = typeof rawId === "string" ? rawId.trim() : "";
  if (!breakerId) return fail(res, 400, "VALIDATION_ERROR", "breaker_id is required", { field: "breaker_id" });

  const label = normalizeLabel(body.appliance_label);
  if (label.error) return fail(res, 400, "VALIDATION_ERROR", label.error, { field: "appliance_label" });

  if (body.notes !== undefined && body.notes !== null && (typeof body.notes !== "string" || body.notes.length > 500)) {
    return fail(res, 400, "VALIDATION_ERROR", "notes must be a string of at most 500 characters", { field: "notes" });
  }
  if (body.is_simulated !== undefined && typeof body.is_simulated !== "boolean") {
    return fail(res, 400, "VALIDATION_ERROR", "is_simulated must be true or false", { field: "is_simulated" });
  }

  const startParsed = parseTime(body.started_at, "started_at");
  const endParsed = parseTime(body.ended_at, "ended_at");
  for (const [p, field] of [[startParsed, "started_at"], [endParsed, "ended_at"]]) {
    if (p.error) return fail(res, 400, "VALIDATION_ERROR", p.error, { field });
  }
  const start = startParsed.value || new Date();
  const end = endParsed.value;
  const windowError = checkWindow(start, end);
  if (windowError) return fail(res, 422, "INVALID_TIME_WINDOW", windowError);

  try {
    if (!(await ownsBreaker(req.userId, breakerId))) {
      return fail(res, 404, "BREAKER_NOT_FOUND", "Breaker not found");
    }
    const overlap = await findOverlap(breakerId, start, end);
    if (overlap) {
      return fail(res, 409, "SESSION_OVERLAP", "This breaker already has a recording in that time window", {
        session_id: String(overlap.id),
        appliance_label: overlap.appliance_label,
      });
    }

    const inserted = await pool.query(
      `INSERT INTO ml_learning_sessions (user_id, breaker_id, appliance_label, started_at, notes, is_simulated)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.userId, breakerId, label.value, start, body.notes || null, body.is_simulated === true]
    );
    let session = inserted.rows[0];

    if (end) {
      const done = await finalizeSession(pool, session.id, end);
      if (done.error) return fail(res, done.error.status, done.error.code, done.error.message);
      session = done.session;
    }
    return res.status(201).json(serializeSession(session));
  } catch (err) {
    if (err.code === "23505") {
      return fail(res, 409, "SESSION_ALREADY_RECORDING", "This breaker already has a recording in progress");
    }
    console.error("Create learning session error:", err.message);
    return fail(res, 500, "INTERNAL_ERROR", "Could not create recording session");
  }
});

// POST /api/ml/sessions/:id/stop  { ended_at? }  -> copies readings permanently, scores quality
router.post("/sessions/:id/stop", async (req, res) => {
  const endParsed = parseTime(req.body?.ended_at, "ended_at");
  if (endParsed.error) return fail(res, 400, "VALIDATION_ERROR", endParsed.error, { field: "ended_at" });

  try {
    const s = await loadOwnedSession(req.userId, req.params.id);
    if (!s) return fail(res, 404, "SESSION_NOT_FOUND", "Recording session not found");
    if (s.status !== "RECORDING") return fail(res, 409, "SESSION_NOT_RECORDING", `Session is already ${s.status}`);

    const end = endParsed.value || new Date();
    const windowError = checkWindow(new Date(s.started_at), end);
    if (windowError) return fail(res, 422, "INVALID_TIME_WINDOW", windowError);

    if (!(await ownsBreaker(req.userId, s.breaker_id))) {
      return fail(res, 409, "BREAKER_NOT_OWNED", "This breaker is no longer registered to your account");
    }

    const done = await finalizeSession(pool, s.id, end);
    if (done.error) return fail(res, done.error.status, done.error.code, done.error.message);
    return res.json(serializeSession(done.session));
  } catch (err) {
    console.error("Stop learning session error:", err.message);
    return fail(res, 500, "INTERNAL_ERROR", "Could not stop recording session");
  }
});

// POST /api/ml/sessions/:id/discard — excludes a bad recording from training. Data is kept.
router.post("/sessions/:id/discard", async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 404, "SESSION_NOT_FOUND", "Recording session not found");
    const r = await pool.query(
      `UPDATE ml_learning_sessions SET status = 'DISCARDED', ended_at = COALESCE(ended_at, GREATEST(NOW(), started_at + INTERVAL '1 second'))
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.userId]
    );
    if (!r.rows.length) return fail(res, 404, "SESSION_NOT_FOUND", "Recording session not found");
    return res.json(serializeSession(r.rows[0]));
  } catch (err) {
    console.error("Discard learning session error:", err.message);
    return fail(res, 500, "INTERNAL_ERROR", "Could not discard recording session");
  }
});

// GET /api/ml/sessions?breaker_id=&appliance_label=&status=
router.get("/sessions", async (req, res) => {
  const params = [req.userId];
  const where = ["user_id = $1"];
  const qBreaker = req.query.breaker_id ?? req.query.device_id;
  if (typeof qBreaker === "string" && qBreaker) {
    params.push(qBreaker);
    where.push(`breaker_id = $${params.length}`);
  }
  if (typeof req.query.appliance_label === "string" && req.query.appliance_label) {
    params.push(req.query.appliance_label.trim().toLowerCase());
    where.push(`appliance_label = $${params.length}`);
  }
  if (typeof req.query.status === "string" && req.query.status) {
    if (!["RECORDING", "COMPLETE", "DISCARDED"].includes(req.query.status)) {
      return fail(res, 400, "VALIDATION_ERROR", "status must be RECORDING, COMPLETE or DISCARDED", { field: "status" });
    }
    params.push(req.query.status);
    where.push(`status = $${params.length}`);
  }
  try {
    const r = await pool.query(
      `SELECT * FROM ml_learning_sessions WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT 500`,
      params
    );
    return res.json({ sessions: r.rows.map(serializeSession) });
  } catch (err) {
    console.error("List learning sessions error:", err.message);
    return fail(res, 500, "INTERNAL_ERROR", "Could not load recording sessions");
  }
});

// GET /api/ml/sessions/:id?include_readings=true
router.get("/sessions/:id", async (req, res) => {
  try {
    const s = await loadOwnedSession(req.userId, req.params.id);
    if (!s) return fail(res, 404, "SESSION_NOT_FOUND", "Recording session not found");
    const out = serializeSession(s);
    if (req.query.include_readings === "true") {
      const r = await pool.query(
        `SELECT recorded_at, voltage, current, power, power_factor, frequency, energy_kwh
         FROM ml_session_readings WHERE session_id = $1 ORDER BY recorded_at`,
        [s.id]
      );
      out.readings = r.rows;
    }
    return res.json(out);
  } catch (err) {
    console.error("Get learning session error:", err.message);
    return fail(res, 500, "INTERNAL_ERROR", "Could not load recording session");
  }
});

// GET /api/ml/dataset/summary — "do we have enough recordings yet?"
router.get("/dataset/summary", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT appliance_label,
              COUNT(*) FILTER (WHERE status = 'COMPLETE' AND quality = 'OK' AND NOT is_simulated)::int AS usable_sessions,
              COUNT(*) FILTER (WHERE status = 'COMPLETE' AND quality <> 'OK')::int AS low_quality_sessions,
              COUNT(*) FILTER (WHERE status = 'COMPLETE' AND is_simulated)::int AS simulated_sessions,
              COUNT(*) FILTER (WHERE status = 'RECORDING')::int AS recording_sessions,
              COALESCE(SUM(sample_count) FILTER (WHERE status = 'COMPLETE' AND quality = 'OK' AND NOT is_simulated), 0)::int AS usable_samples
       FROM ml_learning_sessions
       WHERE user_id = $1 AND status <> 'DISCARDED'
       GROUP BY appliance_label ORDER BY appliance_label`,
      [req.userId]
    );
    const appliances = r.rows.map((row) => ({ ...row, meets_target: row.usable_sessions >= TARGET_SESSIONS_PER_LABEL }));
    const trainable = appliances.filter((a) => a.usable_sessions >= MIN_SESSIONS_PER_LABEL).length;
    return res.json({
      target_sessions_per_appliance: TARGET_SESSIONS_PER_LABEL,
      appliances,
      ready_to_train: trainable >= 2,
      all_meet_target: appliances.length > 0 && appliances.every((a) => a.meets_target),
    });
  } catch (err) {
    console.error("Dataset summary error:", err.message);
    return fail(res, 500, "INTERNAL_ERROR", "Could not summarize dataset");
  }
});

// GET /api/ml/dataset/export — every labeled session + readings as one JSON file (backup / notebooks)
router.get("/dataset/export", async (req, res) => {
  try {
    const sessions = await pool.query(
      `SELECT * FROM ml_learning_sessions WHERE user_id = $1 AND status = 'COMPLETE' ORDER BY started_at`,
      [req.userId]
    );
    const ids = sessions.rows.map((s) => String(s.id));
    const readings = ids.length
      ? await pool.query(
          `SELECT session_id, recorded_at, voltage, current, power, power_factor, frequency, energy_kwh
           FROM ml_session_readings WHERE session_id = ANY($1::bigint[]) ORDER BY session_id, recorded_at`,
          [ids]
        )
      : { rows: [] };
    const bySession = new Map(ids.map((id) => [id, []]));
    for (const row of readings.rows) {
      const { session_id, ...rest } = row;
      bySession.get(String(session_id))?.push(rest);
    }
    res.set("Content-Disposition", `attachment; filename="breakersense-appliance-dataset.json"`);
    return res.json({
      exported_at: new Date().toISOString(),
      feature_version: FEATURE_VERSION,
      sessions: sessions.rows.map((s) => ({ ...serializeSession(s), readings: bySession.get(String(s.id)) })),
    });
  } catch (err) {
    console.error("Dataset export error:", err.message);
    return fail(res, 500, "INTERNAL_ERROR", "Could not export dataset");
  }
});

// ---------------------------------------------------------------------------
// POST /api/ml/train
// { test_fraction?: 0.1–0.5 (0.3), seed?: int (42), k?: 1–9 (3),
//   include_simulated?: bool (false), unknown_test_labels?: [label, ...] }
// ---------------------------------------------------------------------------
router.post("/train", async (req, res) => {
  const body = req.body || {};
  const testFraction = body.test_fraction ?? 0.3;
  const seed = body.seed ?? 42;
  const k = body.k ?? 3;
  if (typeof testFraction !== "number" || testFraction < 0.1 || testFraction > 0.5) {
    return fail(res, 400, "VALIDATION_ERROR", "test_fraction must be between 0.1 and 0.5", { field: "test_fraction" });
  }
  if (!Number.isInteger(seed)) return fail(res, 400, "VALIDATION_ERROR", "seed must be an integer", { field: "seed" });
  if (!Number.isInteger(k) || k < 1 || k > 9) return fail(res, 400, "VALIDATION_ERROR", "k must be an integer 1-9", { field: "k" });
  if (body.include_simulated !== undefined && typeof body.include_simulated !== "boolean") {
    return fail(res, 400, "VALIDATION_ERROR", "include_simulated must be true or false", { field: "include_simulated" });
  }
  const unknownTestLabels = [];
  if (body.unknown_test_labels !== undefined) {
    if (!Array.isArray(body.unknown_test_labels) || body.unknown_test_labels.length > 20) {
      return fail(res, 400, "VALIDATION_ERROR", "unknown_test_labels must be a list of appliance labels", { field: "unknown_test_labels" });
    }
    for (const raw of body.unknown_test_labels) {
      const l = normalizeLabel(raw);
      if (l.error) return fail(res, 400, "VALIDATION_ERROR", l.error, { field: "unknown_test_labels" });
      unknownTestLabels.push(l.value);
    }
  }

  try {
    const sessions = await pool.query(
      `SELECT id, appliance_label FROM ml_learning_sessions
       WHERE user_id = $1 AND status = 'COMPLETE' AND quality = 'OK' AND ($2::boolean OR NOT is_simulated)
       ORDER BY id`,
      [req.userId, body.include_simulated === true]
    );
    const ids = sessions.rows.map((s) => String(s.id));
    const readings = ids.length
      ? await pool.query(
          `SELECT session_id, recorded_at, voltage, current, power, power_factor
           FROM ml_session_readings WHERE session_id = ANY($1::bigint[]) ORDER BY session_id, recorded_at`,
          [ids]
        )
      : { rows: [] };
    const bySession = new Map(ids.map((id) => [id, []]));
    for (const row of readings.rows) bySession.get(String(row.session_id))?.push(row);

    const result = runTraining(
      sessions.rows.map((s) => ({ id: String(s.id), appliance_label: s.appliance_label, readings: bySession.get(String(s.id)) })),
      { testFraction, seed, k, unknownTestLabels }
    );

    const modelVersion = `load-${MODEL_TYPE}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
    const saved = await pool.query(
      `INSERT INTO ml_models (user_id, model_version, model_type, feature_version, artifact, metrics, dataset)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb) RETURNING id, created_at`,
      [
        req.userId,
        modelVersion,
        MODEL_TYPE,
        FEATURE_VERSION,
        JSON.stringify(result.model),
        JSON.stringify({ ...result.metrics, warnings: result.warnings, include_simulated: body.include_simulated === true }),
        JSON.stringify(result.dataset),
      ]
    );

    return res.status(201).json({
      model_id: String(saved.rows[0].id),
      model_version: modelVersion,
      model_type: MODEL_TYPE,
      feature_version: FEATURE_VERSION,
      trained_at: new Date(saved.rows[0].created_at).toISOString(),
      labels: result.model.labels,
      metrics: result.metrics,
      dataset: result.dataset,
      warnings: result.warnings,
    });
  } catch (err) {
    if (err instanceof TrainingDataError) {
      return fail(res, 422, err.code, err.message, err.details);
    }
    console.error("Train appliance model error:", err.message);
    return fail(res, 500, "INTERNAL_ERROR", "Could not train appliance model");
  }
});

async function latestModel(userId) {
  const r = await pool.query(
    `SELECT * FROM ml_models WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId]
  );
  return r.rows[0] || null;
}

// GET /api/ml/models/latest — metrics of the newest model (training vectors left out)
router.get("/models/latest", async (req, res) => {
  try {
    const m = await latestModel(req.userId);
    if (!m) return fail(res, 404, "NO_MODEL", "No appliance model has been trained yet");
    return res.json({
      model_id: String(m.id),
      model_version: m.model_version,
      model_type: m.model_type,
      feature_version: m.feature_version,
      trained_at: new Date(m.created_at).toISOString(),
      labels: m.artifact.labels,
      training_examples: m.artifact.examples.length,
      unknown_distance: m.artifact.unknown_distance,
      metrics: m.metrics,
      dataset: m.dataset,
    });
  } catch (err) {
    console.error("Latest model error:", err.message);
    return fail(res, 500, "INTERNAL_ERROR", "Could not load appliance model");
  }
});

// GET /api/ml/model-status — small status object for the UI
router.get("/model-status", async (req, res) => {
  try {
    const m = await latestModel(req.userId);
    if (!m) return res.json({ status: "LEARNING", model_version: null, trained_at: null, labels: [], holdout_accuracy: null });
    return res.json({
      status: "READY",
      model_version: m.model_version,
      trained_at: new Date(m.created_at).toISOString(),
      labels: m.artifact.labels,
      holdout_accuracy: m.metrics?.holdout?.accuracy ?? null,
      holdout_test_sessions: m.metrics?.split?.test_sessions ?? null,
    });
  } catch (err) {
    console.error("Model status error:", err.message);
    return fail(res, 500, "INTERNAL_ERROR", "Could not load model status");
  }
});

// ---------------------------------------------------------------------------
// GET /api/ml/breakers/:breaker_id/prediction?minutes=3   (alias: /api/ml/devices/:device_id/prediction)
// Guesses the appliance in the breaker's recent readings.
// status: OK | LEARNING (no model) | NO_RECENT_DATA | INSUFFICIENT_DATA | NO_LOAD
// ---------------------------------------------------------------------------
async function predictionHandler(req, res) {
  const breakerId = req.params.breaker_id ?? req.params.device_id;
  const minutes = req.query.minutes === undefined ? 3 : Number(req.query.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
    return fail(res, 400, "VALIDATION_ERROR", "minutes must be an integer 1-30", { field: "minutes" });
  }

  try {
    if (!(await ownsBreaker(req.userId, breakerId))) return fail(res, 404, "BREAKER_NOT_FOUND", "Breaker not found");

    const empty = { breaker_id: breakerId, appliance_label: null, is_unknown: null, confidence: null, model_version: null };
    const m = await latestModel(req.userId);
    if (!m) return res.json({ ...empty, status: "LEARNING", message: "No appliance model has been trained yet" });

    const r = await pool.query(
      `SELECT created_at, voltage, current, power, power_factor FROM readings_log
       WHERE breaker_id = $1 AND created_at >= NOW() - make_interval(mins => $2::int)
       ORDER BY created_at`,
      [breakerId, minutes]
    );
    const rows = r.rows;
    const last = rows[rows.length - 1];
    const base = { ...empty, model_version: m.model_version };
    if (!last || Date.now() - new Date(last.created_at).getTime() > STALE_AFTER_MS) {
      return res.json({ ...base, status: "NO_RECENT_DATA", message: "The breaker has not reported in the last 30 seconds" });
    }

    // Only look at what is running NOW: readings since the last power step.
    const recent = recentEventWindow(rows);
    const ev = extractApplianceEvent(recent.rows);
    const window = {
      from: recent.rows.length ? new Date(recent.rows[0].t).toISOString() : null,
      to: new Date(last.created_at).toISOString(),
      samples: recent.rows.length,
      last_step: recent.step,
      last_step_at: recent.step_at,
    };
    if (!ev.ok) {
      const idle = median(rows.slice(-2).map((x) => Number(x.power))) < FEATURE_DEFAULTS.noLoadW;
      if (ev.reason === "NO_LOAD_DETECTED" || idle) return res.json({ ...base, status: "NO_LOAD", reason: ev.reason, window });
      return res.json({ ...base, status: "INSUFFICIENT_DATA", reason: recent.step ? "LOAD_JUST_CHANGED" : ev.reason, window });
    }
    // The appliance found in the window must still be running now.
    const nowPower = median(rows.slice(-2).map((x) => Number(x.power)));
    if (nowPower - ev.baseline_power_w < FEATURE_DEFAULTS.noLoadW) {
      return res.json({ ...base, status: "NO_LOAD", reason: "APPLIANCE_TURNED_OFF", window });
    }

    const p = predictKnn(m.artifact, toVector(ev.features));
    const saved = await pool.query(
      `INSERT INTO ml_predictions (user_id, breaker_id, model_id, appliance_label, confidence, is_unknown, unknown_reason, features, window_from, window_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING id, predicted_at`,
      [req.userId, breakerId, m.id, p.label, p.confidence, p.is_unknown, p.reason, JSON.stringify(ev.features), window.from, window.to]
    );

    return res.json({
      status: "OK",
      prediction_id: String(saved.rows[0].id),
      breaker_id: breakerId,
      appliance_label: p.is_unknown ? "Unknown" : p.label,
      is_unknown: p.is_unknown,
      unknown_reason: p.reason,
      closest_match: p.candidate,
      confidence: p.confidence,
      confidence_method: "knn_vote_share (heuristic agreement of the nearest recordings, not a probability)",
      model_version: m.model_version,
      predicted_at: new Date(saved.rows[0].predicted_at).toISOString(),
      basis: "likely appliance from added power, power factor, power variation and startup spike",
      onset_detected: ev.onset_detected,
      features: ev.features,
      window,
    });
  } catch (err) {
    console.error("Appliance prediction error:", err.message);
    return fail(res, 500, "INTERNAL_ERROR", "Could not predict appliance");
  }
}
router.get("/breakers/:breaker_id/prediction", predictionHandler);
router.get("/devices/:device_id/prediction", predictionHandler);

module.exports = router;
