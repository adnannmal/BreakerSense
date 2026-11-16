// Auth hardening: rate limits, JWT validation, payload limits, key rotation/revocation.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { startHarness } = require("../../test-support/harness");

let h;
before(async () => (h = await startHarness({ env: { RATE_LIMIT_AUTH_MAX: "5", RATE_LIMIT_DEVICE_MAX: "8", JSON_BODY_LIMIT: "2kb" } })));
after(async () => h && h.close());

test("login is rate limited per client (429 + Retry-After)", async () => {
  let last;
  for (let i = 0; i < 6; i++) {
    last = await h.request("POST", "/api/auth/login", { body: { email: "nobody@x.test", password: "wrong-password" } });
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("retry-after")) > 0);
  assert.equal(last.body.code, "RATE_LIMITED");
});

test("forged, unsigned or expired JWTs are rejected", async () => {
  const forged = jwt.sign({ userId: 1 }, "some-other-secret");
  const none = jwt.sign({ userId: 1 }, null, { algorithm: "none" });
  const expired = jwt.sign({ userId: 1, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
  const badPayload = jwt.sign({ userId: "1 OR 1=1" }, process.env.JWT_SECRET);
  for (const token of [forged, none, expired, badPayload, "garbage"]) {
    assert.equal((await h.request("GET", "/api/devices", { token })).status, 401);
  }
});

test("oversized payload -> 413", async () => {
  const r = await h.request("POST", "/readings", { body: { device_id: "x", notes: "a".repeat(5000) } });
  assert.equal(r.status, 413);
});

test("SQL-ish input is just data", async () => {
  const r = await h.request("POST", "/api/auth/login", { headers: { "X-Forwarded-For": "10.9.9.9" }, body: { email: "' OR 1=1 --", password: "whatever-pw" } });
  assert.equal(r.status, 401);
});

test("key rotation invalidates the old key; revocation disables the device; device uploads are rate limited", async () => {
  const reg = await h.request("POST", "/api/auth/register", { headers: { "X-Forwarded-For": "10.0.0.2" }, body: { email: "sec@x.test", password: "long-enough-pw" } });
  const token = reg.body.token;
  const add = await h.request("POST", "/api/devices", { token, body: { device_id: "sec-ctrl" } });
  const oldKey = add.body.api_key;
  assert.equal((await h.sendReading(oldKey, { device_id: "sec-ctrl", voltage: 120 })).status, 200);

  const rot = await h.request("POST", "/api/devices/sec-ctrl/rotate-key", { token });
  assert.equal(rot.status, 200);
  assert.equal((await h.sendReading(oldKey, { device_id: "sec-ctrl", voltage: 120 })).status, 401);
  assert.equal((await h.sendReading(rot.body.api_key, { device_id: "sec-ctrl", voltage: 120 })).status, 200);

  const rev = await h.request("POST", "/api/devices/sec-ctrl/revoke-key", { token });
  assert.equal(rev.body.revoked, true);
  assert.equal((await h.sendReading(rot.body.api_key, { device_id: "sec-ctrl", voltage: 120 })).status, 401);
  const ctrl = await h.request("GET", "/api/controllers/sec-ctrl", { token });
  assert.equal(ctrl.body.api_key_status, "revoked");

  let last;
  for (let i = 0; i < 10; i++) last = await h.sendReading(rot.body.api_key, { device_id: "sec-ctrl", voltage: 120 });
  assert.equal(last.status, 429);
});
