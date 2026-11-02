// Test harness: a throwaway Postgres + the real Express app on a random port.
//
// By default it starts a private Postgres with the `embedded-postgres` dev dependency (no
// install needed). To use your own instead, set TEST_DATABASE_URL to an EMPTY database whose
// name contains "test" — the harness wipes its public schema first.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { Client } = require("pg");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// The schema exactly as the ORIGINAL backend created it, plus some data, so the tests prove
// the migration keeps existing records.
async function seedLegacyDatabase(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`
    CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE devices (device_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, nickname TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
      voltage_threshold NUMERIC, current_threshold NUMERIC, power_threshold NUMERIC, status TEXT DEFAULT 'OFF', location TEXT,
      capacity_amps NUMERIC, temperature_threshold NUMERIC, api_key_hash TEXT);
    CREATE TABLE alerts (id SERIAL PRIMARY KEY, device_id TEXT REFERENCES devices(device_id) ON DELETE CASCADE, message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), resolved BOOLEAN DEFAULT FALSE, title TEXT, severity TEXT DEFAULT 'Medium', metric TEXT);
    CREATE TABLE readings (device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE, voltage NUMERIC, current NUMERIC,
      power NUMERIC, updated_at TIMESTAMPTZ DEFAULT NOW(), temperature NUMERIC);
    CREATE TABLE readings_log (id BIGSERIAL PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      voltage NUMERIC, current NUMERIC, power NUMERIC, temperature NUMERIC, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE INDEX readings_log_device_time_idx ON readings_log (device_id, created_at DESC);

    INSERT INTO users (username, password_hash) VALUES ('legacy@example.com', 'not-a-real-hash');
    INSERT INTO devices (device_id, user_id, nickname, capacity_amps, current_threshold, voltage_threshold, temperature_threshold)
      VALUES ('legacy-esp32', 1, 'Old kitchen', 20, 20, 264, 60);
    INSERT INTO readings (device_id, voltage, current, power) VALUES ('legacy-esp32', 120.1, 1.5, 180);
    INSERT INTO readings_log (device_id, voltage, current, power, created_at) VALUES
      ('legacy-esp32', 120.0, 1.4, 168, NOW() - INTERVAL '10 minutes'),
      ('legacy-esp32', 120.1, 1.5, 180, NOW() - INTERVAL '5 minutes');
    INSERT INTO alerts (device_id, title, message, metric) VALUES ('legacy-esp32', 'Old alert', 'kept', 'current');
  `);
  await client.end();
}

async function startTestEnvironment() {
  let embedded = null;
  let url = process.env.TEST_DATABASE_URL;

  if (url) {
    if (!/test/i.test(new URL(url).pathname)) {
      throw new Error("TEST_DATABASE_URL must point at a database whose name contains 'test' (it gets wiped)");
    }
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await client.end();
  } else {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-pg-"));
    embedded = new EmbeddedPostgres({
      databaseDir: dir,
      user: "postgres",
      password: "test-only-password",
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase("breakersense_test");
    url = `postgresql://postgres:test-only-password@127.0.0.1:${port}/breakersense_test`;
  }

  await seedLegacyDatabase(url);

  // Configure BEFORE requiring the app: db.js builds its pool from these at load time.
  process.env.DATABASE_URL = url;
  process.env.PGSSL = "false";
  process.env.JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
  process.env.COMMAND_TTL_SECONDS = "30";

  const { initDb, pool } = require("../db");
  const { createApp } = require("../app");
  await initDb();

  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, urlPath, { body, token, apiKey, headers = {} } = {}) {
    const res = await fetch(base + urlPath, {
      method,
      headers: {
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(apiKey && { "X-API-Key": apiKey }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    if (embedded) await embedded.stop();
  }

  return { base, request, pool, stop };
}

module.exports = { startTestEnvironment };