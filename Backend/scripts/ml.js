#!/usr/bin/env node
// Command-line helper for recording labeled appliance data and training the appliance guesser.
// Talks to the backend API (no database access needed). Needs Node 18+.
//
// Auth (pick one; values come from the environment so they stay out of shell history):
//   BREAKERSENSE_TOKEN=<JWT>
//   BREAKERSENSE_EMAIL=<email> BREAKERSENSE_PASSWORD=<password>
// Backend: API_URL (default http://localhost:4000)
//
// Commands:
//   record  <breaker_id> <label> [on_seconds=60] [--off=15] [--tail=10] [--notes="..."] [--simulated]
//           guided run: keep appliance OFF -> "TURN ON NOW" -> "TURN OFF NOW" -> saved
//   start   <breaker_id> <label> [--notes="..."] [--simulated]
//   stop    <session_id>
//   discard <session_id>
//   list    [breaker_id]
//   summary
//   train   [--seed=42] [--test-fraction=0.3] [--k=3] [--unknown=label1,label2] [--include-simulated]
//   model
//   predict <breaker_id> [minutes=3]
//   export  [file=appliance-dataset.json]

const fs = require("node:fs");
const { formatConfusion } = require("../ml/evaluate");

const baseUrl = (process.env.API_URL || "http://localhost:4000").replace(/\/$/, "");
const [command, ...rest] = process.argv.slice(2);
const flags = {};
const args = [];
for (const a of rest) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else args.push(a);
}

let token = process.env.BREAKERSENSE_TOKEN || null;

async function login() {
  if (token) return token;
  const email = process.env.BREAKERSENSE_EMAIL;
  const password = process.env.BREAKERSENSE_PASSWORD;
  if (!email || !password) {
    throw new Error("Set BREAKERSENSE_TOKEN, or BREAKERSENSE_EMAIL and BREAKERSENSE_PASSWORD.");
  }
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Login failed (${res.status})`);
  token = body.token;
  return token;
}

async function api(method, path, body) {
  const t = await login();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error;
    const msg = typeof e === "string" ? e : `${e?.code}: ${e?.message}${e?.details ? " " + JSON.stringify(e.details) : ""}`;
    throw new Error(`${method} ${path} -> ${res.status} ${msg}`);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function countdown(seconds, label) {
  for (let s = seconds; s > 0; s--) {
    process.stdout.write(`\r  ${label} ${String(s).padStart(4)} s `);
    await sleep(1000);
  }
  process.stdout.write("\r" + " ".repeat(40) + "\r");
}

function printSession(s) {
  const f = s.quality_details?.features;
  console.log(
    `#${s.session_id}  ${s.appliance_label.padEnd(12)} ${s.status.padEnd(9)} ${String(s.quality ?? "-").padEnd(16)} ` +
      `samples=${String(s.sample_count).padEnd(4)} ${s.started_at}${s.is_simulated ? "  [SIMULATED]" : ""}` +
      (f ? `\n      ${f.power_w} W, PF ${f.power_factor}, variation ${f.power_cv}, spike ${f.startup_spike_ratio}` : "")
  );
  if (s.quality_details?.note) console.log(`      note: ${s.quality_details.note}`);
}

function printMetrics(name, m) {
  if (!m) return;
  console.log(`\n${name}: accuracy ${m.accuracy} | macro-F1 ${m.macro_f1} | Unknown rate ${m.unknown_rate} | n=${m.n}`);
}

