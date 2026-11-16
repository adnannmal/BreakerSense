// Migrating a database in the CURRENT production shape (old initDb schema + data) keeps every
// record, backfills the controller/breaker mapping, and the live device keeps working.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startHarness } = require("../../test-support/harness");
const { generateDeviceKey, hashDeviceKey } = require("../../security/deviceKeys");

let h;
const key = generateDeviceKey();

// Exactly what the old db.js initDb() created.
const OLD_SCHEMA = [
  `CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE TABLE devices (device_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, nickname TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`,
  `ALTER TABLE devices ADD COLUMN voltage_threshold NUMERIC, ADD COLUMN current_threshold NUMERIC, ADD COLUMN power_threshold NUMERIC,
     ADD COLUMN status TEXT DEFAULT 'OFF', ADD COLUMN requested_status TEXT, ADD COLUMN command_expires_at TIMESTAMPTZ,
     ADD COLUMN location TEXT, ADD COLUMN capacity_amps NUMERIC, ADD COLUMN temperature_threshold NUMERIC, ADD COLUMN api_key_hash TEXT`,
  `CREATE TABLE alerts (id SERIAL PRIMARY KEY, device_id TEXT REFERENCES devices(device_id) ON DELETE CASCADE, message TEXT,
     created_at TIMESTAMPTZ DEFAULT NOW(), resolved BOOLEAN DEFAULT FALSE, title TEXT, severity TEXT DEFAULT 'Medium', metric TEXT)`,
  `CREATE TABLE readings (device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE, voltage NUMERIC, current NUMERIC,
     power NUMERIC, updated_at TIMESTAMPTZ DEFAULT NOW(), temperature NUMERIC)`,
  `CREATE TABLE readings_log (id BIGSERIAL PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
     voltage NUMERIC, current NUMERIC, power NUMERIC, temperature NUMERIC, created_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE INDEX readings_log_device_time_idx ON readings_log (device_id, created_at DESC)`,
];

before(async () => {
  h = await startHarness({ migrate: false });
  for (const sql of OLD_SCHEMA) await h.q(sql);
  const hash = await bcrypt.hash("old-account-pw", 10);
  await h.q(`INSERT INTO users (username, password_hash) VALUES ('legacy@x.test', $1)`, [hash]);
  await h.q(
    `INSERT INTO devices (device_id, user_id, nickname, status, capacity_amps, current_threshold, voltage_threshold, api_key_hash)
     VALUES ('esp32-1', 1, 'Living Room', 'ON', 20, 20, 264, $1), ('esp32-nokey', 1, NULL, 'OFF', NULL, NULL, NULL, NULL)`,
    [hashDeviceKey(key)]
  );
  await h.q(`INSERT INTO readings (device_id, voltage, current, power) VALUES ('esp32-1', 120.4, 0.5, 60.2)`);
  for (let i = 0; i < 5; i++) {
    await h.q(`INSERT INTO readings_log (device_id, voltage, current, power, created_at) VALUES ('esp32-1', 120, $1, $2, NOW() - make_interval(mins => $3))`, [0.5 + i, 60 + i, 10 - i]);
  }
  await h.q(`INSERT INTO alerts (device_id, message, title, metric, resolved) VALUES ('esp32-1', 'old', 'Current above threshold', 'current', TRUE)`);
  await h.runMigrations();
});
after(async () => h && h.close());

test("all versions applied once; re-running is a no-op", async () => {
  const v = await h.q(`SELECT version FROM schema_migrations ORDER BY version`);
  assert.deepEqual(v.map((r) => r.version), [1, 2, 3, 4, 5]);
  assert.deepEqual(await h.runMigrations(), []);
});

test("no records lost; mapping backfilled", async () => {
  assert.equal((await h.q(`SELECT COUNT(*)::int n FROM readings_log`))[0].n, 5);
  assert.equal((await h.q(`SELECT COUNT(*)::int n FROM readings_log WHERE breaker_id = 'esp32-1' AND channel_number = 1`))[0].n, 5);
  assert.equal((await h.q(`SELECT breaker_id FROM alerts`))[0].breaker_id, "esp32-1");

  const breakers = await h.q(`SELECT breaker_id, controller_id, channel_number, name, contactor_state, current_threshold FROM breakers ORDER BY breaker_id`);
  assert.deepEqual(breakers, [
    { breaker_id: "esp32-1", controller_id: "esp32-1", channel_number: 1, name: "Living Room", contactor_state: "ON", current_threshold: 20 },
    { breaker_id: "esp32-nokey", controller_id: "esp32-nokey", channel_number: 1, name: null, contactor_state: "OFF", current_threshold: null },
  ]);
  const latest = await h.q(`SELECT voltage, power FROM breaker_latest WHERE breaker_id = 'esp32-1'`);
  assert.deepEqual(latest, [{ voltage: 120.4, power: 60.2 }]);
  assert.equal((await h.q(`SELECT api_key_hash FROM devices WHERE device_id = 'esp32-1'`))[0].api_key_hash, hashDeviceKey(key));
});

test("existing account, device key and dashboard keep working after migration", async () => {
  const login = await h.request("POST", "/api/auth/login", { body: { email: "legacy@x.test", password: "old-account-pw" } });
  assert.equal(login.status, 200, "6-char-era accounts can still log in");
  const token = login.body.token;

  const up = await h.sendReading(key, { device_id: "esp32-1", voltage: 120.2, current: 0.51, power: 61 });
  assert.equal(up.status, 200);

  const dash = await h.request("GET", "/api/dashboard/esp32-1", { token });
  assert.equal(dash.status, 200);
  assert.equal(dash.body.latest.power, 61);
  assert.ok(dash.body.history.length >= 2, "old + new history visible");
  const hist = await h.request("GET", "/api/breakers/esp32-1/readings?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z", { token }).catch(() => null);
  assert.equal(hist.status, 400, "31-day range cap");
  const recent = await h.request("GET", "/api/breakers/esp32-1/readings", { token });
  assert.equal(recent.body.count, 6);

  // device without a key cannot post
  assert.equal((await h.sendReading(key, { device_id: "esp32-nokey", voltage: 120 })).status, 401);
});
