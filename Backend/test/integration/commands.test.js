// Remote command lifecycle: created -> polled -> acknowledged, plus duplicate, expired,
// failed, superseded, offline/tripped/sensor-fault refusals, idempotency and isolation.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness } = require("../../test-support/harness");

let h, owner, other, key, otherKey;

const heartbeat = (k = key, id = "cmd-ctrl") =>
  h.telemetry(k, { controller_id: id, channels: [{ channel_index: 1, voltage_v: 120, current_a: 0, power_w: 0, sensor_ok: true, reported_output_state: "OFF" }] });
const create = (breaker, action, extra = {}) => h.request("POST", `/api/breakers/${breaker}/commands`, { token: owner.token, body: { action }, ...extra });
const poll = (k = key, id = "cmd-ctrl") => h.request("POST", "/api/device/v1/commands/poll", { apiKey: k, body: { controller_id: id } });
const ack = (id, body, k = key, ctrl = "cmd-ctrl") => h.request("POST", `/api/device/v1/commands/${id}/ack`, { apiKey: k, body: { controller_id: ctrl, ...body } });
const status = (id, token = owner.token) => h.request("GET", `/api/commands/${id}`, { token });

before(async () => {
  h = await startHarness();
  owner = await h.registerUser();
  other = await h.registerUser();
  key = await h.addDevice(owner.token, "cmd-ctrl");
  await h.addBreaker(owner.token, "cmd-ctrl", "cmd-ch2", 2);
  otherKey = await h.addDevice(other.token, "other-ctrl");
});
after(async () => h && h.close());

test("happy path: QUEUED -> DELIVERED -> APPLIED, routed to the right channel", async () => {
  await heartbeat();
  const c = await create("cmd-ch2", "ON");
  assert.equal(c.status, 202);
  assert.equal(c.body.status, "QUEUED");
  assert.equal(c.body.channel_number, 2);
  assert.equal(c.body.physical_feedback_state, "UNKNOWN");
  assert.ok(new Date(c.body.expires_at) > new Date());

  const p = await poll();
  assert.equal(p.status, 200);
  assert.equal(p.body.commands.length, 1);
  assert.deepEqual([p.body.commands[0].command_id, p.body.commands[0].channel_index, p.body.commands[0].action], [c.body.command_id, 2, "ON"]);
  assert.equal((await status(c.body.command_id)).body.status, "DELIVERED");

  // other controllers never see it
  assert.equal((await poll(otherKey, "other-ctrl")).body.commands.length, 0);

  const a = await ack(c.body.command_id, { result: "APPLIED", reported_output_state: "ON" });
  assert.equal(a.status, 200);
  assert.equal(a.body.status, "APPLIED");
  const s = (await status(c.body.command_id)).body;
  assert.equal(s.status, "APPLIED");
  assert.equal(s.reported_output_state, "ON");
  assert.equal(s.physical_feedback_state, "UNKNOWN");
  assert.ok(s.acknowledged_at);
  const b = await h.request("GET", "/api/breakers/cmd-ch2", { token: owner.token });
  assert.equal(b.body.reported_contactor_state, "ON");
  assert.equal((await poll()).body.commands.length, 0, "acked command is not delivered again");
});

test("duplicate ack is idempotent; conflicting ack is refused", async () => {
  await heartbeat();
  const c = await create("cmd-ch2", "OFF");
  await poll();
  assert.equal((await ack(c.body.command_id, { result: "APPLIED" })).status, 200);
  const again = await ack(c.body.command_id, { result: "APPLIED" });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  const conflict = await ack(c.body.command_id, { result: "FAILED" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "COMMAND_ALREADY_ACKNOWLEDGED");
});

test("lost poll response: command is re-delivered with the same id until acked", async () => {
  await heartbeat();
  const c = await create("cmd-ch2", "ON");
  const p1 = await poll();
  const p2 = await poll();
  assert.equal(p1.body.commands[0].command_id, p2.body.commands[0].command_id);
  assert.equal(p2.body.commands[0].delivery_count, 2);
  await ack(c.body.command_id, { result: "APPLIED" });
});

test("expired command is never delivered after reconnect, and a late ack is refused", async () => {
  await heartbeat();
  const c = await create("cmd-ch2", "OFF");
  await h.q(`UPDATE commands SET expires_at = NOW() - INTERVAL '1 second' WHERE command_id = $1`, [c.body.command_id]);
  assert.equal((await poll()).body.commands.length, 0);
  assert.equal((await status(c.body.command_id)).body.status, "EXPIRED");

  const d = await create("cmd-ch2", "OFF");
  await poll();
  await h.q(`UPDATE commands SET expires_at = NOW() - INTERVAL '1 minute' WHERE command_id = $1`, [d.body.command_id]);
  const late = await ack(d.body.command_id, { result: "APPLIED" });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "COMMAND_EXPIRED");

  // ack within the grace window after expiry (delivered in time) is accepted
  const e = await create("cmd-ch2", "OFF");
  await poll();
  await h.q(`UPDATE commands SET expires_at = NOW() - INTERVAL '2 seconds' WHERE command_id = $1`, [e.body.command_id]);
  assert.equal((await ack(e.body.command_id, { result: "APPLIED" })).status, 200);
});

