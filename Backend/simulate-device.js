// Fake ESP32 for demoing the dashboard without hardware.
//
//   DEVICE_API_KEY=<key> node simulate-device.js <device_id> [mode] [backend_url]
//
//   mode:  normal   (default) steady readings, everything in range
//          warm     temperature creeps up -> "Watch" on the Temperature card
//          overload current jumps above the breaker's capacity -> alert appears
//          lamp | charger | fan | kettle | heater | microwave
//                   synthetic appliance readings for testing appliance learning (see below)
//
// Examples:
//   node simulate-device.js esp32-1
//   node simulate-device.js esp32-1 overload
//   node simulate-device.js esp32-1 normal https://your-backend.up.railway.app
//
// The device_id must already be added in the dashboard ("Add breaker") — /readings rejects unknown IDs.
// DEVICE_API_KEY is the bk_... key shown once when the device was registered (or its key was rotated).
// It's read from the environment rather than the command line so it doesn't end up in shell history.
// Needs Node 18+ (uses the built-in fetch).

const deviceId = process.argv[2];
const mode = process.argv[3] || "normal";
const baseUrl = (process.argv[4] || process.env.API_URL || "http://localhost:4000").replace(/\/$/, "");
const apiKey = process.env.DEVICE_API_KEY;

if (!deviceId) {
  console.error("Usage: DEVICE_API_KEY=<key> node simulate-device.js <device_id> [normal|warm|overload] [backend_url]");
  process.exit(1);
}

if (!apiKey) {
  console.error("Set DEVICE_API_KEY to the device's bk_... key (POST /readings requires the X-API-Key header).");
  process.exit(1);
}

const jitter = (amount) => (Math.random() - 0.5) * 2 * amount;
let tick = 0;

// Appliance modes (lamp, charger, fan, kettle, heater, microwave) send SYNTHETIC 120 V readings
// with power_factor/frequency, so the appliance-learning pipeline can be tried without hardware:
//   node scripts/ml.js record esp32-1 kettle 60 --simulated     (start the simulator when told "TURN ON")
// Sessions recorded this way MUST use --simulated; training ignores them by default.
const { PROFILES, sampleReading } = require("./ml/synthetic");
const startedAt = Date.now();
let energyKwh = 0;

function makeReading() {
  tick++;
  if (PROFILES[mode]) {
    const r = sampleReading(PROFILES[mode], (Date.now() - startedAt) / 1000, Math.random);
    energyKwh += (r.power * 3) / 3600 / 1000;
    return { device_id: deviceId, ...r, energy_kwh: Number(energyKwh.toFixed(4)) };
  }
  const voltage = 237 + jitter(2);
  let current = 15 + jitter(2.5);
  let temperature = 38 + jitter(1.5);

  if (mode === "warm") temperature = 55 + Math.min(tick * 0.15, 4) + jitter(0.5);   // creeps toward the 60°C default limit
  if (mode === "overload") {
    current = 26 + jitter(1.5);                                                      // above a 20 A breaker
    temperature = 52 + jitter(1);
  }

  return {
    device_id: deviceId,
    voltage: Number(voltage.toFixed(1)),
    current: Number(current.toFixed(1)),
    power: Number((voltage * current).toFixed(0)),
    temperature: Number(temperature.toFixed(1)),
  };
}

async function send() {
  const reading = makeReading();
  try {
    const res = await fetch(`${baseUrl}/readings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify(reading),
    });
    const body = await res.json();
    console.log(res.ok ? "sent" : `FAILED (${res.status}: ${body.error})`, JSON.stringify(reading));
  } catch (err) {
    console.error("Could not reach backend:", err.message);
  }
}

console.log(`Simulating "${deviceId}" in "${mode}" mode -> ${baseUrl}/readings every 3s (Ctrl+C to stop)`);
send();
setInterval(send, 3000);