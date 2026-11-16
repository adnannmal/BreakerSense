// SYNTHETIC appliance readings for tests and the simulator. These are made-up, rough
// profiles at 120 V — NOT measurements, and NOT a substitute for the real PZEM recordings.
// Never train the presentation model on them (sessions from the simulator must be marked
// is_simulated: true, which training excludes by default).

const PROFILES = {
  lamp:      { power_w: 60,   power_factor: 0.99, noise: 0.01,  spike: 1.0 },
  charger:   { power_w: 6,    power_factor: 0.55, noise: 0.04,  spike: 1.0 },
  fan:       { power_w: 45,   power_factor: 0.8,  noise: 0.02,  spike: 1.4 },
  kettle:    { power_w: 1450, power_factor: 1.0,  noise: 0.005, spike: 1.0 },
  heater:    { power_w: 900,  power_factor: 1.0,  noise: 0.01,  spike: 1.08 },
  microwave: { power_w: 1150, power_factor: 0.92, noise: 0.08,  spike: 1.2 },
};

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// One reading for an appliance that is `secondsOn` seconds into its run (null = off).
function sampleReading(profile, secondsOn, rng, { voltage = 120, basePower = 0, sessionScale = 1 } = {}) {
  const v = voltage + gaussian(rng) * 0.4;
  let p = basePower + Math.abs(gaussian(rng)) * 0.05; // tiny idle noise
  let pf = basePower > 0 ? 0.95 : null;
  if (secondsOn !== null && profile) {
    const steady = profile.power_w * sessionScale * (1 + gaussian(rng) * profile.noise);
    const spike = secondsOn < 3 ? profile.spike : 1;
    p = basePower + Math.max(0, steady * spike);
    pf = profile.power_factor;
  }
  const apparent = pf ? p / pf : p;
  const current = apparent / v;
  return {
    voltage: Number(v.toFixed(1)),
    current: Number(current.toFixed(3)),
    power: Number(p.toFixed(1)),
    power_factor: pf === null ? null : Number(pf.toFixed(2)),
    frequency: 60.0,
  };
}

// A full recording: offSeconds idle, onSeconds running, tailSeconds idle, one reading every 3 s.
function generateSession(name, rng, { offSeconds = 15, onSeconds = 60, tailSeconds = 9, basePower = 0, startMs = Date.UTC(2026, 10, 14, 12) } = {}) {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`unknown synthetic profile ${name}`);
  const sessionScale = 1 + gaussian(rng) * 0.03; // run-to-run variation (temperature, mains voltage)
  const readings = [];
  const total = offSeconds + onSeconds + tailSeconds;
  for (let t = 0; t < total; t += 3) {
    const secondsOn = t >= offSeconds && t < offSeconds + onSeconds ? t - offSeconds : null;
    readings.push({ recorded_at: new Date(startMs + t * 1000).toISOString(), ...sampleReading(profile, secondsOn, rng, { basePower, sessionScale }) });
  }
  return readings;
}

module.exports = { PROFILES, sampleReading, generateSession };
