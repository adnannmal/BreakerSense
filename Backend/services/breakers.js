// Shared breaker/controller lookups and JSON shapes for the new resource API.

const { config } = require("../config");

const BREAKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

function ageSeconds(v) {
  return v ? Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 1000)) : null;
}

function isRecent(v, seconds) {
  return Boolean(v) && Date.now() - new Date(v).getTime() <= seconds * 1000;
}

function controllerHealth(device) {
  const { onlineAfterSeconds } = config();
  const online = isRecent(device.last_seen_at, onlineAfterSeconds);
  return {
    online,
    status: device.last_seen_at ? (online ? "online" : "offline") : "never_seen",
    last_seen_at: iso(device.last_seen_at),
    seconds_since_seen: ageSeconds(device.last_seen_at),
    online_after_seconds: onlineAfterSeconds,
  };
}

function serializeLatest(l) {
  if (!l || !l.measured_at) return null;
  const { staleAfterSeconds } = config();
  return {
    measured_at: iso(l.measured_at),
    device_recorded_at: iso(l.device_recorded_at),
    voltage: l.voltage,
    current: l.current,
    power: l.power,
    apparent_power: l.apparent_power ?? (l.voltage != null && l.current != null ? Math.round(l.voltage * l.current * 100) / 100 : null),
    apparent_power_source: l.apparent_power != null ? "reported" : l.voltage != null && l.current != null ? "computed_v_times_i" : null,
    power_factor: l.power_factor,
    frequency: l.frequency,
    energy_kwh: l.energy_kwh,
    temperature: l.temperature,
    age_seconds: ageSeconds(l.measured_at),
    stale: !isRecent(l.measured_at, staleAfterSeconds),
  };
}

// row: breakers.* plus optional controller columns (c_last_seen_at) and breaker_latest columns (l_*)
function serializeBreaker(row, { latest } = {}) {
  const ctrl = controllerHealth({ last_seen_at: row.c_last_seen_at });
  const out = {
    breaker_id: row.breaker_id,
    controller_id: row.controller_id,
    channel_number: row.channel_number,
    is_legacy_alias: row.breaker_id === row.controller_id && row.channel_number === 1,
    name: row.name,
    location: row.location,
    rated_current_a: row.rated_current_a,
    thresholds: {
      voltage_threshold: row.voltage_threshold,
      current_threshold: row.current_threshold,
      power_threshold: row.power_threshold,
      temperature_threshold: row.temperature_threshold,
    },
    health: {
      controller_online: ctrl.online,
      controller_status: ctrl.status,
      sensor_status: row.sensor_status,
      sensor_status_at: iso(row.sensor_status_at),
      last_seen_at: iso(row.last_seen_at),
    },
    // What the firmware REPORTED for its output (GPIO). Not independent proof of contactor position.
    reported_contactor_state: row.contactor_state,
    reported_contactor_state_at: iso(row.contactor_state_at),
    physical_feedback_state: "UNKNOWN",
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
  if (latest !== undefined) out.latest = latest;
  return out;
}

const BREAKER_SELECT = `
  SELECT b.*, d.last_seen_at AS c_last_seen_at, d.status AS c_status,
         l.voltage AS l_voltage, l.current AS l_current, l.power AS l_power, l.apparent_power AS l_apparent_power,
         l.power_factor AS l_power_factor, l.frequency AS l_frequency, l.energy_kwh AS l_energy_kwh,
         l.temperature AS l_temperature, l.measured_at AS l_measured_at, l.device_recorded_at AS l_device_recorded_at
  FROM breakers b
  JOIN devices d ON d.device_id = b.controller_id
  LEFT JOIN breaker_latest l ON l.breaker_id = b.breaker_id`;

function latestFromRow(row) {
  return serializeLatest({
    voltage: row.l_voltage,
    current: row.l_current,
    power: row.l_power,
    apparent_power: row.l_apparent_power,
    power_factor: row.l_power_factor,
    frequency: row.l_frequency,
    energy_kwh: row.l_energy_kwh,
    temperature: row.l_temperature,
    measured_at: row.l_measured_at,
    device_recorded_at: row.l_device_recorded_at,
  });
}

async function loadOwnedBreaker(db, userId, breakerId) {
  const r = await db.query(`${BREAKER_SELECT} WHERE b.breaker_id = $1 AND b.user_id = $2`, [breakerId, userId]);
  return r.rows[0] || null;
}

module.exports = {
  BREAKER_ID_RE,
  BREAKER_SELECT,
  iso,
  isRecent,
  controllerHealth,
  serializeLatest,
  serializeBreaker,
  latestFromRow,
  loadOwnedBreaker,
};
