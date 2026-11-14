// The schema the backend had before versioned migrations (the old initDb()).
// Every statement is IF NOT EXISTS, so on the existing Railway database this is a no-op that
// simply gets recorded as version 1.

module.exports = {
  version: 1,
  name: "baseline",
  async up(db) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        nickname TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    for (const col of [
      "voltage_threshold NUMERIC",
      "current_threshold NUMERIC",
      "power_threshold NUMERIC",
      "status TEXT DEFAULT 'OFF'",
      "requested_status TEXT",
      "command_expires_at TIMESTAMPTZ",
      "location TEXT",
      "capacity_amps NUMERIC",
      "temperature_threshold NUMERIC",
      "api_key_hash TEXT",
    ]) {
      await db.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS ${col};`);
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        device_id TEXT REFERENCES devices(device_id) ON DELETE CASCADE,
        message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved BOOLEAN DEFAULT FALSE
      );
    `);
    await db.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS title TEXT;`);
    await db.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'Medium';`);
    await db.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS metric TEXT;`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS readings (
        device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
        voltage NUMERIC,
        current NUMERIC,
        power NUMERIC,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await db.query(`ALTER TABLE readings ADD COLUMN IF NOT EXISTS temperature NUMERIC;`);

    await db.query(`
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
    await db.query(
      `CREATE INDEX IF NOT EXISTS readings_log_device_time_idx ON readings_log (device_id, created_at DESC);`
    );
  },
};
