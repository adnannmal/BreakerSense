const { Pool, types } = require("pg");

// Postgres NUMERIC columns come back from node-pg as STRINGS ("237.4") by default.
// Parse them as real numbers so the frontend gets 237.4 instead of "237.4".
// (1700 is the Postgres type id for NUMERIC.)
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));
// BIGINT / BIGSERIAL (type 20) ids also come back as strings; our ids stay far below 2^53.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

// SSL: Railway's *internal* URL (postgres.railway.internal) and a local Postgres don't use SSL;
// Railway's *public* proxy URL does. Decide from the hostname instead of NODE_ENV, because
// NODE_ENV isn't reliably "production" on Railway. Override with PGSSL=true / PGSSL=false.
function useSsl(connectionString) {
  if (process.env.PGSSL === "true") return true;
  if (process.env.PGSSL === "false") return false;
  if (!connectionString) return false;
  try {
    const host = new URL(connectionString).hostname;
    return !(host === "localhost" || host === "127.0.0.1" || host.endsWith(".railway.internal"));
  } catch {
    return false;
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
});

// An idle client losing its connection emits 'error' on the pool; without a listener
// that event crashes the whole process.
pool.on("error", (err) => console.error("Postgres pool error:", err.message));

// ---------------------------------------------------------------------------
// Data model (see docs/API_CONTRACT.md "Identifiers"):
//
//   devices   = CONTROLLERS (one row per physical ESP32). devices.device_id IS the
//               controller_id. Kept under its old name so existing rows, API keys,
//               the ESP32's current payload and the frontend keep working.
//   breakers  = individually monitored/controlled channels on a controller
//               (one PZEM + one contactor each). Addressed by (controller_id, breaker_id).
//   readings_log = per-breaker history (breaker_pk). Legacy rows are backfilled to
//               the controller's channel-1 breaker.
//   readings  = LEGACY "latest value per device" table, still updated from channel 1
//               so GET /api/dashboard/:device_id keeps working.
//   commands  = remote ON/OFF requests and their delivery/acknowledgement lifecycle.
// ---------------------------------------------------------------------------
async function initDb() {
  // ---- Original schema (idempotent; unchanged so existing databases are untouched) ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS voltage_threshold NUMERIC;`);
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS current_threshold NUMERIC;`);
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS power_threshold NUMERIC;`);
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'OFF';`);
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS location TEXT;`);
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS capacity_amps NUMERIC;`);
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS temperature_threshold NUMERIC;`);
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS api_key_hash TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      device_id TEXT REFERENCES devices(device_id) ON DELETE CASCADE,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved BOOLEAN DEFAULT FALSE
    );
  `);
  await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS title TEXT;`);
  await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'Medium';`);
  await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS metric TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS readings (
      device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
      voltage NUMERIC,
      current NUMERIC,
      power NUMERIC,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE readings ADD COLUMN IF NOT EXISTS temperature NUMERIC;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS readings_log (
      id BIGSERIAL PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      voltage NUMERIC,
      current NUMERIC,
      power NUMERIC,
      temperature NUMERIC,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS readings_log_device_time_idx ON readings_log (device_id, created_at DESC);`
  );

  // ---- Additive migrations, each applied exactly once ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  for (const migration of MIGRATIONS) {
    await applyMigration(migration);
  }

  console.log("Database tables ready");
}

