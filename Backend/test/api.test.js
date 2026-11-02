// Integration tests: real Express app + real Postgres (see helpers.js). Run with: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestEnvironment } = require("./helpers");

let env;
let request;

// Shared fixtures, filled in by the setup steps below.
const alice = { email: "alice@example.com", password: "alice-password" };
const bob = { email: "bob@example.com", password: "bob-password" };
const keys = {};

const PZEM = {
  voltage: 120.4,
  current: 0.509,
  power: 61.3,
  apparent_power: 61.28,
  energy_kwh: 0.004,
  frequency: 60.0,
  power_factor: 1.0,
  contactor_state: "ON",
  sensor_status: "online",
};

before(async () => {
  process.env.RATE_LIMIT_DISABLED = "true";
  env = await startTestEnvironment();
  request = env.request;
});

after(async () => {
  if (env) await env.stop();
});

// ---------------------------------------------------------------- migration / compatibility

test("migration keeps existing devices, readings, history and alerts", async () => {
  const breaker = await env.pool.query(`SELECT * FROM breakers WHERE controller_id = 'legacy-esp32'`);
  assert.equal(breaker.rows.length, 1);
  assert.equal(breaker.rows[0].breaker_id, "breaker-001");
  assert.equal(breaker.rows[0].channel_number, 1);
  assert.equal(breaker.rows[0].voltage, 120.1);
  assert.equal(breaker.rows[0].capacity_amps, 20);

  const log = await env.pool.query(`SELECT breaker_pk FROM readings_log WHERE device_id = 'legacy-esp32'`);
  assert.equal(log.rows.length, 2);
  assert.ok(log.rows.every((r) => r.breaker_pk === breaker.rows[0].id));

  const alerts = await env.pool.query(`SELECT breaker_pk, message FROM alerts WHERE device_id = 'legacy-esp32'`);
  assert.equal(alerts.rows[0].message, "kept");
  assert.equal(alerts.rows[0].breaker_pk, breaker.rows[0].id);

  const readings = await env.pool.query(`SELECT * FROM readings WHERE device_id = 'legacy-esp32'`);
  assert.equal(readings.rows[0].current, 1.5);
});

