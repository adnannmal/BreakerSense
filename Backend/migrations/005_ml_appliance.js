// Labeled appliance recordings + appliance classifier (Sprint 3, weeks 1–2).
//   ml_learning_sessions  "appliance X ran on breaker Y from time A to time B"
//   ml_session_readings   PERMANENT copy of those readings (readings_log is pruned after 7 days)
//   ml_models             trained models with their evaluation metrics
//   ml_predictions        what the model said, for later review
// breaker_id has NO foreign key on purpose: labeled training data survives breaker deletion.

module.exports = {
  version: 5,
  name: "ml_appliance",
  async up(db) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ml_learning_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        breaker_id TEXT NOT NULL,
        appliance_label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'RECORDING' CHECK (status IN ('RECORDING', 'COMPLETE', 'DISCARDED')),
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        is_simulated BOOLEAN NOT NULL DEFAULT FALSE,
        notes TEXT,
        sample_count INTEGER NOT NULL DEFAULT 0,
        quality TEXT,
        quality_details JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        CHECK (ended_at IS NULL OR ended_at > started_at)
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS ml_sessions_user_label_idx ON ml_learning_sessions (user_id, appliance_label);`);
    await db.query(`CREATE INDEX IF NOT EXISTS ml_sessions_breaker_time_idx ON ml_learning_sessions (breaker_id, started_at);`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS ml_sessions_one_recording_per_breaker ON ml_learning_sessions (breaker_id) WHERE status = 'RECORDING';`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS ml_session_readings (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES ml_learning_sessions(id) ON DELETE CASCADE,
        source_log_id BIGINT,
        recorded_at TIMESTAMPTZ NOT NULL,
        voltage NUMERIC,
        current NUMERIC,
        power NUMERIC,
        power_factor NUMERIC,
        frequency NUMERIC,
        energy_kwh NUMERIC,
        UNIQUE (session_id, source_log_id)
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS ml_session_readings_session_time_idx ON ml_session_readings (session_id, recorded_at);`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS ml_models (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        model_version TEXT NOT NULL,
        model_type TEXT NOT NULL,
        feature_version TEXT NOT NULL,
        artifact JSONB NOT NULL,
        metrics JSONB NOT NULL,
        dataset JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS ml_models_user_time_idx ON ml_models (user_id, created_at DESC);`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS ml_predictions (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        breaker_id TEXT NOT NULL,
        model_id BIGINT REFERENCES ml_models(id) ON DELETE SET NULL,
        appliance_label TEXT,
        confidence NUMERIC,
        is_unknown BOOLEAN NOT NULL,
        unknown_reason TEXT,
        features JSONB,
        window_from TIMESTAMPTZ,
        window_to TIMESTAMPTZ,
        predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS ml_predictions_breaker_time_idx ON ml_predictions (breaker_id, predicted_at DESC);`);
  },
};
