// Multi-controller / multi-breaker ingestion, isolation, PZEM fields, health and history.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness } = require("../../test-support/harness");

let h, userA, userB, keyA, keyB;

const ch = (channel_index, power_w, extra = {}) => ({
  channel_index,
  voltage_v: 120.1,
  current_a: Math.round((power_w / 120.1) * 1000) / 1000,
  power_w,
  energy_kwh: 1.5,
  frequency_hz: 60.0,
  power_factor: 1.0,
  sensor_ok: true,
  reported_output_state: "ON",
  ...extra,
});

before(async () => {
  h = await startHarness();
  userA = await h.registerUser();
  userB = await h.registerUser();
  // user A: controller A with 2 channels; user B: controller B with 2 channels => 4 breakers
  keyA = await h.addDevice(userA.token, "ctrl-a");
  await h.addBreaker(userA.token, "ctrl-a", "ctrl-a-ch2", 2, { name: "Kitchen", rated_current_a: 15 });
  keyB = await h.addDevice(userB.token, "ctrl-b");
  await h.addBreaker(userB.token, "ctrl-b", "ctrl-b-ch2", 2);
});
after(async () => h && h.close());

test("channel numbers and breaker ids are unique", async () => {
  const dupChannel = await h.request("POST", "/api/controllers/ctrl-a/breakers", { token: userA.token, body: { breaker_id: "x-1", channel_number: 2 } });
  assert.equal(dupChannel.status, 409);
  assert.equal(dupChannel.body.error.code, "CHANNEL_IN_USE");
  const dupId = await h.request("POST", "/api/controllers/ctrl-a/breakers", { token: userA.token, body: { breaker_id: "ctrl-b-ch2", channel_number: 3 } });
  assert.equal(dupId.status, 409);
  const notMine = await h.request("POST", "/api/controllers/ctrl-b/breakers", { token: userA.token, body: { breaker_id: "steal", channel_number: 3 } });
  assert.equal(notMine.status, 404);
});

test("v1 telemetry: two channels of one controller land in separate breaker histories", async () => {
  const r = await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 1, firmware_version: "0.3.0", channels: [ch(1, 60.5), ch(2, 1450.2)] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.channels.map((c) => [c.breaker_id, c.result]), [["ctrl-a", "STORED"], ["ctrl-a-ch2", "STORED"]]);

  await h.telemetry(keyB, { controller_id: "ctrl-b", sequence: 1, channels: [ch(1, 5), ch(2, 900)] });

  const powers = {};
  for (const id of ["ctrl-a", "ctrl-a-ch2"]) {
    const hist = await h.request("GET", `/api/breakers/${id}/readings`, { token: userA.token });
    assert.equal(hist.status, 200);
    powers[id] = hist.body.readings.map((x) => x.power);
  }
  for (const id of ["ctrl-b", "ctrl-b-ch2"]) {
    const hist = await h.request("GET", `/api/breakers/${id}/readings`, { token: userB.token });
    powers[id] = hist.body.readings.map((x) => x.power);
  }
  assert.deepEqual(powers, { "ctrl-a": [60.5], "ctrl-a-ch2": [1450.2], "ctrl-b": [5], "ctrl-b-ch2": [900] });

  const ctrl = await h.request("GET", "/api/controllers/ctrl-a", { token: userA.token });
  assert.equal(ctrl.body.online, true);
  assert.equal(ctrl.body.firmware_version, "0.3.0");
  assert.equal(ctrl.body.channel_count, 2);
  assert.equal(ctrl.body.api_key_status, "active");
});