test("health check and unknown routes", async () => {
  assert.deepEqual((await request("GET", "/health")).body, { status: "ok" });
  const missing = await request("GET", "/api/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "NOT_FOUND");
});

test("register and login keep working (email or username)", async () => {
  for (const user of [alice, bob]) {
    const reg = await request("POST", "/api/auth/register", { body: user });
    assert.equal(reg.status, 201);
    assert.ok(reg.body.token);
    assert.equal(reg.body.email, user.email);
  }
  const dup = await request("POST", "/api/auth/register", { body: alice });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "ACCOUNT_EXISTS");

  const login = await request("POST", "/api/auth/login", { body: { email: "ALICE@example.com", password: alice.password } });
  assert.equal(login.status, 200);
  alice.token = login.body.token;
  bob.token = (await request("POST", "/api/auth/login", { body: { username: bob.email, password: bob.password } })).body.token;

  const wrong = await request("POST", "/api/auth/login", { body: { email: alice.email, password: "nope-nope" } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, "INVALID_CREDENTIALS");
  assert.equal(typeof wrong.body.error, "string");
});

test("JWT: missing, garbage and wrong-algorithm tokens are rejected", async () => {
  assert.equal((await request("GET", "/api/devices")).body.code, "AUTH_REQUIRED");
  assert.equal((await request("GET", "/api/devices", { token: "abc.def.ghi" })).status, 401);
  // alg "none" token for userId 1
  const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url") + "." + Buffer.from('{"userId":1}').toString("base64url") + ".";
  assert.equal((await request("GET", "/api/devices", { token: none })).status, 401);
});

test("device registration returns the key once and creates a channel-1 breaker", async () => {
  const res = await request("POST", "/api/devices", {
    token: alice.token,
    body: { device_id: "esp32-a", nickname: "Garage", capacity_amps: 20 },
  });
  assert.equal(res.status, 201);
  assert.match(res.body.api_key, /^bk_[a-f0-9]{64}$/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(res.body.breakers, [{ breaker_id: "breaker-001", channel_number: 1 }]);
  keys.a = res.body.api_key;

  const b = await request("POST", "/api/devices", { token: alice.token, body: { device_id: "esp32-b", capacity_amps: 15 } });
  keys.b = b.body.api_key;
  const bobDevice = await request("POST", "/api/devices", { token: bob.token, body: { device_id: "esp32-bob" } });
  keys.bob = bobDevice.body.api_key;

  const list = await request("GET", "/api/devices", { token: alice.token });
  assert.deepEqual(list.body.map((d) => d.device_id).sort(), ["esp32-a", "esp32-b"]);
  assert.ok(list.body.every((d) => d.api_key_hash === undefined));

  const dup = await request("POST", "/api/devices", { token: bob.token, body: { device_id: "esp32-a" } });
  assert.equal(dup.status, 409);
  const badId = await request("POST", "/api/devices", { token: bob.token, body: { device_id: "has spaces/slash" } });
  assert.equal(badId.status, 400);
});

// ---------------------------------------------------------------- device authentication

test("the currently verified /readings payload still works and shows on the old dashboard", async () => {
  const res = await request("POST", "/readings", {
    apiKey: keys.a,
    body: { device_id: "esp32-a", voltage: 120.4, current: 0.5, power: 60.2 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.device_id, "esp32-a");
  assert.equal(res.body.voltage, 120.4);
  assert.equal(res.body.breaker_id, "breaker-001");

  const dash = await request("GET", "/api/dashboard/esp32-a?hours=6", { token: alice.token });
  assert.equal(dash.status, 200);
  assert.equal(dash.body.latest.current, 0.5);
  assert.equal(dash.body.history.length, 1);
  assert.equal(dash.body.health.connection, "online");

  const legacy = await request("GET", "/readings/esp32-a", { token: alice.token });
  assert.equal(legacy.body.power, 60.2);
});

test("wrong, malformed and missing API keys are rejected", async () => {
  const body = { device_id: "esp32-a", voltage: 120, current: 1, power: 120 };
  const missing = await request("POST", "/readings", { body });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, "DEVICE_KEY_REQUIRED");

  const wrong = await request("POST", "/readings", { body, apiKey: "bk_" + "0".repeat(64) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, "INVALID_DEVICE_CREDENTIALS");

  const malformed = await request("POST", "/readings", { body, apiKey: "hello" });
  assert.equal(malformed.status, 401);
});

test("a controller cannot post as another controller or to another controller's breaker", async () => {
  // Alice's esp32-a key claiming to be esp32-b
  const asOther = await request("POST", "/readings", { apiKey: keys.a, body: { controller_id: "esp32-b", breaker_id: "breaker-001", voltage: 120 } });
  assert.equal(asOther.status, 403);
  assert.equal(asOther.body.code, "CONTROLLER_MISMATCH");

  const header = await request("POST", "/readings", { apiKey: keys.a, headers: { "X-Controller-Id": "esp32-bob" }, body: { voltage: 120 } });
  assert.equal(header.status, 403);

  // A breaker id that only exists on another controller resolves within the caller's own controller -> 404.
  await request("POST", "/api/controllers/esp32-b/breakers", { token: alice.token, body: { breaker_id: "only-on-b", channel_number: 2 } });
  const foreignBreaker = await request("POST", "/readings", { apiKey: keys.a, body: { breaker_id: "only-on-b", voltage: 120 } });
  assert.equal(foreignBreaker.status, 404);
  assert.equal(foreignBreaker.body.code, "BREAKER_NOT_FOUND");
  const rows = await env.pool.query(
    `SELECT COUNT(*)::int AS n FROM readings_log l JOIN breakers b ON b.id = l.breaker_pk WHERE b.breaker_id = 'only-on-b'`
  );
  assert.equal(rows.rows[0].n, 0);
});

test("key rotation invalidates the old key immediately and is owner-only", async () => {
  const notMine = await request("POST", "/api/devices/esp32-a/rotate-key", { token: bob.token });
  assert.equal(notMine.status, 404);

  const rotated = await request("POST", "/api/devices/esp32-b/rotate-key", { token: alice.token });
  assert.equal(rotated.status, 200);
  const old = await request("POST", "/readings", { apiKey: keys.b, body: { voltage: 120 } });
  assert.equal(old.status, 401);
  keys.b = rotated.body.api_key;
  assert.equal((await request("POST", "/readings", { apiKey: keys.b, body: { voltage: 120 } })).status, 200);
});

// ---------------------------------------------------------------- PZEM data

test("all PZEM values are stored and returned with consistent units", async () => {
  const res = await request("POST", "/readings", { apiKey: keys.a, body: { controller_id: "esp32-a", breaker_id: "breaker-001", ...PZEM } });
  assert.equal(res.status, 200);
  assert.equal(res.body.stored, "measurement");

  const breaker = await request("GET", "/api/controllers/esp32-a/breakers/breaker-001", { token: alice.token });
  assert.equal(breaker.status, 200);
  const { latest } = breaker.body;
  for (const field of ["voltage", "current", "power", "apparent_power", "energy_kwh", "frequency", "power_factor"]) {
    assert.equal(latest[field], PZEM[field], field);
  }
  assert.match(latest.measured_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(breaker.body.reported_contactor_state, "ON");
  assert.equal(breaker.body.health.sensor_status, "online");
  assert.equal(breaker.body.health.connection, "online");

  const history = await request("GET", "/api/controllers/esp32-a/breakers/breaker-001/readings", { token: alice.token });
  const newest = history.body.readings[0];
  for (const field of ["voltage", "current", "power", "apparent_power", "energy_kwh", "frequency", "power_factor"]) {
    assert.equal(newest[field], PZEM[field], field);
  }
});

test("invalid, non-finite, negative and out-of-range readings are rejected and not stored", async () => {
  const before = await env.pool.query(`SELECT COUNT(*)::int AS n FROM readings_log WHERE device_id = 'esp32-a'`);
  const bad = [
    [{ voltage: "abc" }, "voltage", "INVALID_MEASUREMENT"],
    [{ voltage: "Infinity" }, "voltage", "INVALID_MEASUREMENT"],
    [{ current: -0.1 }, "current", "MEASUREMENT_OUT_OF_RANGE"],
    [{ power: 1e9 }, "power", "MEASUREMENT_OUT_OF_RANGE"],
    [{ power_factor: 1.2 }, "power_factor", "MEASUREMENT_OUT_OF_RANGE"],
    [{ frequency: 0 }, "frequency", "MEASUREMENT_OUT_OF_RANGE"],
    [{ voltage: 120, contactor_state: "MAYBE" }, "contactor_state", "INVALID_FIELD"],
    [{ voltage: 120, sensor_status: "great" }, "sensor_status", "INVALID_FIELD"],
  ];
  for (const [body, field, code] of bad) {
    const res = await request("POST", "/readings", { apiKey: keys.a, body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.field, field);
    assert.equal(res.body.code, code);
  }
  const empty = await request("POST", "/readings", { apiKey: keys.a, body: { device_id: "esp32-a" } });
  assert.equal(empty.body.code, "NO_MEASUREMENTS");

  const invalidJson = await request("POST", "/readings", { apiKey: keys.a, body: "{not json" });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.code, "INVALID_JSON");

  const afterCount = await env.pool.query(`SELECT COUNT(*)::int AS n FROM readings_log WHERE device_id = 'esp32-a'`);
  assert.equal(afterCount.rows[0].n, before.rows[0].n);
});

test("a PZEM failure report keeps the last good reading instead of writing zeros", async () => {
  const failure = await request("POST", "/readings", {
    apiKey: keys.a,
    body: { breaker_id: "breaker-001", sensor_status: "error", sensor_error: "PZEM timeout", voltage: null, current: null },
  });
  assert.equal(failure.status, 200);
  assert.equal(failure.body.stored, "status_only");

  const breaker = (await request("GET", "/api/controllers/esp32-a/breakers/breaker-001", { token: alice.token })).body;
  assert.equal(breaker.health.sensor_status, "error");
  assert.equal(breaker.health.sensor_error, "PZEM timeout");
  assert.equal(breaker.latest.voltage, PZEM.voltage);
  assert.equal(breaker.latest.power, PZEM.power);

  const alerts = await request("GET", "/alerts?device_id=esp32-a", { token: alice.token });
  assert.ok(alerts.body.some((a) => a.metric === "sensor" && a.breaker_id === "breaker-001"));

  // Recovery resolves the sensor alert.
  await request("POST", "/readings", { apiKey: keys.a, body: { breaker_id: "breaker-001", ...PZEM } });
  const after = await request("GET", "/alerts?device_id=esp32-a", { token: alice.token });
  assert.ok(!after.body.some((a) => a.metric === "sensor"));
});

test("contactor OFF can show ~120 V upstream with 0 A / 0 W", async () => {
  const res = await request("POST", "/readings", {
    apiKey: keys.a,
    body: { ...PZEM, current: 0, power: 0, apparent_power: 0, power_factor: 0, contactor_state: "OFF" },
  });
  assert.equal(res.status, 200);
  const breaker = (await request("GET", "/api/controllers/esp32-a/breakers/breaker-001", { token: alice.token })).body;
  assert.equal(breaker.latest.voltage, 120.4);
  assert.equal(breaker.latest.current, 0);
  assert.equal(breaker.reported_contactor_state, "OFF");
});

// ---------------------------------------------------------------- multi-breaker / ownership

test("two breakers on one controller and four across two controllers keep separate histories", async () => {
  const add = await request("POST", "/api/controllers/esp32-a/breakers", {
    token: alice.token,
    body: { breaker_id: "breaker-002", channel_number: 2, name: "Dryer", capacity_amps: 30 },
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.thresholds.current, 30);
  const dupChannel = await request("POST", "/api/controllers/esp32-a/breakers", {
    token: alice.token,
    body: { breaker_id: "breaker-003", channel_number: 2 },
  });
  assert.equal(dupChannel.status, 409);

  // esp32-b now has breaker-001 and only-on-b (channel 2)
  const posts = [
    [keys.a, "breaker-001", 1.11],
    [keys.a, "breaker-002", 2.22],
    [keys.b, "breaker-001", 3.33],
    [keys.b, "only-on-b", 4.44],
  ];
  for (const [key, breakerId, current] of posts) {
    const res = await request("POST", "/readings", { apiKey: key, body: { breaker_id: breakerId, voltage: 120, current, power: 120 * current } });
    assert.equal(res.status, 200);
  }

  const latest = async (cid, bid) => (await request("GET", `/api/controllers/${cid}/breakers/${bid}`, { token: alice.token })).body.latest.current;
  assert.equal(await latest("esp32-a", "breaker-001"), 1.11);
  assert.equal(await latest("esp32-a", "breaker-002"), 2.22);
  assert.equal(await latest("esp32-b", "breaker-001"), 3.33);
  assert.equal(await latest("esp32-b", "only-on-b"), 4.44);

  const hist = await request("GET", "/api/controllers/esp32-a/breakers/breaker-002/readings", { token: alice.token });
  assert.deepEqual(hist.body.readings.map((r) => r.current), [2.22]);

  const controllers = await request("GET", "/api/controllers", { token: alice.token });
  const a = controllers.body.controllers.find((c) => c.controller_id === "esp32-a");
  assert.deepEqual(a.breakers.map((b) => b.breaker_id), ["breaker-001", "breaker-002"]);
  assert.equal(a.health.connection, "online");

  // Channel 2 must not leak into the legacy single-breaker dashboard.
  const dash = await request("GET", "/api/dashboard/esp32-a", { token: alice.token });
  assert.equal(dash.body.latest.current, 1.11);
});

test("a user cannot read or control another user's controllers or breakers", async () => {
  const paths = [
    "/api/controllers/esp32-a",
    "/api/controllers/esp32-a/breakers/breaker-001",
    "/api/controllers/esp32-a/breakers/breaker-001/readings",
    "/api/controllers/esp32-a/breakers/breaker-001/energy",
    "/api/controllers/esp32-a/breakers/breaker-001/commands",
    "/api/dashboard/esp32-a",
    "/readings/esp32-a",
  ];
  for (const p of paths) {
    assert.equal((await request("GET", p, { token: bob.token })).status, 404, p);
  }
  const cmd = await request("POST", "/api/controllers/esp32-a/breakers/breaker-001/commands", { token: bob.token, body: { requested_state: "OFF" } });
  assert.equal(cmd.status, 404);
  const addBreaker = await request("POST", "/api/controllers/esp32-a/breakers", { token: bob.token, body: { breaker_id: "x", channel_number: 3 } });
  assert.equal(addBreaker.status, 404);
  const bobList = await request("GET", "/api/controllers", { token: bob.token });
  assert.deepEqual(bobList.body.controllers.map((c) => c.controller_id), ["esp32-bob"]);
  const bobAlerts = await request("GET", "/alerts?device_id=esp32-a", { token: bob.token });
  assert.deepEqual(bobAlerts.body, []);
});

// ---------------------------------------------------------------- history + energy

test("history pagination and bucketed history", async () => {
  // 5 extra rows on breaker-002, 1 second apart
  const breaker = await env.pool.query(`SELECT id FROM breakers WHERE controller_id = 'esp32-a' AND breaker_id = 'breaker-002'`);
  for (let i = 0; i < 5; i++) {
    await env.pool.query(
      `INSERT INTO readings_log (device_id, breaker_pk, current, created_at) VALUES ('esp32-a', $1, $2, NOW() - make_interval(mins => 10, secs => $3))`,
      [breaker.rows[0].id, 10 + i, i]
    );
  }
  const seen = [];
  let cursor = null;
  do {
    const res = await request(
      "GET",
      `/api/controllers/esp32-a/breakers/breaker-002/readings?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      { token: alice.token }
    );
    assert.equal(res.status, 200);
    assert.ok(res.body.readings.length <= 2);
    seen.push(...res.body.readings.map((r) => r.current));
    cursor = res.body.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen).size, 6);

  const buckets = await request("GET", "/api/controllers/esp32-a/breakers/breaker-002/readings?bucket_seconds=3600", { token: alice.token });
  assert.equal(buckets.status, 200);
  assert.ok(buckets.body.buckets.reduce((n, b) => n + b.samples, 0) === 6);

  const badWindow = await request("GET", "/api/controllers/esp32-a/breakers/breaker-002/readings?from=yesterday", { token: alice.token });
  assert.equal(badWindow.status, 400);
  assert.equal(badWindow.body.code, "INVALID_QUERY");
});

test("energy used accounts for PZEM counter resets", async () => {
  const add = await request("POST", "/api/controllers/esp32-b/breakers", { token: alice.token, body: { breaker_id: "meter", channel_number: 3 } });
  assert.equal(add.status, 201);
  // 1.0 -> 1.5 (0.5 used), reset, 0.0 -> 0.2 (0.2 used) => 0.7 kWh, one reset
  for (const energy_kwh of [1.0, 1.5, 0.0, 0.2]) {
    const res = await request("POST", "/readings", { apiKey: keys.b, body: { breaker_id: "meter", voltage: 120, energy_kwh } });
    assert.equal(res.status, 200);
  }
  const energy = await request("GET", "/api/controllers/esp32-b/breakers/meter/energy", { token: alice.token });
  assert.equal(energy.status, 200);
  assert.equal(energy.body.energy_used_kwh, 0.7);
  assert.equal(energy.body.resets_detected, 1);
  assert.equal(energy.body.samples, 4);
});

// ---------------------------------------------------------------- remote commands

async function newCommand(state = "OFF", breakerId = "breaker-001", extra = {}) {
  return request("POST", `/api/controllers/esp32-a/breakers/${breakerId}/commands`, {
    token: alice.token,
    body: { requested_state: state },
    ...extra,
  });
}

test("command: created -> polled -> acknowledged, without claiming physical verification", async () => {
  const created = await newCommand("OFF");
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "pending");
  assert.equal(created.body.physically_verified, false);
  const id = created.body.command_id;

  const status1 = await request("GET", `/api/commands/${id}`, { token: alice.token });
  assert.equal(status1.body.status, "pending");

  const poll = await request("POST", "/api/device/commands/poll", { apiKey: keys.a });
  assert.equal(poll.status, 200);
  assert.equal(poll.body.commands.length, 1);
  assert.equal(poll.body.commands[0].command_id, id);
  assert.equal(poll.body.commands[0].breaker_id, "breaker-001");
  assert.equal(poll.body.commands[0].channel_number, 1);
  assert.ok(poll.body.server_time);

  // Lost response -> the same command comes back on the next poll (firmware dedupes by id).
  const again = await request("POST", "/api/device/commands/poll", { apiKey: keys.a });
  assert.equal(again.body.commands[0].command_id, id);
  assert.equal(again.body.commands[0].delivery_count, 2);

  // Other controllers never see it.
  const other = await request("POST", "/api/device/commands/poll", { apiKey: keys.b });
  assert.deepEqual(other.body.commands, []);
  const foreignAck = await request("POST", `/api/device/commands/${id}/ack`, { apiKey: keys.b, body: { status: "succeeded" } });
  assert.equal(foreignAck.status, 404);

  const ack = await request("POST", `/api/device/commands/${id}/ack`, { apiKey: keys.a, body: { status: "succeeded", contactor_state: "OFF" } });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.status, "succeeded");
  assert.equal(ack.body.duplicate, false);

  const dupAck = await request("POST", `/api/device/commands/${id}/ack`, { apiKey: keys.a, body: { status: "succeeded", contactor_state: "OFF" } });
  assert.equal(dupAck.status, 200);
  assert.equal(dupAck.body.duplicate, true);
  const conflicting = await request("POST", `/api/device/commands/${id}/ack`, { apiKey: keys.a, body: { status: "failed", error: "x" } });
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.body.code, "COMMAND_ALREADY_ACKNOWLEDGED");

  const done = await request("GET", `/api/commands/${id}`, { token: alice.token });
  assert.equal(done.body.status, "succeeded");
  assert.equal(done.body.reported_contactor_state, "OFF");
  assert.equal(done.body.physically_verified, false);
  assert.ok(done.body.acknowledged_at);

  assert.deepEqual((await request("POST", "/api/device/commands/poll", { apiKey: keys.a })).body.commands, []);
  assert.equal((await request("GET", `/api/commands/${id}`, { token: bob.token })).status, 404);
});

test("command: only one in flight per breaker, and Idempotency-Key retries return the same command", async () => {
  const headers = { "Idempotency-Key": "retry-key-0001" };
  const first = await newCommand("ON", "breaker-002", { headers });
  assert.equal(first.status, 201);
  const retry = await newCommand("ON", "breaker-002", { headers });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.command_id, first.body.command_id);

  const reused = await newCommand("OFF", "breaker-002", { headers });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, "IDEMPOTENCY_KEY_REUSED");

  const second = await newCommand("OFF", "breaker-002");
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "COMMAND_IN_PROGRESS");
  assert.equal(second.body.command.command_id, first.body.command_id);

  const breaker = await request("GET", "/api/controllers/esp32-a/breakers/breaker-002", { token: alice.token });
  assert.equal(breaker.body.active_command.command_id, first.body.command_id);

  const failed = await request("POST", `/api/device/commands/${first.body.command_id}/ack`, {
    apiKey: keys.a,
    body: { status: "failed", error: "local interlock: overcurrent latch set" },
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.status, "failed");
  const status = await request("GET", `/api/commands/${first.body.command_id}`, { token: alice.token });
  assert.equal(status.body.error, "local interlock: overcurrent latch set");

  const missingError = await request("POST", `/api/device/commands/${first.body.command_id}/ack`, { apiKey: keys.a, body: { status: "failed" } });
  assert.equal(missingError.status, 400);
});

test("command: expired commands are never delivered after reconnect", async () => {
  const created = await newCommand("OFF");
  assert.equal(created.status, 201);
  // Simulate the controller staying away past the TTL.
  await env.pool.query(`UPDATE commands SET expires_at = NOW() - INTERVAL '1 second' WHERE command_id = $1`, [created.body.command_id]);

  const poll = await request("POST", "/api/device/commands/poll", { apiKey: keys.a });
  assert.deepEqual(poll.body.commands, []);
  const status = await request("GET", `/api/commands/${created.body.command_id}`, { token: alice.token });
  assert.equal(status.body.status, "expired");

  // A new command can now be created for that breaker.
  const next = await newCommand("ON");
  assert.equal(next.status, 201);
  await request("POST", `/api/device/commands/${next.body.command_id}/ack`, { apiKey: keys.a, body: { status: "succeeded" } });
});

test("command: refused when the controller is offline", async () => {
  await env.pool.query(`UPDATE devices SET last_seen = NOW() - INTERVAL '10 minutes' WHERE device_id = 'esp32-a'`);
  const res = await newCommand("OFF");
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "CONTROLLER_OFFLINE");
  const breaker = await request("GET", "/api/controllers/esp32-a/breakers/breaker-001", { token: alice.token });
  // The controller is offline; the breaker row still has its own (older) last_seen.
  assert.ok(["online", "stale", "offline"].includes(breaker.body.health.connection));
  await request("POST", "/readings", { apiKey: keys.a, body: { ...PZEM } }); // reconnect
});

test("command: a tripped breaker cannot be switched ON remotely, but can be switched OFF", async () => {
  const trip = await request("POST", "/readings", { apiKey: keys.a, body: { ...PZEM, current: 0, power: 0, contactor_state: "TRIPPED" } });
  assert.equal(trip.status, 200);
  const alerts = await request("GET", "/alerts?device_id=esp32-a", { token: alice.token });
  assert.ok(alerts.body.some((a) => a.metric === "trip" && a.severity === "High"));

  const on = await newCommand("ON");
  assert.equal(on.status, 409);
  assert.equal(on.body.code, "BREAKER_FAULTED");
  const off = await newCommand("OFF");
  assert.equal(off.status, 201);

  const invalid = await newCommand("TOGGLE");
  assert.equal(invalid.status, 400);
});

// ---------------------------------------------------------------- hardening

test("login is rate limited", async () => {
  process.env.RATE_LIMIT_DISABLED = "false";
  process.env.RATE_LIMIT_AUTH_MAX = "3";
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await request("POST", "/api/auth/login", { body: { email: "nobody@example.com", password: "whatever" } })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  } finally {
    process.env.RATE_LIMIT_DISABLED = "true";
    delete process.env.RATE_LIMIT_AUTH_MAX;
  }
});