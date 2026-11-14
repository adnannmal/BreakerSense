// Appliance feature extraction, classifier, Unknown handling and evaluation.
// Uses SYNTHETIC readings (ml/synthetic.js) — these check the code, not real-world accuracy.
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractApplianceEvent, toVector } = require("../ml/features");
const { trainKnn, predictKnn } = require("../ml/classifier");
const { splitBySession, summarize, formatConfusion } = require("../ml/evaluate");
const { runTraining, TrainingDataError } = require("../ml/train");
const { normalizeLabel, checkWindow } = require("../ml/sessions");
const { generateSession, PROFILES } = require("../ml/synthetic");
const { mulberry32 } = require("../ml/stats");

const APPLIANCES = ["lamp", "charger", "fan", "kettle", "heater", "microwave"];

function dataset(perAppliance = 6, seed = 1, names = APPLIANCES) {
  const rng = mulberry32(seed);
  const sessions = [];
  let id = 1;
  for (const name of names) {
    for (let i = 0; i < perAppliance; i++) {
      sessions.push({ id: String(id++), appliance_label: name, readings: generateSession(name, rng) });
    }
  }
  return sessions;
}

// ---------------- features ----------------

test("detects the turn-on jump and measures the appliance", () => {
  const ev = extractApplianceEvent(generateSession("fan", mulberry32(7)));
  assert.equal(ev.ok, true);
  assert.equal(ev.onset_detected, true);
  assert.ok(Math.abs(ev.features.power_w - 45) < 5, `power ${ev.features.power_w}`);
  assert.ok(Math.abs(ev.features.power_factor - 0.8) < 0.03, `pf ${ev.features.power_factor}`);
  assert.ok(ev.features.startup_spike_ratio > 1.2, `spike ${ev.features.startup_spike_ratio}`);
  assert.ok(ev.off_at, "turn-off detected");
});

test("subtracts what was already running on the breaker", () => {
  const ev = extractApplianceEvent(generateSession("lamp", mulberry32(3), { basePower: 200 }));
  assert.equal(ev.ok, true);
  assert.ok(Math.abs(ev.baseline_power_w - 200) < 2, `baseline ${ev.baseline_power_w}`);
  assert.ok(Math.abs(ev.features.power_w - 60) < 5, `added ${ev.features.power_w}`);
});

test("no jump (appliance already on) still measures it, without a startup spike", () => {
  const ev = extractApplianceEvent(generateSession("kettle", mulberry32(5), { offSeconds: 0, onSeconds: 60, tailSeconds: 0 }));
  assert.equal(ev.ok, true);
  assert.equal(ev.onset_detected, false);
  assert.equal(ev.features.startup_spike_ratio, null);
  assert.equal(toVector(ev.features)[3], null);
});

test("idle breaker -> NO_LOAD_DETECTED, too few readings -> TOO_FEW_SAMPLES", () => {
  const idle = Array.from({ length: 20 }, (_, i) => ({ recorded_at: new Date(i * 3000).toISOString(), voltage: 120, current: 0, power: 0 }));
  assert.equal(extractApplianceEvent(idle).reason, "NO_LOAD_DETECTED");
  assert.equal(extractApplianceEvent(idle.slice(0, 3)).reason, "TOO_FEW_SAMPLES");
});

test("missing power values are skipped, not treated as 0 W", () => {
  const rows = generateSession("heater", mulberry32(9));
  rows[10].power = null;
  rows[11].power = "not a number";
  const ev = extractApplianceEvent(rows);
  assert.equal(ev.ok, true);
  assert.ok(ev.features.power_w > 800);
});

// ---------------- classifier ----------------

test("held-out accuracy on clearly different synthetic appliances is high", () => {
  const r = runTraining(dataset(6), { seed: 42 });
  assert.deepEqual(r.model.labels, [...APPLIANCES].sort());
  assert.ok(r.metrics.holdout.accuracy >= 0.9, `holdout ${r.metrics.holdout.accuracy}`);
  assert.ok(r.metrics.leave_one_session_out.accuracy >= 0.9, `loso ${r.metrics.leave_one_session_out.accuracy}`);
  // confusion matrix accounts for every held-out recording, incl. an Unknown column
  const { matrix, columns } = r.metrics.holdout.confusion;
  assert.equal(columns[columns.length - 1], "Unknown");
  assert.equal(matrix.flat().reduce((a, b) => a + b, 0), r.metrics.split.test_sessions);
  assert.match(formatConfusion(r.metrics.holdout.confusion), /kettle/);
});

test("train and test never share a recording session, and the split is reproducible", () => {
  const examples = dataset(6).map((s) => ({ label: s.appliance_label, session_id: s.id, vector: [0, 0, 0, 0] }));
  const a = splitBySession(examples, { seed: 3 });
  const b = splitBySession(examples, { seed: 3 });
  const trainIds = new Set(a.train.map((e) => e.session_id));
  assert.ok(a.test.length > 0);
  assert.ok(a.test.every((e) => !trainIds.has(e.session_id)));
  assert.deepEqual(a.test.map((e) => e.session_id), b.test.map((e) => e.session_id));
  for (const label of APPLIANCES) assert.ok(a.train.some((e) => e.label === label), `${label} kept in training`);
});

