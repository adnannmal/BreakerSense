// Turn a run of PZEM readings into appliance features.
//
// Idea: an appliance shows up as a JUMP in real power. We find the jump (onset), take the
// circuit's power just before it as the baseline, and describe what was added on top:
//
//   power_w              average real power added by the appliance (steady state)        W
//   current_a            average current added                                           A
//   apparent_power_va    average apparent power added (V * I)                            VA
//   power_factor         appliance power factor (PZEM value on an idle circuit,
//                        otherwise added W / added VA)                                   0..1
//   power_cv             power variation = std(power) / added power (steady state)       ratio
//   startup_spike_ratio  peak power right after the jump / steady power (null when the
//                        appliance was already on when the window started)               ratio
//
// Limits worth saying out loud in the presentation:
// - The firmware samples about every 3 s, so "startup spike" means the first 1–2 samples after
//   the jump, not a true millisecond inrush.
// - Subtracting a baseline works when ONE appliance changes at a time. Several appliances
//   switching together on one breaker cannot be separated reliably from one meter.

const { mean, median, std, clamp, round } = require("./stats");

const FEATURE_VERSION = "appliance-features-v1";

const DEFAULTS = {
  minSamples: 5,          // fewer readings than this -> TOO_FEW_SAMPLES
  onsetMinDeltaW: 2.5,    // smallest jump treated as "something turned on" (phone chargers are ~5 W)
  onsetRelative: 0.1,     // ...and at least 10% of what was already running
  onsetConfirmSamples: 2, // the jump must hold for this many readings (ignores one-sample noise)
  baselineSamples: 3,     // readings before the jump used to judge it
  settleSamples: 2,       // readings after the jump skipped before "steady state"
  spikeSamples: 2,        // readings after the jump searched for the startup peak
  offFraction: 0.3,       // power falling below 30% of the added level = appliance turned off
  minSteadySamples: 3,
  noLoadW: 1.5,           // added power below this = nothing is running
};

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Accepts rows from readings_log (created_at) or ml_session_readings (recorded_at).
// Rows without a usable power value are dropped rather than treated as 0 W.
function cleanReadings(readings) {
  return (readings || [])
    .map((r) => {
      const voltage = num(r.voltage);
      const current = num(r.current);
      return {
        t: new Date(r.recorded_at ?? r.created_at ?? r.t).getTime(),
        voltage,
        current,
        power: num(r.power),
        power_factor: num(r.power_factor),
        apparent: voltage !== null && current !== null ? voltage * current : null,
      };
    })
    .filter((r) => Number.isFinite(r.t) && r.power !== null && r.power >= 0)
    .sort((a, b) => a.t - b.t);
}

function detectOnset(power, opts) {
  for (let i = 1; i + opts.onsetConfirmSamples <= power.length; i++) {
    const base = median(power.slice(Math.max(0, i - opts.baselineSamples), i));
    const confirm = power.slice(i, i + opts.onsetConfirmSamples);
    const threshold = Math.max(opts.onsetMinDeltaW, opts.onsetRelative * base);
    if (Math.min(...confirm) - base >= threshold) return i;
  }
  return -1;
}

function iso(t) {
  return new Date(t).toISOString();
}