async function applyMigration({ id, statements }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock so two instances starting at once can't apply the same migration twice.
    await client.query("LOCK TABLE schema_migrations IN EXCLUSIVE MODE");
    const done = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [id]);
    if (done.rows.length === 0) {
      for (const sql of statements) await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
      console.log(`Applied migration ${id}`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS = [
  {
    id: "001_controllers_breakers",
    statements: [
      // Controllers: connection tracking + fast key lookup (each key hash is unique).
      `ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ`,
      `CREATE UNIQUE INDEX IF NOT EXISTS devices_api_key_hash_idx ON devices (api_key_hash) WHERE api_key_hash IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id)`,

      `CREATE TABLE IF NOT EXISTS breakers (
        id BIGSERIAL PRIMARY KEY,
        controller_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
        breaker_id TEXT NOT NULL,
        channel_number INTEGER NOT NULL CHECK (channel_number >= 1),
        name TEXT,
        capacity_amps NUMERIC,
        voltage_threshold NUMERIC,
        current_threshold NUMERIC,
        power_threshold NUMERIC,
        temperature_threshold NUMERIC,
        -- What the firmware last REPORTED (commanded state, not independent hardware feedback).
        contactor_state TEXT CHECK (contactor_state IN ('ON', 'OFF', 'TRIPPED', 'UNKNOWN')),
        sensor_status TEXT CHECK (sensor_status IN ('online', 'offline', 'error')),
        sensor_error TEXT,
        last_seen TIMESTAMPTZ,
        -- Last GOOD measurement. Never overwritten by sensor-error reports.
        voltage NUMERIC,
        current NUMERIC,
        power NUMERIC,
        apparent_power NUMERIC,
        energy_kwh NUMERIC,
        frequency NUMERIC,
        power_factor NUMERIC,
        temperature NUMERIC,
        last_good_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (controller_id, breaker_id),
        UNIQUE (controller_id, channel_number)
      )`,

      // Every existing device becomes a controller with one channel-1 breaker carrying its
      // capacity/thresholds and its latest reading, so nothing visible changes.
      `INSERT INTO breakers (controller_id, breaker_id, channel_number, name, capacity_amps,
                             voltage_threshold, current_threshold, power_threshold, temperature_threshold,
                             voltage, current, power, temperature, last_good_at, last_seen, sensor_status)
       SELECT d.device_id, 'breaker-001', 1, d.nickname, d.capacity_amps,
              d.voltage_threshold, d.current_threshold, d.power_threshold, d.temperature_threshold,
              r.voltage, r.current, r.power, r.temperature, r.updated_at, r.updated_at,
              CASE WHEN r.device_id IS NULL THEN NULL ELSE 'online' END
       FROM devices d
       LEFT JOIN readings r ON r.device_id = d.device_id
       WHERE NOT EXISTS (SELECT 1 FROM breakers b WHERE b.controller_id = d.device_id)`,
      `UPDATE devices d SET last_seen = r.updated_at FROM readings r WHERE r.device_id = d.device_id AND d.last_seen IS NULL`,

      // Per-breaker history with the PZEM fields.
      `ALTER TABLE readings_log ADD COLUMN IF NOT EXISTS breaker_pk BIGINT REFERENCES breakers(id) ON DELETE CASCADE`,
      `ALTER TABLE readings_log ADD COLUMN IF NOT EXISTS apparent_power NUMERIC`,
      `ALTER TABLE readings_log ADD COLUMN IF NOT EXISTS energy_kwh NUMERIC`,
      `ALTER TABLE readings_log ADD COLUMN IF NOT EXISTS frequency NUMERIC`,
      `ALTER TABLE readings_log ADD COLUMN IF NOT EXISTS power_factor NUMERIC`,
      `UPDATE readings_log l SET breaker_pk = b.id
       FROM breakers b
       WHERE l.breaker_pk IS NULL AND b.controller_id = l.device_id AND b.channel_number = 1`,
      `CREATE INDEX IF NOT EXISTS readings_log_breaker_time_idx ON readings_log (breaker_pk, created_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS readings_log_time_idx ON readings_log (created_at)`,

      `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS breaker_pk BIGINT REFERENCES breakers(id) ON DELETE CASCADE`,
      `UPDATE alerts a SET breaker_pk = b.id
       FROM breakers b
       WHERE a.breaker_pk IS NULL AND b.controller_id = a.device_id AND b.channel_number = 1`,
      `CREATE INDEX IF NOT EXISTS alerts_breaker_open_idx ON alerts (breaker_pk, metric) WHERE resolved = FALSE`,

      `CREATE TABLE IF NOT EXISTS commands (
        command_id UUID PRIMARY KEY,
        breaker_pk BIGINT NOT NULL REFERENCES breakers(id) ON DELETE CASCADE,
        controller_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
        requested_state TEXT NOT NULL CHECK (requested_state IN ('ON', 'OFF')),
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        idempotency_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'delivered', 'succeeded', 'failed', 'expired')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        delivered_at TIMESTAMPTZ,
        delivery_count INTEGER NOT NULL DEFAULT 0,
        acknowledged_at TIMESTAMPTZ,
        reported_contactor_state TEXT,
        error TEXT,
        UNIQUE (requested_by, idempotency_key)
      )`,
      `CREATE INDEX IF NOT EXISTS commands_controller_status_idx ON commands (controller_id, status, created_at)`,
      `CREATE INDEX IF NOT EXISTS commands_breaker_time_idx ON commands (breaker_pk, created_at DESC)`,
      // At most one in-flight command per breaker, enforced by the database.
      `CREATE UNIQUE INDEX IF NOT EXISTS commands_one_active_per_breaker
         ON commands (breaker_pk) WHERE status IN ('pending', 'delivered')`,
    ],
  },
];

// Delete history older than READINGS_RETENTION_DAYS (default 7). At one report every
// 3 s that is ~200k rows per breaker per week.
async function pruneReadingsLog() {
  const days = Number(process.env.READINGS_RETENTION_DAYS) > 0 ? Number(process.env.READINGS_RETENTION_DAYS) : 7;
  const result = await pool.query(
    `DELETE FROM readings_log WHERE created_at < NOW() - make_interval(days => $1::int)`,
    [Math.floor(days)]
  );
  return result.rowCount;
}

module.exports = { pool, initDb, pruneReadingsLog };