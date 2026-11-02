// Connection health from the last time the server heard from a controller/breaker.
// The ESP32 reports every ~3 s, so by default:
//   online  — heard from within STALE_AFTER_SECONDS (15 s ≈ 5 missed reports)
//   stale   — within OFFLINE_AFTER_SECONDS (60 s)
//   offline — longer than that
//   never   — has never reported
function thresholds() {
  const stale = Number(process.env.STALE_AFTER_SECONDS) > 0 ? Number(process.env.STALE_AFTER_SECONDS) : 15;
  const offline = Number(process.env.OFFLINE_AFTER_SECONDS) > 0 ? Number(process.env.OFFLINE_AFTER_SECONDS) : 60;
  return { stale, offline: Math.max(offline, stale) };
}

function connectionStatus(lastSeen, now = Date.now()) {
  if (!lastSeen) return "never";
  const ageSeconds = (now - new Date(lastSeen).getTime()) / 1000;
  const t = thresholds();
  if (ageSeconds <= t.stale) return "online";
  if (ageSeconds <= t.offline) return "stale";
  return "offline";
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

// The public shape of a breaker (docs/API_CONTRACT.md "Breaker object").
function formatBreaker(row, now = Date.now()) {
  return {
    controller_id: row.controller_id,
    breaker_id: row.breaker_id,
    channel_number: row.channel_number,
    name: row.name,
    capacity_amps: row.capacity_amps,
    thresholds: {
      voltage: row.voltage_threshold,
      current: row.current_threshold,
      power: row.power_threshold,
      temperature: row.temperature_threshold,
    },
    health: {
      connection: connectionStatus(row.last_seen, now),
      sensor_status: row.sensor_status,
      sensor_error: row.sensor_error,
      last_seen: iso(row.last_seen),
    },
    // Reported by firmware = the state it last COMMANDED, not independently verified contactor position.
    reported_contactor_state: row.contactor_state,
    latest: row.last_good_at
      ? {
          voltage: row.voltage,
          current: row.current,
          power: row.power,
          apparent_power: row.apparent_power,
          energy_kwh: row.energy_kwh,
          frequency: row.frequency,
          power_factor: row.power_factor,
          temperature: row.temperature,
          measured_at: iso(row.last_good_at),
        }
      : null,
    created_at: iso(row.created_at),
  };
}

module.exports = { connectionStatus, formatBreaker, thresholds, iso };