test("failed / rejected acknowledgments keep the reason", async () => {
  await heartbeat();
  const c = await create("cmd-ch2", "ON");
  await poll();
  const f = await ack(c.body.command_id, { result: "REJECTED", reason: "local interlock open", reported_output_state: "OFF" });
  assert.equal(f.status, 200);
  const s = (await status(c.body.command_id)).body;
  assert.equal(s.status, "REJECTED");
  assert.equal(s.failure_reason, "local interlock open");
  assert.equal((await ack(c.body.command_id, { result: "MAYBE" })).status, 400);
});

test("a newer command supersedes a pending one", async () => {
  await heartbeat();
  const first = await create("cmd-ch2", "ON");
  const second = await create("cmd-ch2", "OFF");
  assert.equal((await status(first.body.command_id)).body.status, "SUPERSEDED");
  const p = await poll();
  assert.deepEqual(p.body.commands.map((x) => x.command_id), [second.body.command_id]);
  assert.equal((await ack(first.body.command_id, { result: "APPLIED" })).body.error.code, "COMMAND_SUPERSEDED");
  await ack(second.body.command_id, { result: "APPLIED" });
});

test("ack before delivery, or by another controller, is refused", async () => {
  await heartbeat();
  const c = await create("cmd-ch2", "OFF");
  const early = await ack(c.body.command_id, { result: "APPLIED" });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, "COMMAND_NOT_DELIVERED");
  await poll();
  const foreign = await ack(c.body.command_id, { result: "APPLIED" }, otherKey, "other-ctrl");
  assert.equal(foreign.status, 404);
  assert.equal((await ack("not-a-uuid", { result: "APPLIED" })).status, 404);
  await ack(c.body.command_id, { result: "APPLIED" });
});

test("ON refused when offline, tripped or sensor-faulted; OFF still allowed", async () => {
  await h.q(`UPDATE devices SET last_seen_at = NOW() - INTERVAL '10 minutes' WHERE device_id = 'cmd-ctrl'`);
  const offline = await create("cmd-ch2", "ON");
  assert.equal(offline.status, 409);
  assert.equal(offline.body.error.code, "CONTROLLER_OFFLINE");
  assert.equal((await create("cmd-ch2", "OFF")).status, 202);

  await heartbeat();
  await h.q(`UPDATE breakers SET contactor_state = 'TRIPPED' WHERE breaker_id = 'cmd-ch2'`);
  assert.equal((await create("cmd-ch2", "ON")).body.error.code, "BREAKER_TRIPPED");
  await h.q(`UPDATE breakers SET contactor_state = 'OFF' WHERE breaker_id = 'cmd-ch2'`);

  await h.telemetry(key, { controller_id: "cmd-ctrl", channels: [{ channel_index: 2, sensor_ok: false }] });
  assert.equal((await create("cmd-ch2", "ON")).body.error.code, "SENSOR_FAULT");
  assert.equal((await create("cmd-ch2", "MAYBE")).status, 400);
});

test("Idempotency-Key: retry returns the same command instead of a second ON", async () => {
  await h.telemetry(key, { controller_id: "cmd-ctrl", channels: [{ channel_index: 2, voltage_v: 120, current_a: 0, power_w: 0, sensor_ok: true }] });
  const headers = { "Idempotency-Key": "click-123" };
  const a = await create("cmd-ch2", "ON", { headers });
  const b = await create("cmd-ch2", "ON", { headers });
  assert.equal(a.status, 202);
  assert.equal(b.status, 200);
  assert.equal(b.body.replayed, true);
  assert.equal(a.body.command_id, b.body.command_id);
  assert.equal((await h.q(`SELECT COUNT(*)::int n FROM commands WHERE idempotency_key = 'click-123'`))[0].n, 1);
  const reused = await create("cmd-ch2", "OFF", { headers });
  assert.equal(reused.status, 409);
});

test("user B cannot see or create commands for user A", async () => {
  const c = await create("cmd-ch2", "OFF");
  assert.equal((await status(c.body.command_id, other.token)).status, 404);
  assert.equal((await h.request("GET", "/api/breakers/cmd-ch2/commands", { token: other.token })).status, 404);
  const list = await h.request("GET", "/api/breakers/cmd-ch2/commands", { token: owner.token });
  assert.ok(list.body.commands.length >= 5);
  assert.equal((await h.request("POST", "/api/devices/cmd-ctrl/command", { token: other.token, body: { status: "OFF" } })).status, 404);
});

test("new-API command on channel 1 is mirrored for legacy firmware polling", async () => {
  await heartbeat();
  const c = await create("cmd-ctrl", "ON");
  assert.equal(c.status, 202);
  const legacyPoll = await h.request("POST", "/readings/command", { apiKey: key, body: { device_id: "cmd-ctrl" } });
  assert.equal(legacyPoll.body.requested_status, "ON");
  await h.sendReading(key, { device_id: "cmd-ctrl", voltage: 120, current: 1, power: 120, status: "ON" });
  assert.equal((await status(c.body.command_id)).body.status, "APPLIED");
});
