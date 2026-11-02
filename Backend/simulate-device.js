// Fake ESP32 for demoing the dashboard and remote commands without hardware.
//
//   DEVICE_API_KEY=<key> node simulate-device.js <device_id> [mode] [backend_url]
//
//   mode:  normal   (default) steady readings, everything in range
//          warm     temperature creeps up -> "Watch" on the Temperature card
//          overload current jumps above the breaker's capacity -> alert appears
//          sensorfail  every 5th report is a PZEM failure (sensor_status "error")
//
// Examples:
//   node simulate-device.js esp32-1
//   node simulate-device.js esp32-1 overload
//   node simulate-device.js esp32-1 normal https://your-backend.up.railway.app
//
// Optional env:
//   BREAKER_IDS=breaker-001,breaker-002   simulate several channels on this controller
//                                         (each must be registered; default breaker-001)
//
// It sends the PZEM payload from docs/API_CONTRACT.md every 3 s per breaker, and polls
// /api/device/commands/poll every 2 s: ON/OFF commands are applied and acknowledged,
// so the dashboard's command flow can be tested end to end.
//
// The device_id must already be added in the dashboard ("Add breaker") — /readings rejects unknown IDs.
// DEVICE_API_KEY is the bk_... key shown once when the device was registered (or its key was rotated).
// It's read from the environment rather than the command line so it doesn't end up in shell history.
// Needs Node 18+ (uses the built-in fetch).

const deviceId = process.argv[2];
const mode = process.argv[3] || "normal";
const baseUrl = (process.argv[4] || process.env.API_URL || "http://localhost:4000").replace(/\/$/, "");
const apiKey = process.env.DEVICE_API_KEY;
const breakerIds = (process.env.BREAKER_IDS || "breaker-001").split(",").map((b) => b.trim()).filter(Boolean);

if (!deviceId) {
  console.error("Usage: DEVICE_API_KEY=<key> node simulate-device.js <device_id> [normal|warm|overload|sensorfail] [backend_url]");
  process.exit(1);
}

if (!apiKey) {
  console.error("Set DEVICE_API_KEY to the device's bk_... key (POST /readings requires the X-API-Key header).");
  process.exit(1);
}

const headers = { "Content-Type": "application/json", "X-API-Key": apiKey };
const jitter = (amount) => (Math.random() - 0.5) * 2 * amount;
const state = Object.fromEntries(breakerIds.map((id) => [id, { contactor: "ON", energy: 0 }]));
const executed = new Set(); // command_ids already applied — never apply one twice
let tick = 0;

function makeReading(breakerId) {
  tick++;
  const s = state[breakerId];
  if (mode === "sensorfail" && tick % 5 === 0) {
    return { controller_id: deviceId, breaker_id: breakerId, contactor_state: s.contactor, sensor_status: "error", sensor_error: "simulated PZEM timeout" };
  }

  const voltage = 120 + jitter(1.5);
  let current = 8 + jitter(1.5);
  let temperature = 38 + jitter(1.5);
  if (mode === "warm") temperature = 55 + Math.min(tick * 0.15, 4) + jitter(0.5); // creeps toward the 60°C default limit
  if (mode === "overload") {
    current = 26 + jitter(1.5); // above a 20 A breaker
    temperature = 52 + jitter(1);
  }
  if (s.contactor !== "ON") current = 0; // OFF: voltage upstream, no load current

  const powerFactor = current === 0 ? 0 : 0.95 + jitter(0.03);
  const apparent = voltage * current;
  const power = apparent * powerFactor;
  s.energy += power * 3 / 3_600_000; // 3 s worth, in kWh

  return {
    controller_id: deviceId,
    breaker_id: breakerId,
    voltage: Number(voltage.toFixed(1)),
    current: Number(current.toFixed(3)),
    power: Number(power.toFixed(1)),
    apparent_power: Number(apparent.toFixed(2)),
    energy_kwh: Number(s.energy.toFixed(4)),
    frequency: Number((60 + jitter(0.05)).toFixed(2)),
    power_factor: Number(Math.min(1, powerFactor).toFixed(2)),
    temperature: Number(temperature.toFixed(1)),
    contactor_state: s.contactor,
    sensor_status: "online",
  };
}

async function send(breakerId) {
  const reading = makeReading(breakerId);
  try {
    const res = await fetch(`${baseUrl}/readings`, { method: "POST", headers, body: JSON.stringify(reading) });
    const body = await res.json();
    console.log(res.ok ? "sent" : `FAILED (${res.status} ${body.code}: ${body.error})`, JSON.stringify(reading));
  } catch (err) {
    console.error("Could not reach backend:", err.message);
  }
}

async function pollCommands() {
  try {
    const res = await fetch(`${baseUrl}/api/device/commands/poll`, { method: "POST", headers, body: "{}" });
    if (!res.ok) return console.error(`Poll failed (${res.status})`);
    const { commands, server_time } = await res.json();
    for (const cmd of commands) {
      const s = state[cmd.breaker_id];
      let ack;
      if (executed.has(cmd.command_id)) {
        // Redelivered because our earlier ack was lost: re-ack, don't execute again.
        ack = { status: "succeeded", contactor_state: s.contactor };
      } else if (new Date(cmd.expires_at) <= new Date(server_time)) {
        continue; // never run an expired command
      } else if (!s) {
        ack = { status: "failed", error: `breaker ${cmd.breaker_id} is not simulated` };
      } else {
        s.contactor = cmd.requested_state;
        executed.add(cmd.command_id);
        ack = { status: "succeeded", contactor_state: s.contactor };
        console.log(`command ${cmd.command_id}: ${cmd.breaker_id} -> ${cmd.requested_state}`);
      }
      await fetch(`${baseUrl}/api/device/commands/${cmd.command_id}/ack`, { method: "POST", headers, body: JSON.stringify(ack) });
    }
  } catch (err) {
    console.error("Could not poll commands:", err.message);
  }
}

console.log(`Simulating "${deviceId}" [${breakerIds.join(", ")}] in "${mode}" mode -> ${baseUrl} every 3s (Ctrl+C to stop)`);
const sendAll = () => breakerIds.forEach(send);
sendAll();
setInterval(sendAll, 3000);
setInterval(pollCommands, 2000);