// Existing (pre-Sprint-2) flows keep working: auth, device registration, POST /readings,
// GET /readings, dashboard, alerts, legacy ON/OFF commands, plus the new DELETE/PATCH device.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness } = require("../../test-support/harness");

let h;
before(async () => (h = await startHarness()));
after(async () => h && h.close());

test("register + login (email lower-cased, 8-char minimum, duplicate 409)", async () => {
  const short = await h.request("POST", "/api/auth/register", { body: { email: "a@x.test", password: "short" } });
  assert.equal(short.status, 400);

  const reg = await h.request("POST", "/api/auth/register", { body: { email: "Mixed@X.test", password: "long-enough-pw" } });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.email, "mixed@x.test");
  assert.ok(reg.body.token);

  const dup = await h.request("POST", "/api/auth/register", { body: { email: "mixed@x.test", password: "long-enough-pw" } });
  assert.equal(dup.status, 409);

  const login = await h.request("POST", "/api/auth/login", { body: { email: "MIXED@x.test", password: "long-enough-pw" } });
  assert.equal(login.status, 200);
  const bad = await h.request("POST", "/api/auth/login", { body: { email: "mixed@x.test", password: "wrong-password" } });
  assert.equal(bad.status, 401);
  // legacy `username` field still accepted
  const legacy = await h.request("POST", "/api/auth/login", { body: { username: "mixed@x.test", password: "long-enough-pw" } });
  assert.equal(legacy.status, 200);
});

test("forgot/reset password answer 501 honestly instead of pretending", async () => {
  const r = await h.request("POST", "/api/auth/forgot-password", { body: { email: "a@x.test" } });
  assert.equal(r.status, 501);
});

test("device registration returns the key once; GET never returns secrets", async () => {
  const { token } = await h.registerUser();
  const r = await h.request("POST", "/api/devices", { token, body: { device_id: "esp32-legacy-1", nickname: "Kitchen", capacity_amps: 20, status: "TRIPPED" } });
  assert.equal(r.status, 201);
  assert.match(r.body.api_key, /^bk_[0-9a-f]{64}$/);
  assert.equal(r.body.status, "OFF", "browser-supplied status is ignored");
  assert.equal(r.body.current_threshold, 20);
  assert.equal(r.headers.get("cache-control"), "no-store");

  const list = await h.request("GET", "/api/devices", { token });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].api_key, undefined);
  assert.equal(list.body[0].api_key_hash, undefined);

  const dup = await h.request("POST", "/api/devices", { token, body: { device_id: "esp32-legacy-1" } });
  assert.equal(dup.status, 409);

  // channel-1 alias breaker was created alongside
  const b = await h.request("GET", "/api/breakers/esp32-legacy-1", { token });
  assert.equal(b.status, 200);
  assert.equal(b.body.channel_number, 1);
  assert.equal(b.body.is_legacy_alias, true);
});

