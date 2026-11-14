// Small numeric helpers shared by the appliance-classifier code. No dependencies.

function finite(values) {
  return values.filter((v) => typeof v === "number" && Number.isFinite(v));
}

function mean(values) {
  const v = finite(values);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function median(values) {
  const v = finite(values).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Sample standard deviation (n - 1). Returns 0 for a single value, null for none.
function std(values) {
  const v = finite(values);
  if (v.length === 0) return null;
  if (v.length === 1) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

// Linear-interpolated quantile, q in [0, 1].
function quantile(values, q) {
  const v = finite(values).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function round(x, digits = 4) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// Deterministic PRNG so a train/test split can be reproduced from its seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = { finite, mean, median, std, quantile, clamp, round, mulberry32, shuffle };
