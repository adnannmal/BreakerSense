// Train/test split, confusion matrix and accuracy numbers for the appliance guesser.
//
// The split is by RECORDING SESSION: all readings from one run of the kettle are either in
// training or in testing, never both. Splitting individual 3-second readings would put
// near-identical neighbouring samples on both sides and inflate accuracy.

const { mulberry32, shuffle, round } = require("./stats");

const UNKNOWN = "Unknown";

// Hold out ~testFraction of each appliance's sessions (at least 1, and always keep ≥1 for training).
function splitBySession(examples, { testFraction = 0.3, seed = 42 } = {}) {
  const rng = mulberry32(seed);
  const sessionsByLabel = new Map();
  for (const e of examples) {
    if (!sessionsByLabel.has(e.label)) sessionsByLabel.set(e.label, new Set());
    sessionsByLabel.get(e.label).add(String(e.session_id));
  }
  const testIds = new Set();
  for (const label of [...sessionsByLabel.keys()].sort()) {
    const ids = shuffle([...sessionsByLabel.get(label)].sort(), rng);
    if (ids.length < 2) continue;
    const nTest = Math.min(ids.length - 1, Math.max(1, Math.round(ids.length * testFraction)));
    ids.slice(0, nTest).forEach((id) => testIds.add(id));
  }
  return {
    train: examples.filter((e) => !testIds.has(String(e.session_id))),
    test: examples.filter((e) => testIds.has(String(e.session_id))),
  };
}

// pairs: [{ actual, predicted }] where predicted === null means Unknown.
// Rows = actual appliance, columns = predicted appliance + "Unknown".
function confusionMatrix(pairs, labels) {
  const columns = [...labels, UNKNOWN];
  const index = new Map(columns.map((c, i) => [c, i]));
  const matrix = labels.map(() => columns.map(() => 0));
  for (const { actual, predicted } of pairs) {
    const r = labels.indexOf(actual);
    if (r < 0) continue;
    const c = index.has(predicted) ? index.get(predicted) : index.get(UNKNOWN);
    matrix[r][c]++;
  }
  return { rows: labels, columns, matrix };
}

// Summary for pairs whose actual appliance was in training. Unknown counts as wrong.
function summarize(pairs, labels) {
  const n = pairs.length;
  const correct = pairs.filter((p) => p.predicted === p.actual).length;
  const unknown = pairs.filter((p) => p.predicted === null).length;
  const answered = n - unknown;

  const perClass = {};
  const f1s = [];
  for (const label of labels) {
    const tp = pairs.filter((p) => p.actual === label && p.predicted === label).length;
    const predictedAs = pairs.filter((p) => p.predicted === label).length;
    const support = pairs.filter((p) => p.actual === label).length;
    const precision = predictedAs ? tp / predictedAs : null;
    const recall = support ? tp / support : null;
    const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : support ? 0 : null;
    if (support) f1s.push(f1);
    perClass[label] = { support, precision: round(precision, 3), recall: round(recall, 3), f1: round(f1, 3) };
  }

  return {
    n,
    accuracy: n ? round(correct / n, 3) : null,
    macro_f1: f1s.length ? round(f1s.reduce((a, b) => a + b, 0) / f1s.length, 3) : null,
    unknown_rate: n ? round(unknown / n, 3) : null,
    accuracy_when_answered: answered ? round(correct / answered, 3) : null,
    per_class: perClass,
    confusion: confusionMatrix(pairs, labels),
  };
}

// For appliances deliberately left out of training: did the model correctly say Unknown?
function summarizeOpenSet(pairs) {
  if (!pairs.length) return null;
  const caught = pairs.filter((p) => p.predicted === null).length;
  const misclassifiedAs = {};
  for (const p of pairs) if (p.predicted !== null) misclassifiedAs[p.predicted] = (misclassifiedAs[p.predicted] || 0) + 1;
  return { n: pairs.length, unknown_detection_rate: round(caught / pairs.length, 3), misclassified_as: misclassifiedAs };
}

// Plain-text confusion matrix for the terminal / slides.
function formatConfusion({ rows, columns, matrix }) {
  const width = Math.max(10, ...columns.map((c) => c.length), ...rows.map((r) => r.length)) + 2;
  const pad = (s) => String(s).padStart(width);
  const lines = [pad("actual \\ predicted") + columns.map(pad).join("")];
  rows.forEach((r, i) => lines.push(pad(r) + matrix[i].map(pad).join("")));
  return lines.join("\n");
}

module.exports = { UNKNOWN, splitBySession, confusionMatrix, summarize, summarizeOpenSet, formatConfusion };
