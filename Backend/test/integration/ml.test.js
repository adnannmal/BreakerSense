// Sprint 3 weeks 1–2 end to end: labeled sessions are copied permanently, survive the 7-day
// prune, train a model with a held-out confusion matrix, and the live guess works.
// Uses SYNTHETIC readings (marked is_simulated) — this tests the pipeline, not real accuracy.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness } = require("../../test-support/harness");
const { generateSession } = require("../../ml/synthetic");
const { mulberry32 } = require("../../ml/stats");
const { pruneReadingsLog } = require("../../jobs/retention");

let h, user, key;
const BREAKER = "ml-ctrl";

// Insert a synthetic run into readings_log starting at `start`, return its [from, to].
async function insertRun(name, start, rng) {
  const rows = generateSession(name, rng, { startMs: start });
  for (const r of rows) {
    await h.q(
      `INSERT INTO readings_log (device_id, breaker_id, channel_number, voltage, current, power, power_factor, frequency, created_at)
       VALUES ($1, $1, 1, $2, $3, $4, $5, $6, $7)`,
      [BREAKER, r.voltage, r.current, r.power, r.power_factor, r.frequency, new Date(r.recorded_at)]
    );
  }
  return [new Date(start - 1000).toISOString(), new Date(new Date(rows.at(-1).recorded_at).getTime() + 1000).toISOString()];
}

const label = (body) => h.request("POST", "/api/ml/sessions", { token: user.token, body: { breaker_id: BREAKER, is_simulated: true, ...body } });

before(async () => {
  h = await startHarness();
  user = await h.registerUser();
  key = await h.addDevice(user.token, BREAKER);
  const rng = mulberry32(21);
  let t = Date.now() - 5 * 3600 * 1000;
  for (const name of ["kettle", "fan", "lamp", "charger"]) {
    for (let i = 0; i < 5; i++) {
      const [from, to] = await insertRun(name, t, rng);
      const r = await label({ appliance_label: name, started_at: from, ended_at: to });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.quality, "OK", JSON.stringify(r.body.quality_details));
      t += 3 * 60 * 1000;
    }
  }
});
after(async () => h && h.close());

test("labeled readings are copied permanently and survive the 7-day prune", async () => {
  const copied = (await h.q(`SELECT COUNT(*)::int n FROM ml_session_readings`))[0].n;
  assert.ok(copied >= 20 * 25);
  await h.q(`UPDATE readings_log SET created_at = created_at - INTERVAL '8 days' WHERE breaker_id = $1`, [BREAKER]);
  const pruned = await pruneReadingsLog(h.pool, 7);
  assert.ok(pruned >= copied);
  assert.equal((await h.q(`SELECT COUNT(*)::int n FROM ml_session_readings`))[0].n, copied);
});

test("dataset summary tracks progress toward 5 recordings per appliance", async () => {
  const s = await h.request("GET", "/api/ml/dataset/summary", { token: user.token });
  assert.equal(s.status, 200);
  assert.equal(s.body.appliances.length, 4);
  for (const a of s.body.appliances) {
    assert.equal(a.simulated_sessions, 5);
    assert.equal(a.usable_sessions, 0, "simulated runs never count as real data");
  }
});

