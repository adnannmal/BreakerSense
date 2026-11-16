
 // Migration 3: controller and breaker channel support.
 // Compatible with older BreakerSense databases.
 //
 // Preserves existing breakers, users, devices and readings.
 // The migration runner wraps all changes in a transaction.

async function requireNoRows(db, message, sql) {
  const result = await db.query(sql);

  if (result.rows.length > 0) {
    throw new Error(message);
  }
}

module.exports = {
  version: 3,
  name: "controllers_breakers",

  async up(db) {

    // ============================================
    // 1. Update existing ESP32 controller records
    // ============================================

    for (const col of [
      "last_seen_at TIMESTAMPTZ",
      "firmware_version TEXT",
      "last_sequence BIGINT",
      "key_rotated_at TIMESTAMPTZ",
      "key_revoked_at TIMESTAMPTZ",
    ]) {
      await db.query(
        `ALTER TABLE devices ADD COLUMN IF NOT EXISTS ${col};`
      );
    }

    // ============================================
    // 2. Create breakers table if it doesn't exist
    // ============================================

    await db.query(`
      CREATE TABLE IF NOT EXISTS breakers (
        breaker_id TEXT PRIMARY KEY,
        controller_id TEXT NOT NULL
          REFERENCES devices(device_id) ON DELETE CASCADE,
        channel_number INTEGER NOT NULL
          CHECK (channel_number BETWEEN 1 AND 8),
        user_id INTEGER NOT NULL
          REFERENCES users(id) ON DELETE CASCADE,
        name TEXT,
        location TEXT,
        rated_current_a NUMERIC,
        voltage_threshold NUMERIC,
        current_threshold NUMERIC,
        power_threshold NUMERIC,
        temperature_threshold NUMERIC,
        contactor_state TEXT NOT NULL DEFAULT 'UNKNOWN',
        contactor_state_at TIMESTAMPTZ,
        sensor_status TEXT NOT NULL DEFAULT 'unknown',
        sensor_status_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (controller_id, channel_number)
      );
    `);

    // ============================================
    // 3. Add columns missing from Railway database
    // ============================================

    for (const col of [
      "user_id INTEGER",
      "location TEXT",
      "rated_current_a NUMERIC",
      "contactor_state_at TIMESTAMPTZ",
      "sensor_status_at TIMESTAMPTZ",
      "last_seen_at TIMESTAMPTZ",
      "updated_at TIMESTAMPTZ DEFAULT NOW()",
    ]) {
      await db.query(
        `ALTER TABLE breakers ADD COLUMN IF NOT EXISTS ${col};`
      );
    }

    // ============================================
    // 4. Restore breaker ownership
    // ============================================

    // Use the existing registered controller's owner.
    // Never create fake users or assign random owners.

    await db.query(`
      UPDATE breakers AS b
      SET user_id = d.user_id
      FROM devices AS d
      WHERE b.controller_id = d.device_id
        AND b.user_id IS DISTINCT FROM d.user_id;
    `);

    // ============================================
    // 5. Check existing data before adding constraints
    // ============================================

    await requireNoRows(
      db,
      "Existing breakers have missing breaker_id values.",
      `
        SELECT 1 FROM breakers
        WHERE breaker_id IS NULL
           OR btrim(breaker_id) = ''
        LIMIT 1;
      `
    );

    await requireNoRows(
      db,
      "Some breakers have no registered controller.",
      `
        SELECT 1 FROM breakers b
        LEFT JOIN devices d
          ON d.device_id = b.controller_id
        WHERE d.device_id IS NULL
        LIMIT 1;
      `
    );

    await requireNoRows(
      db,
      "Some breakers have no user_id after ownership backfill.",
      `
        SELECT 1 FROM breakers
        WHERE user_id IS NULL
        LIMIT 1;
      `
    );

    await requireNoRows(
      db,
      "Some channel numbers are missing or outside 1-8.",
      `
        SELECT 1 FROM breakers
        WHERE channel_number IS NULL
           OR channel_number NOT BETWEEN 1 AND 8
        LIMIT 1;
      `
    );

    await requireNoRows(
      db,
      "Duplicate breaker_id values exist.",
      `
        SELECT 1 FROM breakers
        GROUP BY breaker_id
        HAVING COUNT(*) > 1
        LIMIT 1;
      `
    );

    await requireNoRows(
      db,
      "Duplicate controller and channel assignments exist.",
      `
        SELECT 1 FROM breakers
        GROUP BY controller_id, channel_number
        HAVING COUNT(*) > 1
        LIMIT 1;
      `
    );

    // ============================================
    // 6. Create required indexes
    // ============================================

    // Older tables may use a bigint id as their
    // primary key. Preserve it, and make breaker_id
    // unique so the new tables can reference it.

    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      breakers_bs_breaker_id_unique
      ON breakers (breaker_id);
    `);

    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      breakers_bs_controller_channel_unique
      ON breakers (controller_id, channel_number);
    `);

    await db.query(`
      ALTER TABLE breakers
      ALTER COLUMN user_id SET NOT NULL;
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS breakers_user_idx
      ON breakers (user_id);
    `);

    // ============================================
    // 7. Preserve existing ESP32 device mappings
    // ============================================

    // Each existing ESP32 receives a channel-1 alias.
    // Existing channel assignments are not overwritten.

    await db.query(`
      INSERT INTO breakers (
        breaker_id,
        controller_id,
        channel_number,
        user_id,
        name,
        location,
        rated_current_a,
        voltage_threshold,
        current_threshold,
        power_threshold,
        temperature_threshold,
        contactor_state,
        created_at
      )
      SELECT
        d.device_id,
        d.device_id,
        1,
        d.user_id,
        d.nickname,
        d.location,
        d.capacity_amps,
        d.voltage_threshold,
        d.current_threshold,
        d.power_threshold,
        d.temperature_threshold,
        CASE
          WHEN d.status IN ('ON', 'OFF', 'TRIPPED')
          THEN d.status
          ELSE 'UNKNOWN'
        END,
        COALESCE(d.created_at, NOW())
      FROM devices d
      ON CONFLICT DO NOTHING;
    `);

    await requireNoRows(
      db,
      "Existing channel-1 breaker IDs conflict with the legacy mapping.",
      `
        SELECT 1 FROM breakers
        WHERE channel_number = 1
          AND breaker_id <> controller_id
        LIMIT 1;
      `
    );

    // ============================================
    // 8. Store latest measurement per breaker
    // ============================================

    await db.query(`
      CREATE TABLE IF NOT EXISTS breaker_latest (
        breaker_id TEXT PRIMARY KEY
          REFERENCES breakers(breaker_id) ON DELETE CASCADE,
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

    // Preserve existing single-device readings.

    await db.query(`
      INSERT INTO breaker_latest (
        breaker_id,
        voltage,
        current,
        power,
        temperature,
        measured_at
      )
      SELECT
        r.device_id,
        r.voltage,
        r.current,
        r.power,
        r.temperature,
        COALESCE(r.updated_at, NOW())
      FROM readings r
      JOIN breakers b
        ON b.breaker_id = r.device_id
      ON CONFLICT DO NOTHING;
    `);

    // ============================================
    // 9. Update historical readings
    // ============================================

    await db.query(`
      ALTER TABLE readings_log
      ADD COLUMN IF NOT EXISTS breaker_id TEXT
      REFERENCES breakers(breaker_id) ON DELETE CASCADE;
    `);

    await db.query(`
      ALTER TABLE readings_log
      ADD COLUMN IF NOT EXISTS channel_number INTEGER;
    `);

    await db.query(`
      ALTER TABLE readings_log
      ADD COLUMN IF NOT EXISTS sequence BIGINT;
    `);

    await db.query(`
      ALTER TABLE readings_log
      ADD COLUMN IF NOT EXISTS device_recorded_at TIMESTAMPTZ;
    `);

    await db.query(`
      UPDATE readings_log
      SET breaker_id = device_id,
          channel_number = 1
      WHERE breaker_id IS NULL
        AND device_id IN (
          SELECT breaker_id FROM breakers
        );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS
      readings_log_breaker_time_idx
      ON readings_log (breaker_id, created_at DESC);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS
      readings_log_time_idx
      ON readings_log (created_at);
    `);

    // ============================================
    // 10. Update alerts
    // ============================================

    await db.query(`
      ALTER TABLE alerts
      ADD COLUMN IF NOT EXISTS breaker_id TEXT
      REFERENCES breakers(breaker_id) ON DELETE CASCADE;
    `);

    await db.query(`
      UPDATE alerts
      SET breaker_id = device_id
      WHERE breaker_id IS NULL
        AND device_id IN (
          SELECT breaker_id FROM breakers
        );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS
      alerts_breaker_metric_idx
      ON alerts (breaker_id, metric)
      WHERE resolved = FALSE;
    `);
  },
};