// Returns { ok: true, features, ... } or { ok: false, reason, ... }.
// reason: TOO_FEW_SAMPLES | NO_LOAD_DETECTED | EVENT_TOO_SHORT
function extractApplianceEvent(readings, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const rows = cleanReadings(readings);
  const base = { feature_version: FEATURE_VERSION, total_samples: rows.length };

  if (rows.length < opts.minSamples) {
    return { ...base, ok: false, reason: "TOO_FEW_SAMPLES" };
  }

  const power = rows.map((r) => r.power);
  const onset = detectOnset(power, opts);
  const onsetDetected = onset > 0;

  // Baseline = what the circuit drew before the appliance turned on (0 if it was already on).
  let baselineP = 0;
  let baselineS = 0;
  let baselineI = 0;
  if (onsetDetected) {
    const pre = rows.slice(Math.max(0, onset - 10), onset);
    baselineP = median(pre.map((r) => r.power));
    baselineS = median(pre.map((r) => r.apparent)) ?? 0;
    baselineI = median(pre.map((r) => r.current)) ?? 0;
  }

  // Steady-state window: skip the settle period, stop when the appliance turns off.
  let start = onsetDetected ? Math.min(onset + opts.settleSamples, rows.length - 1) : 0;
  const level = (median(power.slice(start, start + 5)) ?? 0) - baselineP;
  let end = rows.length;
  if (level > 0) {
    for (let j = start + 1; j < rows.length; j++) {
      const below = (k) => power[k] - baselineP < opts.offFraction * level;
      if (below(j) && (j + 1 >= rows.length || below(j + 1))) {
        end = j;
        break;
      }
    }
  }
  if (end - start < opts.minSteadySamples && onsetDetected) start = onset; // short event: keep settle samples
  if (end - start < 2) {
    return { ...base, ok: false, reason: "EVENT_TOO_SHORT", onset_detected: onsetDetected };
  }

  const win = rows.slice(start, end);
  const addedP = Math.max(0, mean(win.map((r) => r.power)) - baselineP);

  if (addedP < opts.noLoadW) {
    return { ...base, ok: false, reason: "NO_LOAD_DETECTED", onset_detected: onsetDetected, power_w: round(addedP, 2) };
  }

  const meanS = mean(win.map((r) => r.apparent));
  const addedS = meanS === null ? null : Math.max(0, meanS - baselineS);
  const meanI = mean(win.map((r) => r.current));
  const addedI = meanI === null ? null : Math.max(0, meanI - baselineI);

  // On an idle circuit the PZEM's own PF is the best value; with other loads running,
  // estimate the appliance's PF from the added W and VA.
  const reportedPf = mean(win.map((r) => r.power_factor));
  let pf = null;
  if (baselineP < opts.noLoadW && reportedPf !== null) pf = reportedPf;
  else if (addedS !== null && addedS > 0.5) pf = addedP / addedS;
  else if (reportedPf !== null) pf = reportedPf;
  if (pf !== null) pf = clamp(pf, 0, 1);

  const powerCv = (std(win.map((r) => r.power)) ?? 0) / Math.max(addedP, 1);

  let spike = null;
  if (onsetDetected) {
    const peak = Math.max(...power.slice(onset, onset + opts.spikeSamples));
    spike = clamp((peak - baselineP) / Math.max(addedP, 0.1), 0.5, 20);
  }

  return {
    ...base,
    ok: true,
    onset_detected: onsetDetected,
    onset_at: onsetDetected ? iso(rows[onset].t) : null,
    off_at: end < rows.length ? iso(rows[end].t) : null,
    baseline_power_w: round(baselineP, 2),
    steady_samples: win.length,
    steady_from: iso(win[0].t),
    steady_to: iso(win[win.length - 1].t),
    features: {
      power_w: round(addedP, 2),
      current_a: round(addedI, 4),
      apparent_power_va: round(addedS, 2),
      power_factor: round(pf, 3),
      power_cv: round(powerCv, 4),
      startup_spike_ratio: round(spike, 3),
    },
  };
}

// For LIVE prediction: keep only what is relevant to the load running NOW.
// Finds the most recent step in power (median of 3 samples vs the 3 before, change of at least
// max(onsetMinDeltaW, 15% of the larger level)).
//   step UP   -> keep up to 10 samples before it (baseline) + everything after: the added appliance
//   step DOWN -> keep only samples after it: whatever is still running
//   no step   -> keep everything
function recentEventWindow(readings, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const rows = cleanReadings(readings);
  const p = rows.map((r) => r.power);
  for (let i = p.length - 2; i >= 3; i--) {
    const after = median(p.slice(i, i + 3));
    const before = median(p.slice(i - 3, i));
    const threshold = Math.max(opts.onsetMinDeltaW, 0.15 * Math.max(after, before));
    if (Math.abs(after - before) >= threshold) {
      const from = after > before ? Math.max(0, i - 10) : i;
      return { rows: rows.slice(from), step: after > before ? "up" : "down", step_at: iso(rows[i].t) };
    }
  }
  return { rows, step: null, step_at: null };
}

// Model input. Power is on a log scale so a 5 W charger and a 1500 W kettle are both
// measured in "percent difference" terms. null = not available (ignored by the distance).
const FEATURE_NAMES = ["log10_power_w", "power_factor", "power_cv", "log2_startup_spike"];

function toVector(features) {
  return [
    Math.log10(Math.max(features.power_w, 0.1)),
    features.power_factor ?? null,
    features.power_cv === null || features.power_cv === undefined ? null : Math.min(features.power_cv, 2),
    features.startup_spike_ratio ? Math.log2(features.startup_spike_ratio) : null,
  ];
}

module.exports = { FEATURE_VERSION, FEATURE_NAMES, DEFAULTS, cleanReadings, extractApplianceEvent, recentEventWindow, toVector };
