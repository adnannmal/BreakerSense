const { Pool, types } = require("pg");

// Postgres NUMERIC columns come back from node-pg as STRINGS ("237.4") by default.
// Parse them as real numbers so the frontend gets 237.4 instead of "237.4".
// (1700 is the Postgres type id for NUMERIC.)
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

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

// One row per device in `readings` — every new reading overwrites the previous one
// ("what's happening right now"). `readings_log` is the append-only history table
// that powers the dashboard's "Current draw trend" chart and the uptime number.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // A device is "claimed" by whichever user registers its device_id first.
  // The ESP32 itself never logs in — it just posts to /readings with a
  // device_id. That device_id has to already be registered to a user
  // for the reading to be accepted, which is what scopes data per account.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Thresholds
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS voltage_threshold NUMERIC;`);
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS current_threshold NUMERIC;`);
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS power_threshold NUMERIC;`);

  // Status (ON / OFF / TRIPPED).
  // FIX: this used to be DEFAULT "OFF" with double quotes — in Postgres double quotes mean
  // "a column named OFF", so the ALTER failed and initDb() crashed the server on startup.
  // String literals use single quotes.
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'OFF';`);

  // NEW — fields the frontend's "Add breaker" form collects / the sensor cards show
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS location TEXT;`);          // "Panel A / Line 01"
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS capacity_amps NUMERIC;`);  // "Capacity (amps)"
  await pool.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS temperature_threshold NUMERIC;`); // Temperature sensor card

  // Notifications
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      device_id TEXT REFERENCES devices(device_id) ON DELETE CASCADE,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved BOOLEAN DEFAULT FALSE
    );
  `);
  // NEW — the frontend alert rows show a title, a detail line and a severity pill.
  // `message` is the detail line; `metric` lets us avoid duplicate alerts and auto-resolve
  // an alert once that metric goes back to normal.
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
  // NEW — the Temperature sensor card
  await pool.query(`ALTER TABLE readings ADD COLUMN IF NOT EXISTS temperature NUMERIC;`);

  // NEW — append-only history (one row per POST /readings) for the trend chart + uptime.
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

  console.log("Database tables ready");
}

module.exports = { pool, initDb };