test("an appliance never seen in training is called Unknown", () => {
  const sessions = dataset(6, 11);
  const rng = mulberry32(99);
  // ~300 W, PF 0.7: nothing like any trained appliance
  PROFILES.mystery = { power_w: 300, power_factor: 0.7, noise: 0.02, spike: 1.0 };
  try {
    for (let i = 0; i < 3; i++) sessions.push({ id: `m${i}`, appliance_label: "mystery", readings: generateSession("mystery", rng) });
    const r = runTraining(sessions, { unknownTestLabels: ["mystery"] });
    assert.ok(!r.model.labels.includes("mystery"));
    assert.equal(r.metrics.open_set.n, 3);
    assert.equal(r.metrics.open_set.unknown_detection_rate, 1);
  } finally {
    delete PROFILES.mystery;
  }
});

test("disagreeing neighbours -> Unknown (AMBIGUOUS); confidence is a vote share", () => {
  const ex = [
    { label: "a", session_id: "1", vector: [2.0, 0.9, 0.01, null] },
    { label: "a", session_id: "2", vector: [2.002, 0.9, 0.01, null] },
    { label: "b", session_id: "3", vector: [2.001, 0.9, 0.01, null] },
    { label: "b", session_id: "4", vector: [2.003, 0.9, 0.01, null] },
  ];
  const model = trainKnn(ex, { k: 4 });
  const p = predictKnn(model, [2.0015, 0.9, 0.01, null]); // equally close to both appliances
  assert.equal(p.is_unknown, true);
  assert.equal(p.reason, "AMBIGUOUS");
  assert.ok(p.confidence > 0 && p.confidence < 0.6);
});

test("Unknown counts as a miss in accuracy, not as a hit", () => {
  const s = summarize([{ actual: "a", predicted: "a" }, { actual: "b", predicted: null }], ["a", "b"]);
  assert.equal(s.accuracy, 0.5);
  assert.equal(s.unknown_rate, 0.5);
  assert.equal(s.accuracy_when_answered, 1);
});

test("refuses to train without at least 2 appliances with 2+ recordings", () => {
  assert.throws(() => runTraining(dataset(1)), TrainingDataError);
  assert.throws(() => runTraining(dataset(5, 1, ["kettle"])), TrainingDataError);
});

// ---------------- session validation ----------------

test("appliance labels are normalized and reserved words rejected", () => {
  assert.equal(normalizeLabel("  Space   Heater ").value, "space heater");
  assert.ok(normalizeLabel("unknown").error);
  assert.ok(normalizeLabel("").error);
  assert.ok(normalizeLabel("<script>").error);
  assert.ok(normalizeLabel(5).error);
});

test("recording windows must be real, recent and bounded", () => {
  const now = Date.now();
  const at = (msAgo) => new Date(now - msAgo);
  assert.equal(checkWindow(at(60_000), at(0), now), null);
  assert.equal(checkWindow(at(60_000), null, now), null);
  assert.match(checkWindow(at(-3_600_000), null, now), /future/);
  assert.match(checkWindow(at(8 * 24 * 3_600_000), at(8 * 24 * 3_600_000 - 60_000), now), /7-day/);
  assert.match(checkWindow(at(60_000), at(120_000), now), /after/);
  assert.match(checkWindow(at(5_000), at(0), now), /10 seconds/);
  assert.match(checkWindow(at(7 * 3_600_000), at(0), now), /at most/);
});

test("live window keeps only the load running now", () => {
  const { recentEventWindow } = require("../ml/features");
  const t = (i) => new Date(Date.UTC(2026, 0, 1) + i * 3000).toISOString();
  const mk = (powers) => powers.map((power, i) => ({ recorded_at: t(i), voltage: 120, current: power / 120, power }));
  // kettle 1450 W, then swapped for a 330 W load
  const down = recentEventWindow(mk([1450, 1452, 1449, 1451, 1450, 330, 331, 329, 330, 330, 331]));
  assert.equal(down.step, "down");
  assert.ok(down.rows.every((r) => r.power < 400));
  // idle, then fan on: keeps baseline samples before the jump
  const up = recentEventWindow(mk([0.1, 0.1, 0.1, 0.1, 0.1, 63, 45, 45, 45, 45, 45]));
  assert.equal(up.step, "up");
  assert.ok(up.rows[0].power < 1);
  const ev = extractApplianceEvent(up.rows);
  assert.equal(ev.onset_detected, true);
  // steady load: no step, keep everything
  assert.equal(recentEventWindow(mk([60, 60.2, 59.9, 60.1, 60, 60.1])).step, null);
});