test("all PZEM values are stored and returned with units", async () => {
  await h.telemetry(keyA, {
    controller_id: "ctrl-a",
    sequence: 2,
    channels: [{ channel_index: 2, voltage_v: 120.4, current_a: 0.509, power_w: 61.3, apparent_power_va: 61.28, energy_kwh: 0.004, frequency_hz: 59.9, power_factor: 0.98, sensor_ok: true }],
  });
  const b = await h.request("GET", "/api/breakers/ctrl-a-ch2", { token: userA.token });
  const l = b.body.latest;
  assert.deepEqual(
    [l.voltage, l.current, l.power, l.apparent_power, l.energy_kwh, l.frequency, l.power_factor, l.temperature],
    [120.4, 0.509, 61.3, 61.28, 0.004, 59.9, 0.98, null]
  );
  assert.equal(l.apparent_power_source, "reported");
  assert.equal(l.stale, false);
  assert.equal(b.body.health.sensor_status, "online");
  assert.equal(b.body.physical_feedback_state, "UNKNOWN");
  const hist = await h.request("GET", "/api/breakers/ctrl-a-ch2/readings", { token: userA.token });
  assert.equal(hist.body.units.apparent_power, "VA");
  assert.equal(hist.body.readings.at(-1).frequency, 59.9);
});

test("legacy POST /readings can address channel 2 with breaker_id, but never another controller's breaker", async () => {
  const ok = await h.sendReading(keyA, { device_id: "ctrl-a", breaker_id: "ctrl-a-ch2", voltage: 120, current: 1, power: 120, contactor_state: "ON" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.breaker_id, "ctrl-a-ch2");

  const cross = await h.sendReading(keyA, { device_id: "ctrl-a", breaker_id: "ctrl-b-ch2", voltage: 120, current: 1, power: 120 });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.code, "BREAKER_NOT_ON_CONTROLLER");

  // A's key cannot authenticate as controller B
  const spoof = await h.sendReading(keyA, { device_id: "ctrl-b", voltage: 120 });
  assert.equal(spoof.status, 401);
  const spoofV1 = await h.telemetry(keyA, { controller_id: "ctrl-b", channels: [ch(1, 10)] });
  assert.equal(spoofV1.status, 401);
  assert.equal((await h.q(`SELECT COUNT(*)::int n FROM readings_log WHERE breaker_id = 'ctrl-b-ch2'`))[0].n, 1);
});

test("unassigned channel is reported, other channels still stored", async () => {
  const r = await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 3, channels: [ch(1, 61), ch(5, 10)] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.channels.map((c) => c.result), ["STORED", "CHANNEL_NOT_ASSIGNED"]);
});

test("duplicate sequence is not stored twice", async () => {
  const before = (await h.q(`SELECT COUNT(*)::int n FROM readings_log WHERE breaker_id = 'ctrl-a'`))[0].n;
  const r = await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 3, channels: [ch(1, 61)] });
  assert.equal(r.body.duplicate, true);
  assert.equal((await h.q(`SELECT COUNT(*)::int n FROM readings_log WHERE breaker_id = 'ctrl-a'`))[0].n, before);
});

test("sensor failure report keeps the last good measurement (no fake zeros)", async () => {
  await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 10, channels: [ch(1, 75.5)] });
  const fail = await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 11, channels: [{ channel_index: 1, sensor_ok: false, reported_output_state: "ON" }] });
  assert.equal(fail.body.channels[0].result, "STATUS_ONLY");
  const b = await h.request("GET", "/api/breakers/ctrl-a", { token: userA.token });
  assert.equal(b.body.latest.power, 75.5);
  assert.equal(b.body.health.sensor_status, "error");

  // legacy path too
  const legacy = await h.sendReading(keyA, { device_id: "ctrl-a", sensor_status: "error", status: "ON" });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.stored, false);
  assert.equal((await h.request("GET", "/readings/ctrl-a", { token: userA.token })).body.power, 75.5);

  // numbers together with sensor_ok:false are rejected
  const contradictory = await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 12, channels: [{ channel_index: 1, sensor_ok: false, voltage_v: 0 }] });
  assert.equal(contradictory.status, 400);

  // recovers
  await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 13, channels: [ch(1, 76)] });
  assert.equal((await h.request("GET", "/api/breakers/ctrl-a", { token: userA.token })).body.health.sensor_status, "online");
});

