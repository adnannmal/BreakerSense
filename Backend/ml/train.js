// End-to-end training run (pure, no database): sessions -> features -> held-out evaluation,
// leave-one-session-out cross-validation, power-only baseline, and a final model trained on
// every usable session.

const { extractApplianceEvent, toVector, FEATURE_VERSION } = require("./features");
const { trainKnn, predictKnn, trainPowerBaseline, predictPowerBaseline, MODEL_TYPE } = require("./classifier");
const { splitBySession, summarize, summarizeOpenSet } = require("./evaluate");

const MIN_SESSIONS_PER_LABEL = 2; // absolute minimum to train + test an appliance
const TARGET_SESSIONS_PER_LABEL = 5; // what the Sprint 3 plan asks for

class TrainingDataError extends Error {
  constructor(message, details) {
    super(message);
    this.code = "INSUFFICIENT_TRAINING_DATA";
    this.details = details;
  }
}

// sessions: [{ id, appliance_label, readings: [...] }]
// options: { testFraction, seed, k, unknownTestLabels: [] }
function runTraining(sessions, options = {}) {
  const testFraction = options.testFraction ?? 0.3;
  const seed = options.seed ?? 42;
  const knnOptions = options.k ? { k: options.k } : {};
  const openSetLabels = new Set(options.unknownTestLabels || []);

  const skipped = [];
  const examples = [];
  for (const s of sessions) {
    const ev = extractApplianceEvent(s.readings);
    if (!ev.ok) {
      skipped.push({ session_id: String(s.id), appliance_label: s.appliance_label, reason: ev.reason });
      continue;
    }
    examples.push({ label: s.appliance_label, session_id: String(s.id), vector: toVector(ev.features), features: ev.features });
  }

  const counts = {};
  for (const e of examples) counts[e.label] = (counts[e.label] || 0) + 1;

  const openSet = examples.filter((e) => openSetLabels.has(e.label));
  const known = examples.filter((e) => !openSetLabels.has(e.label));
  const labels = [...new Set(known.map((e) => e.label))].filter((l) => counts[l] >= MIN_SESSIONS_PER_LABEL).sort();
  const tooFew = [...new Set(known.map((e) => e.label))].filter((l) => counts[l] < MIN_SESSIONS_PER_LABEL).sort();

  if (labels.length < 2) {
    throw new TrainingDataError(
      `Need at least 2 appliances with ${MIN_SESSIONS_PER_LABEL}+ usable recordings each`,
      { sessions_per_label: counts, skipped }
    );
  }

  const usable = known.filter((e) => labels.includes(e.label));
  const toPair = (e, prediction) => ({ actual: e.label, predicted: prediction.label, session_id: e.session_id });

  // 1) Held-out test set (the number for the presentation)
  const { train, test } = splitBySession(usable, { testFraction, seed });
  const holdoutModel = trainKnn(train, knnOptions);
  const holdoutPairs = test.map((e) => toPair(e, predictKnn(holdoutModel, e.vector)));
  const openSetPairs = openSet.map((e) => toPair(e, predictKnn(holdoutModel, e.vector)));

  // 2) Same split, naive "closest wattage" baseline
  const baseline = trainPowerBaseline(train);
  const baselinePairs = test.map((e) => toPair(e, predictPowerBaseline(baseline, e.vector)));

  // 3) Leave-one-session-out: every session is tested once by a model that never saw it.
  //    More stable than a single split when there are only a handful of recordings.
  const losoPairs = [];
  for (const e of usable) {
    const rest = usable.filter((o) => o.session_id !== e.session_id);
    if (!rest.some((o) => o.label === e.label)) continue;
    losoPairs.push(toPair(e, predictKnn(trainKnn(rest, knnOptions), e.vector)));
  }

  // 4) Final model uses everything
  const model = trainKnn(usable, knnOptions);

  const warnings = [];
  if (test.length < 10) warnings.push(`Only ${test.length} held-out recordings: treat the accuracy as rough (one mistake moves it ${Math.round(100 / Math.max(test.length, 1))} points).`);
  const belowTarget = labels.filter((l) => counts[l] < TARGET_SESSIONS_PER_LABEL);
  if (belowTarget.length) warnings.push(`Below the ${TARGET_SESSIONS_PER_LABEL}-recording target: ${belowTarget.join(", ")}.`);
  if (tooFew.length) warnings.push(`Left out (fewer than ${MIN_SESSIONS_PER_LABEL} usable recordings): ${tooFew.join(", ")}.`);
  if (!openSet.length) warnings.push("No open-set test: Unknown detection was not measured. Record an appliance that is NOT in training and pass it in unknown_test_labels.");

  return {
    model,
    metrics: {
      model_type: MODEL_TYPE,
      feature_version: FEATURE_VERSION,
      split: { method: "by_session", test_fraction: testFraction, seed, train_sessions: train.length, test_sessions: test.length, test_session_ids: test.map((e) => e.session_id) },
      holdout: summarize(holdoutPairs, labels),
      holdout_predictions: holdoutPairs,
      baseline_power_only: summarize(baselinePairs, labels),
      leave_one_session_out: summarize(losoPairs, labels),
      open_set: summarizeOpenSet(openSetPairs),
    },
    dataset: {
      labels,
      sessions_per_label: counts,
      sessions_used: usable.length,
      open_set_labels: [...openSetLabels],
      excluded_labels: tooFew,
      skipped_sessions: skipped,
    },
    warnings,
  };
}

module.exports = { runTraining, TrainingDataError, MIN_SESSIONS_PER_LABEL, TARGET_SESSIONS_PER_LABEL };