test("POST /readings: verified legacy payload stored and returned; bad/missing keys rejected", async () => {
  const { token } = await h.registerUser();
  const key = await h.addDevice(token, "esp32-legacy-2");

  const ok = await h.sendReading(key, { device_id: "esp32-legacy-2", voltage: 120.4, current: 0.5, power: 60.2 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.device_id, "esp32-legacy-2");
  assert.equal(ok.body.voltage, 120.4);
  assert.equal(ok.body.power, 60.2);
  assert.equal(ok.body.breaker_id, "esp32-legacy-2");

  const missing = await h.request("POST", "/readings", { body: { device_id: "esp32-legacy-2", voltage: 120 } });
  assert.equal(missing.status, 401);
  const wrong = await h.sendReading("bk_" + "0".repeat(64), { device_id: "esp32-legacy-2", voltage: 120 });
  assert.equal(wrong.status, 401);
  const unknown = await h.sendReading(key, { device_id: "nope", voltage: 120 });
  assert.equal(unknown.status, 401);
  const invalid = await h.sendReading(key, { device_id: "esp32-legacy-2", voltage: "abc" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.field, "voltage");

  const latest = await h.request("GET", "/readings/esp32-legacy-2", { token });
  assert.equal(latest.status, 200);
  assert.equal(latest.body.voltage, 120.4);
  const all = await h.request("GET", "/readings", { token });
  assert.equal(all.body.length, 1);
});

test("dashboard still returns device, latest, history and alerts", async () => {
  const { token } = await h.registerUser();
  const key = await h.addDevice(token, "esp32-legacy-3", { capacity_amps: 10 });
  for (const current of [1, 2, 3]) {
    await h.sendReading(key, { device_id: "esp32-legacy-3", voltage: 120, current, power: 120 * current });
  }
  await h.sendReading(key, { device_id: "esp32-legacy-3", voltage: 120, current: 15, power: 1800 }); // over 10 A

  const d = await h.request("GET", "/api/dashboard/esp32-legacy-3?hours=6", { token });
  assert.equal(d.status, 200);
  assert.equal(d.body.device.device_id, "esp32-legacy-3");
  assert.equal(d.body.latest.current, 15);
  assert.ok(d.body.history.length >= 1);
  assert.equal(d.body.alerts.length, 1);
  assert.equal(d.body.alerts[0].metric, "current");
  assert.ok(d.body.uptime_pct > 0);

  const alerts = await h.request("GET", "/alerts", { token });
  assert.equal(alerts.body.length, 1);
  assert.equal(alerts.body[0].breaker_id, "esp32-legacy-3");

  // back to normal -> auto-resolved, still one row in history
  await h.sendReading(key, { device_id: "esp32-legacy-3", voltage: 120, current: 2, power: 240 });
  const after = await h.request("GET", "/alerts", { token });
  assert.equal(after.body.length, 0);
  const rows = await h.q(`SELECT resolved FROM alerts WHERE breaker_id = 'esp32-legacy-3'`);
  assert.deepEqual(rows.map((r) => r.resolved), [true]);
});

test("legacy ON/OFF command: queued, polled by firmware, completed by status report", async () => {
  const { token } = await h.registerUser();
  const key = await h.addDevice(token, "esp32-legacy-4");

  await h.sendReading(key, { device_id: "esp32-legacy-4", voltage: 120, current: 0, power: 0, status: "OFF" });
  const cmd = await h.request("POST", "/api/devices/esp32-legacy-4/command", { token, body: { status: "ON" } });
  assert.equal(cmd.status, 200);
  assert.equal(cmd.body.requested_status, "ON");
  assert.ok(cmd.body.command_expires_at);

  const poll = await h.request("POST", "/readings/command", { apiKey: key, body: { device_id: "esp32-legacy-4" } });
  assert.equal(poll.status, 200);
  assert.equal(poll.body.requested_status, "ON");

  const report = await h.sendReading(key, { device_id: "esp32-legacy-4", voltage: 120, current: 0.5, power: 60, status: "ON" });
  assert.equal(report.status, 200);
  const poll2 = await h.request("POST", "/readings/command", { apiKey: key, body: { device_id: "esp32-legacy-4" } });
  assert.equal(poll2.body.requested_status, null);

  const status = await h.request("GET", `/api/commands/${cmd.body.command_id}`, { token });
  assert.equal(status.body.status, "APPLIED");
  assert.equal(status.body.ack_source, "legacy_status_report");
  assert.equal(status.body.physical_feedback_state, "UNKNOWN");

  // same state again = no-op, as before
  const noop = await h.request("POST", "/api/devices/esp32-legacy-4/command", { token, body: { status: "ON" } });
  assert.equal(noop.body.requested_status, null);

  // tripped breaker cannot be turned on
  await h.q(`UPDATE devices SET status = 'TRIPPED' WHERE device_id = 'esp32-legacy-4'`);
  const tripped = await h.request("POST", "/api/devices/esp32-legacy-4/command", { token, body: { status: "ON" } });
  assert.equal(tripped.status, 409);
  const off = await h.request("POST", "/api/devices/esp32-legacy-4/command", { token, body: { status: "OFF" } });
  assert.equal(off.status, 200);
});

test("legacy ON is refused when the controller is offline", async () => {
  const { token } = await h.registerUser();
  await h.addDevice(token, "esp32-legacy-5"); // never reported
  const r = await h.request("POST", "/api/devices/esp32-legacy-5/command", { token, body: { status: "ON" } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "CONTROLLER_OFFLINE");
});

test("PATCH device mirrors to its breaker; DELETE removes device and its data", async () => {
  const { token } = await h.registerUser();
  const key = await h.addDevice(token, "esp32-legacy-6");
  await h.sendReading(key, { device_id: "esp32-legacy-6", voltage: 120, current: 1, power: 120 });

  const p = await h.request("PATCH", "/api/devices/esp32-legacy-6", { token, body: { nickname: "Garage", current_threshold: 12 } });
  assert.equal(p.status, 200);
  assert.equal(p.body.nickname, "Garage");
  const b = await h.request("GET", "/api/breakers/esp32-legacy-6", { token });
  assert.equal(b.body.name, "Garage");
  assert.equal(b.body.thresholds.current_threshold, 12);
  assert.equal((await h.request("PATCH", "/api/devices/esp32-legacy-6", { token, body: { current_threshold: -1 } })).status, 400);

  const other = await h.registerUser();
  assert.equal((await h.request("DELETE", "/api/devices/esp32-legacy-6", { token: other.token })).status, 404);

  const del = await h.request("DELETE", "/api/devices/esp32-legacy-6", { token });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.breakers_removed, ["esp32-legacy-6"]);
  assert.equal((await h.q(`SELECT COUNT(*)::int n FROM readings_log WHERE device_id = 'esp32-legacy-6'`))[0].n, 0);
  assert.equal((await h.sendReading(key, { device_id: "esp32-legacy-6", voltage: 120 })).status, 401);
});

test("malformed JSON -> 400 JSON, unknown route -> 404 JSON, /health ok", async () => {
  const bad = await h.request("POST", "/api/auth/login", { body: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "INVALID_JSON");
  const nf = await h.request("GET", "/does-not-exist");
  assert.equal(nf.status, 404);
  assert.equal((await h.request("GET", "/health")).body.status, "ok");
});