test("contactor OFF: ~120 V upstream with 0 A / 0 W is valid and stored", async () => {
  const r = await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 14, channels: [ch(1, 0, { current_a: 0, reported_output_state: "OFF" })] });
  assert.equal(r.status, 200);
  const b = await h.request("GET", "/api/breakers/ctrl-a", { token: userA.token });
  assert.equal(b.body.latest.voltage, 120.1);
  assert.equal(b.body.latest.power, 0);
  assert.equal(b.body.reported_contactor_state, "OFF");
});

test("out-of-order packet goes to history but does not replace the latest value", async () => {
  const now = Date.now();
  await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 20, recorded_at: new Date(now).toISOString(), channels: [ch(2, 300)] });
  const late = await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 19, recorded_at: new Date(now - 10_000).toISOString(), channels: [ch(2, 111)] });
  assert.equal(late.body.channels[0].result, "STORED_OUT_OF_ORDER");
  const b = await h.request("GET", "/api/breakers/ctrl-a-ch2", { token: userA.token });
  assert.equal(b.body.latest.power, 300);

  const skew = await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 21, recorded_at: "2001-01-01T00:00:00Z", channels: [ch(2, 301)] });
  assert.deepEqual(skew.body.warnings, ["recorded_at_ignored_clock_skew"]);
});

test("invalid telemetry is rejected whole", async () => {
  const cases = [
    { controller_id: "ctrl-a", channels: [] },
    { controller_id: "ctrl-a", channels: [ch(1, 10), ch(1, 20)] },
    { controller_id: "ctrl-a", channels: [ch(1, 10, { power_factor: 1.5 })] },
    { controller_id: "ctrl-a", channels: [ch(1, -5)] },
    { controller_id: "ctrl-a", channels: [ch(9, 10)] },
    { controller_id: "ctrl-a", sequence: -1, channels: [ch(1, 10)] },
    { controller_id: "ctrl-a", channels: [ch(1, 10, { voltage_v: "NaN" })] },
  ];
  for (const body of cases) {
    const r = await h.telemetry(keyA, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error.code, "VALIDATION_ERROR");
  }
});

test("user B cannot read, change, delete or command user A's breakers", async () => {
  const t = userB.token;
  assert.equal((await h.request("GET", "/api/breakers/ctrl-a-ch2", { token: t })).status, 404);
  assert.equal((await h.request("GET", "/api/breakers/ctrl-a-ch2/readings", { token: t })).status, 404);
  assert.equal((await h.request("GET", "/api/breakers/ctrl-a-ch2/measurements", { token: t })).status, 404);
  assert.equal((await h.request("PATCH", "/api/breakers/ctrl-a-ch2", { token: t, body: { name: "x" } })).status, 404);
  assert.equal((await h.request("DELETE", "/api/breakers/ctrl-a-ch2", { token: t })).status, 404);
  assert.equal((await h.request("POST", "/api/breakers/ctrl-a-ch2/commands", { token: t, body: { action: "OFF" } })).status, 404);
  assert.equal((await h.request("GET", "/api/controllers/ctrl-a", { token: t })).status, 404);
  assert.equal((await h.request("GET", "/api/dashboard/ctrl-a", { token: t })).status, 404);
  const list = await h.request("GET", "/api/breakers", { token: t });
  assert.deepEqual(list.body.breakers.map((b) => b.breaker_id).sort(), ["ctrl-b", "ctrl-b-ch2"]);
  assert.equal((await h.request("GET", "/api/breakers")).status, 401);
});

test("readings pagination with cursor", async () => {
  const all = [];
  let cursor = null;
  do {
    const r = await h.request("GET", `/api/breakers/ctrl-a/readings?limit=2${cursor ? `&cursor=${cursor}` : ""}`, { token: userA.token });
    assert.equal(r.status, 200);
    all.push(...r.body.readings);
    cursor = r.body.next_cursor;
  } while (cursor);
  const total = (await h.q(`SELECT COUNT(*)::int n FROM readings_log WHERE breaker_id = 'ctrl-a'`))[0].n;
  assert.equal(all.length, total);
  assert.equal((await h.request("GET", "/api/breakers/ctrl-a/readings?limit=5000", { token: userA.token })).status, 400);
});

