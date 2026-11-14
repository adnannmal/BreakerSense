// Appliance guesser: k-nearest-neighbours over the feature vectors from features.js,
// with an explicit "Unknown" answer.
//
// Why kNN: with 4–6 appliances × 5–10 recordings there are only ~20–60 examples. kNN needs
// no tuning, is easy to explain ("it looks most like these recorded kettle runs"), and gives a
// natural way to say Unknown: if the closest recording is far away, the load is unlike
// anything we trained on.
//
// Answers Unknown when
//   FAR_FROM_TRAINING  nearest recording is farther than the calibrated distance limit
//   AMBIGUOUS          the nearest recordings disagree (vote share below minVoteShare)
//
// "confidence" is the distance-weighted vote share of the winning label among the k nearest
// recordings. It is a heuristic agreement score, NOT a calibrated probability.

const { FEATURE_NAMES, FEATURE_VERSION } = require("./features");
const { mean, quantile, round } = require("./stats");

const MODEL_TYPE = "knn-v1";

// Smallest allowed scale per feature, so a feature that happened to be very consistent in
// training (e.g. PF 1.00 for every heater run) can't make tiny real-world differences look huge.
const MIN_SCALES = [0.04, 0.04, 0.03, 0.15];

const DEFAULT_OPTIONS = {
  k: 3,
  minVoteShare: 0.6,
  unknownQuantile: 0.95,
  unknownMargin: 1.5,
  minUnknownDistance: 3,
};

// Pooled within-appliance standard deviation per feature = "typical run-to-run noise".
function fitScales(examples) {
  return FEATURE_NAMES.map((_, d) => {
    const byLabel = new Map();
    for (const e of examples) {
      const v = e.vector[d];
      if (v === null || v === undefined) continue;
      if (!byLabel.has(e.label)) byLabel.set(e.label, []);
      byLabel.get(e.label).push(v);
    }
    let sumSq = 0;
    let dof = 0;
    for (const vals of byLabel.values()) {
      if (vals.length < 2) continue;
      const m = mean(vals);
      sumSq += vals.reduce((a, v) => a + (v - m) ** 2, 0);
      dof += vals.length - 1;
    }
    const s = dof > 0 ? Math.sqrt(sumSq / dof) : 0;
    return Math.max(s, MIN_SCALES[d]);
  });
}

// Scaled Euclidean distance over the features both vectors have; rescaled so a distance using
// 3 of 4 features is comparable to one using all 4. Infinity if nothing is comparable.
function distance(a, b, scales) {
  let sum = 0;
  let used = 0;
  for (let d = 0; d < scales.length; d++) {
    if (a[d] === null || a[d] === undefined || b[d] === null || b[d] === undefined) continue;
    sum += ((a[d] - b[d]) / scales[d]) ** 2;
    used++;
  }
  if (used === 0) return Infinity;
  return Math.sqrt((sum * scales.length) / used);
}

// examples: [{ label, vector, session_id }]
function trainKnn(examples, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!examples.length) throw new Error("trainKnn needs at least one example");
  const scales = fitScales(examples);

  // Calibrate the Unknown limit: how far is each recording from the nearest OTHER recording of
  // the same appliance? Loads farther than (95th percentile × margin) are called Unknown.
  const sameLabelDistances = [];
  for (const e of examples) {
    let best = Infinity;
    for (const o of examples) {
      if (o === e || o.label !== e.label || o.session_id === e.session_id) continue;
      best = Math.min(best, distance(e.vector, o.vector, scales));
    }
    if (Number.isFinite(best)) sameLabelDistances.push(best);
  }
  const q = quantile(sameLabelDistances, opts.unknownQuantile);
  const unknownDistance = Math.max(opts.minUnknownDistance, (q ?? 0) * opts.unknownMargin);

  return {
    type: MODEL_TYPE,
    feature_version: FEATURE_VERSION,
    feature_names: FEATURE_NAMES,
    k: opts.k,
    min_vote_share: opts.minVoteShare,
    unknown_distance: round(unknownDistance, 4),
    scales: scales.map((s) => round(s, 6)),
    labels: [...new Set(examples.map((e) => e.label))].sort(),
    examples: examples.map((e) => ({ label: e.label, session_id: e.session_id, vector: e.vector })),
  };
}

function predictKnn(model, vector) {
  const neighbours = model.examples
    .map((e) => ({ label: e.label, session_id: e.session_id, d: distance(vector, e.vector, model.scales) }))
    .filter((n) => Number.isFinite(n.d))
    .sort((a, b) => a.d - b.d);

  if (neighbours.length === 0) {
    return { label: null, is_unknown: true, reason: "NO_COMPARABLE_FEATURES", confidence: null, candidate: null, nearest_distance: null };
  }

  const top = neighbours.slice(0, Math.min(model.k, neighbours.length));
  const votes = new Map();
  for (const n of top) votes.set(n.label, (votes.get(n.label) || 0) + 1 / (n.d + 0.1));
  const total = [...votes.values()].reduce((a, b) => a + b, 0);
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [candidate, weight] = ranked[0];
  const share = weight / total;
  const nearest = neighbours[0].d;

  const result = {
    candidate,
    confidence: round(share, 3),
    nearest_distance: round(nearest, 3),
    unknown_distance: model.unknown_distance,
    runner_up: ranked[1] ? ranked[1][0] : null,
    neighbours: top.map((n) => ({ label: n.label, session_id: n.session_id, distance: round(n.d, 3) })),
  };

  if (nearest > model.unknown_distance) return { ...result, label: null, is_unknown: true, reason: "FAR_FROM_TRAINING" };
  if (share < model.min_vote_share) return { ...result, label: null, is_unknown: true, reason: "AMBIGUOUS" };
  return { ...result, label: candidate, is_unknown: false, reason: null };
}

// Naive comparison baseline for the presentation: "pick the appliance whose typical wattage
// is closest". Uses power only and never says Unknown.
function trainPowerBaseline(examples) {
  const byLabel = new Map();
  for (const e of examples) {
    if (!byLabel.has(e.label)) byLabel.set(e.label, []);
    byLabel.get(e.label).push(e.vector[0]);
  }
  const centers = [...byLabel.entries()].map(([label, v]) => ({ label, logPower: v.sort((a, b) => a - b)[Math.floor(v.length / 2)] }));
  return { type: "power-band-baseline", centers };
}

function predictPowerBaseline(baseline, vector) {
  let best = null;
  for (const c of baseline.centers) {
    const d = Math.abs(vector[0] - c.logPower);
    if (!best || d < best.d) best = { label: c.label, d };
  }
  return { label: best ? best.label : null, is_unknown: false };
}

module.exports = { MODEL_TYPE, DEFAULT_OPTIONS, fitScales, distance, trainKnn, predictKnn, trainPowerBaseline, predictPowerBaseline };
