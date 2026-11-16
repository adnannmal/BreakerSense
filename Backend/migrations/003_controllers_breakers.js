// Controller / breaker hierarchy (see docs/API_CONTRACT.md, "Identifiers").
//
// Mapping decision:
//   * devices row      = one physical ESP32 CONTROLLER. devices.device_id IS the controller_id.
//                        It keeps the API key hash, owner and legacy status columns, so every
//                        existing route and the live firmware keep working unchanged.
//   * breakers row     = one independently metered/switched CHANNEL of a controller.
//   * Legacy alias     = every existing device gets breaker channel 1 whose breaker_id equals
//                        its device_id (e.g. esp32-1 / esp32-1). Old URLs that use a device_id
//                        therefore address that channel-1 breaker. New channels get their own IDs.
//
// Additive only; existing readings_log / alerts rows are backfilled, never moved or deleted.

module.exports = {
  version: 3,
  name: "controllers_breakers",
  async up(db) {
    for (const col of [
      "last_seen_at TIMESTAMPTZ",
      "firmware_version TEXT",
      "last_sequence BIGINT",
      "key_rotated_at TIMESTAMPTZ",
      "key_revoked_at TIMESTAMPTZ",
    ]) {
      await db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS ${col};`);
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS breakers (
        breaker_id TEXT PRIMARY KEY,
        controller_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
        channel_number INTEGER NOT NULL CHECK (channel_number BETWEEN 1 AND 8),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT,
        location TEXT,
        rated_current_a NUMERIC,
        voltage_threshold NUMERIC,
        current_threshold NUMERIC,
        power_threshold NUMERIC,
        temperature_threshold NUMERIC,
        contactor_state TEXT NOT NULL DEFAULT 'UNKNOWN'
          CHECK (contactor_state IN ('ON', 'OFF', 'TRIPPED', 'UNKNOWN')),
        contactor_state_at TIMESTAMPTZ,
        sensor_status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (sensor_status IN ('online', 'offline', 'error', 'unknown')),
        sensor_status_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (controller_id, channel_number)
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS breakers_user_idx ON breakers (user_id);`);

    // Backfill: channel-1 alias breaker for every existing device.
    await db.query(`
      INSERT INTO breakers (breaker_id, controller_id, channel_number, user_id, name, location, rated_current_a,
                            voltage_threshold, current_threshold, power_threshold, temperature_threshold,
                            contactor_state, created_at)
      SELECT d.device_id, d.device_id, 1, d.user_id, d.nickname, d.location, d.capacity_amps,
             d.voltage_threshold, d.current_threshold, d.power_threshold, d.temperature_threshold,
             CASE WHEN d.status IN ('ON', 'OFF', 'TRIPPED') THEN d.status ELSE 'UNKNOWN' END,
             COALESCE(d.created_at, NOW())
      FROM devices d
      ON CONFLICT DO NOTHING;
    `);

    // Latest good measurement per breaker (status-only/error reports never overwrite it).
    await db.query(`
      CREATE TABLE IF NOT EXISTS breaker_latest (
        breaker_id TEXT PRIMARY KEY REFERENCES breakers(breaker_id) ON DELETE CASCADE,
        voltage NUMERIC,
        current NUMERIC,
        power NUMERIC,
        apparent_power NUMERIC,
        power_factor NUMERIC,
        frequency NUMERIC,
        energy_kwh NUMERIC,
        temperature NUMERIC,
        measured_at TIMESTAMPTZ NOT NULL,
        device_recorded_at TIMESTAMPTZ,
        sequence BIGINT
      );
    `);
    await db.query(`
      INSERT INTO breaker_latest (breaker_id, voltage, current, power, temperature, measured_at)
      SELECT r.device_id, r.voltage, r.current, r.power, r.temperature, COALESCE(r.updated_at, NOW())
      FROM readings r JOIN breakers b ON b.breaker_id = r.device_id
      ON CONFLICT DO NOTHING;
    `);

    // History rows now say which breaker (channel) they belong to.
    await db.query(`ALTER TABLE readings_log ADD COLUMN IF NOT EXISTS breaker_id TEXT REFERENCES breakers(breaker_id) ON DELETE CASCADE;`);
    await db.query(`ALTER TABLE readings_log ADD COLUMN IF NOT EXISTS channel_number INTEGER;`);
    await db.query(`ALTER TABLE readings_log ADD COLUMN IF NOT EXISTS sequence BIGINT;`);
    await db.query(`ALTER TABLE readings_log ADD COLUMN IF NOT EXISTS device_recorded_at TIMESTAMPTZ;`);
    await db.query(`
      UPDATE readings_log SET breaker_id = device_id, channel_number = 1
      WHERE breaker_id IS NULL AND device_id IN (SELECT breaker_id FROM breakers);
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS readings_log_breaker_time_idx ON readings_log (breaker_id, created_at DESC);`);
    await db.query(`CREATE INDEX IF NOT EXISTS readings_log_time_idx ON readings_log (created_at);`);

    await db.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS breaker_id TEXT REFERENCES breakers(breaker_id) ON DELETE CASCADE;`);
    await db.query(`UPDATE alerts SET breaker_id = device_id WHERE breaker_id IS NULL AND device_id IN (SELECT breaker_id FROM breakers);`);
    await db.query(`CREATE INDEX IF NOT EXISTS alerts_breaker_metric_idx ON alerts (breaker_id, metric) WHERE resolved = FALSE;`);
  },
};