test("measurements: averages per bucket, null gaps, energy from a counter that resets", async () => {
  await h.addBreaker(userA.token, "ctrl-a", "ctrl-a-ch3", 3);
  const base = Date.UTC(2026, 10, 10, 12, 0, 0);
  const rows = [
    // bucket 12:00: power 100,200 ; energy 10.0 -> 10.5
    [0, 100, 10.0], [30, 200, 10.5],
    // 12:01 empty
    // bucket 12:02: meter reset to 0.1 -> counts 0.1 ; then 0.3 -> +0.2
    [120, 300, 0.1], [150, 300, 0.3],
  ];
  for (const [s, p, e] of rows) {
    await h.q(
      `INSERT INTO readings_log (device_id, breaker_id, channel_number, voltage, current, power, energy_kwh, created_at)
       VALUES ('ctrl-a', 'ctrl-a-ch3', 3, 120, $1::numeric / 120, $1, $2, $3)`,
      [p, e, new Date(base + s * 1000)]
    );
  }
  const from = new Date(base).toISOString();
  const to = new Date(base + 180_000).toISOString();
  const pw = await h.request("GET", `/api/breakers/ctrl-a-ch3/measurements?metric=power&from=${from}&to=${to}&resolution=1m`, { token: userA.token });
  assert.equal(pw.status, 200);
  assert.deepEqual(pw.body.points.map((p) => p.value), [150, null, 300]);
  assert.equal(pw.body.unit, "W");

  const en = await h.request("GET", `/api/breakers/ctrl-a-ch3/measurements?metric=energy_kwh&from=${from}&to=${to}&resolution=1m`, { token: userA.token });
  assert.equal(en.body.aggregation, "interval_sum_from_counter");
  assert.deepEqual(en.body.points.map((p) => p.value), [0.5, null, 0.3]);

  const auto = await h.request("GET", `/api/breakers/ctrl-a-ch3/measurements?metric=power&from=${from}&to=${to}`, { token: userA.token });
  assert.equal(auto.body.resolution, "10s");
  for (const bad of ["metric=password", "resolution=7m", "from=garbage", `from=${to}&to=${from}`]) {
    assert.equal((await h.request("GET", `/api/breakers/ctrl-a-ch3/measurements?${bad}`, { token: userA.token })).status, 400, bad);
  }
});

test("PATCH breaker thresholds drive per-breaker alerts; DELETE non-alias breaker", async () => {
  const p = await h.request("PATCH", "/api/breakers/ctrl-a-ch2", { token: userA.token, body: { name: "Kitchen", thresholds: { current_threshold: 5 } } });
  assert.equal(p.status, 200);
  assert.equal(p.body.thresholds.current_threshold, 5);
  assert.equal((await h.request("PATCH", "/api/breakers/ctrl-a-ch2", { token: userA.token, body: { thresholds: { bogus: 1 } } })).status, 400);

  await h.telemetry(keyA, { controller_id: "ctrl-a", sequence: 40, channels: [ch(1, 1000), ch(2, 1000)] }); // ~8.3 A each
  const alerts = await h.request("GET", "/alerts?breaker_id=ctrl-a-ch2", { token: userA.token });
  assert.equal(alerts.body.length, 1);
  assert.match(alerts.body[0].message, /Kitchen/);
  const ch1Alerts = await h.request("GET", "/alerts?breaker_id=ctrl-a", { token: userA.token });
  assert.equal(ch1Alerts.body.length, 0, "channel 1 has a 20 A limit");

  const aliasDelete = await h.request("DELETE", "/api/breakers/ctrl-a", { token: userA.token });
  assert.equal(aliasDelete.status, 409);
  const del = await h.request("DELETE", "/api/breakers/ctrl-a-ch3", { token: userA.token });
  assert.equal(del.status, 200);
  assert.equal((await h.q(`SELECT COUNT(*)::int n FROM readings_log WHERE breaker_id = 'ctrl-a-ch3'`))[0].n, 0);
});