test("training excludes simulated data by default, and works when explicitly included", async () => {
  const refused = await h.request("POST", "/api/ml/train", { token: user.token, body: {} });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, "INSUFFICIENT_TRAINING_DATA");

  const r = await h.request("POST", "/api/ml/train", { token: user.token, body: { include_simulated: true, seed: 7 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.labels, ["charger", "fan", "kettle", "lamp"]);
  const { holdout, split } = r.body.metrics;
  assert.equal(split.method, "by_session");
  assert.ok(split.test_sessions >= 4);
  assert.deepEqual(holdout.confusion.columns, ["charger", "fan", "kettle", "lamp", "Unknown"]);
  assert.equal(holdout.confusion.matrix.flat().reduce((a, b) => a + b, 0), split.test_sessions);
  assert.ok(holdout.accuracy >= 0.75);
  assert.ok(r.body.metrics.leave_one_session_out.n === 20);

  const status = await h.request("GET", "/api/ml/model-status", { token: user.token });
  assert.equal(status.body.status, "READY");
  const latest = await h.request("GET", "/api/ml/models/latest", { token: user.token });
  assert.equal(latest.body.model_version, r.body.model_version);
  assert.equal(latest.body.artifact, undefined, "training vectors are not exposed");
});

test("live prediction from fresh telemetry: kettle switched on", async () => {
  for (let i = 0; i < 4; i++) await h.sendReading(key, { device_id: BREAKER, voltage: 120, current: 0, power: 0.1 });
  for (let i = 0; i < 8; i++) await h.sendReading(key, { device_id: BREAKER, voltage: 120, current: 12.1, power: 1452 + i, power_factor: 1.0 });
  const p = await h.request("GET", `/api/ml/breakers/${BREAKER}/prediction?minutes=3`, { token: user.token });
  assert.equal(p.status, 200);
  assert.equal(p.body.status, "OK");
  assert.equal(p.body.appliance_label, "kettle");
  assert.equal(p.body.is_unknown, false);
  assert.match(p.body.confidence_method, /not a probability/);
  // legacy path alias
  assert.equal((await h.request("GET", `/api/ml/devices/${BREAKER}/prediction`, { token: user.token })).body.status, "OK");
});

test("an unlike load is called Unknown; idle circuit is NO_LOAD", async () => {
  for (let i = 0; i < 8; i++) await h.sendReading(key, { device_id: BREAKER, voltage: 120, current: 4, power: 330, power_factor: 0.69 });
  const p = await h.request("GET", `/api/ml/breakers/${BREAKER}/prediction?minutes=1`, { token: user.token });
  assert.equal(p.body.appliance_label, "Unknown");
  assert.equal(p.body.is_unknown, true);

  await h.q(`DELETE FROM readings_log WHERE breaker_id = $1`, [BREAKER]);
  for (let i = 0; i < 6; i++) await h.sendReading(key, { device_id: BREAKER, voltage: 120, current: 0, power: 0 });
  const idle = await h.request("GET", `/api/ml/breakers/${BREAKER}/prediction`, { token: user.token });
  assert.equal(idle.body.status, "NO_LOAD");
});

test("recording sessions: live start/stop, overlap refused, discard, isolation", async () => {
  const start = await label({ appliance_label: "Space Heater" });
  assert.equal(start.status, 201);
  assert.equal(start.body.status, "RECORDING");
  assert.equal(start.body.appliance_label, "space heater");
  const second = await label({ appliance_label: "fan" });
  assert.equal(second.status, 409);

  const other = await h.registerUser();
  assert.equal((await h.request("GET", `/api/ml/sessions/${start.body.session_id}`, { token: other.token })).status, 404);
  assert.equal((await h.request("POST", `/api/ml/sessions/${start.body.session_id}/stop`, { token: other.token, body: {} })).status, 404);
  assert.equal((await h.request("POST", "/api/ml/sessions", { token: other.token, body: { breaker_id: BREAKER, appliance_label: "fan" } })).status, 404);
  assert.deepEqual((await h.request("GET", "/api/ml/sessions", { token: other.token })).body.sessions, []);

  const tooShort = await h.request("POST", `/api/ml/sessions/${start.body.session_id}/stop`, { token: user.token, body: {} });
  assert.equal(tooShort.status, 422);
  const d = await h.request("POST", `/api/ml/sessions/${start.body.session_id}/discard`, { token: user.token, body: {} });
  assert.equal(d.body.status, "DISCARDED");

  assert.equal((await label({ appliance_label: "unknown" })).status, 400);
  const exp = await h.request("GET", "/api/ml/dataset/export", { token: user.token });
  assert.equal(exp.status, 200);
  assert.equal(exp.body.sessions.length, 20);
  assert.ok(exp.body.sessions[0].readings.length > 20);
});