async function main() {
  switch (command) {
    case "start": {
      const [device_id, appliance_label] = args;
      if (!device_id || !appliance_label) throw new Error("usage: start <breaker_id> <label>");
      const s = await api("POST", "/api/ml/sessions", { breaker_id: device_id, appliance_label, notes: flags.notes, is_simulated: flags.simulated === true });
      console.log(`Recording started. Stop it with:  node scripts/ml.js stop ${s.session_id}`);
      return printSession(s);
    }
    case "stop":
      return printSession(await api("POST", `/api/ml/sessions/${args[0]}/stop`, {}));
    case "discard":
      return printSession(await api("POST", `/api/ml/sessions/${args[0]}/discard`, {}));
    case "record": {
      const [device_id, appliance_label, onArg] = args;
      if (!device_id || !appliance_label) throw new Error("usage: record <breaker_id> <label> [on_seconds]");
      const on = Number(onArg || 60);
      const off = Number(flags.off || 15);
      const tail = Number(flags.tail || 10);
      console.log(`\n=== Recording "${appliance_label}" on ${device_id}: ${off}s off, ${on}s on, ${tail}s off ===`);
      console.log("Make sure the appliance is OFF and nothing else on this breaker changes during the run.");
      const s = await api("POST", "/api/ml/sessions", { breaker_id: device_id, appliance_label, notes: flags.notes, is_simulated: flags.simulated === true });
      console.log(`Session #${s.session_id} recording.`);
      try {
        await countdown(off, "keep it OFF ...");
        console.log("\u0007>>> TURN THE APPLIANCE ON NOW <<<");
        await countdown(on, "running ...");
        console.log("\u0007>>> TURN THE APPLIANCE OFF NOW <<<");
        await countdown(tail, "keep it OFF ...");
      } catch (err) {
        await api("POST", `/api/ml/sessions/${s.session_id}/discard`, {}).catch(() => {});
        throw err;
      }
      const done = await api("POST", `/api/ml/sessions/${s.session_id}/stop`, {});
      printSession(done);
      if (done.quality !== "OK") console.log(`Not usable for training (${done.quality}). Check the breaker is reporting, then record again.`);
      return;
    }
    case "list": {
      const q = args[0] ? `?breaker_id=${encodeURIComponent(args[0])}` : "";
      const { sessions } = await api("GET", `/api/ml/sessions${q}`);
      if (!sessions.length) return console.log("No recordings yet.");
      return sessions.forEach(printSession);
    }
    case "summary": {
      const s = await api("GET", "/api/ml/dataset/summary");
      console.log(`Target: ${s.target_sessions_per_appliance} usable recordings per appliance\n`);
      for (const a of s.appliances) {
        console.log(
          `${a.meets_target ? "OK  " : "MORE"}  ${a.appliance_label.padEnd(14)} usable=${a.usable_sessions}  low-quality=${a.low_quality_sessions}  simulated=${a.simulated_sessions}  samples=${a.usable_samples}`
        );
      }
      console.log(`\nready_to_train=${s.ready_to_train}  all_meet_target=${s.all_meet_target}`);
      return;
    }
    case "train": {
      const body = {
        seed: flags.seed ? Number(flags.seed) : undefined,
        test_fraction: flags["test-fraction"] ? Number(flags["test-fraction"]) : undefined,
        k: flags.k ? Number(flags.k) : undefined,
        include_simulated: flags["include-simulated"] === true,
        unknown_test_labels: typeof flags.unknown === "string" ? flags.unknown.split(",") : undefined,
      };
      const r = await api("POST", "/api/ml/train", body);
      console.log(`Trained ${r.model_version} on ${r.dataset.sessions_used} recordings: ${r.labels.join(", ")}`);
      console.log(`Held out ${r.metrics.split.test_sessions} recordings (seed ${r.metrics.split.seed}).`);
      printMetrics("HELD-OUT TEST (k-NN)", r.metrics.holdout);
      console.log(formatConfusion(r.metrics.holdout.confusion));
      printMetrics("Baseline: closest wattage only", r.metrics.baseline_power_only);
      printMetrics("Leave-one-session-out (k-NN)", r.metrics.leave_one_session_out);
      console.log(formatConfusion(r.metrics.leave_one_session_out.confusion));
      if (r.metrics.open_set) console.log(`\nUnseen appliances correctly called Unknown: ${r.metrics.open_set.unknown_detection_rate} (n=${r.metrics.open_set.n})`);
      if (r.warnings.length) console.log("\nWarnings:\n- " + r.warnings.join("\n- "));
      return;
    }
    case "model": {
      const m = await api("GET", "/api/ml/models/latest");
      console.log(`${m.model_version} trained ${m.trained_at} on ${m.training_examples} recordings: ${m.labels.join(", ")}`);
      printMetrics("HELD-OUT TEST", m.metrics.holdout);
      console.log(formatConfusion(m.metrics.holdout.confusion));
      return;
    }
    case "predict": {
      const [device_id, minutes] = args;
      const q = minutes ? `?minutes=${Number(minutes)}` : "";
      const p = await api("GET", `/api/ml/breakers/${encodeURIComponent(device_id)}/prediction${q}`);
      return console.log(JSON.stringify(p, null, 2));
    }
    case "export": {
      const file = args[0] || "appliance-dataset.json";
      const data = await api("GET", "/api/ml/dataset/export");
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      return console.log(`Wrote ${data.sessions.length} sessions to ${file}`);
    }
    default:
      console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 23).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
