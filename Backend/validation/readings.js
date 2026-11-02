// Validation for POST /readings payloads.
//
// Every measurement field is optional, but a field that IS sent must be a finite number
// (or a numeric string) inside its allowed range — otherwise the whole upload is rejected
// instead of quietly storing null. Limits can be tuned per deployment with env variables.

const SENSOR_STATUSES = ["online", "offline", "error"];
const CONTACTOR_STATES = ["ON", "OFF", "TRIPPED", "UNKNOWN"];
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function limit(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// PZEM-004T V3.0 (100 A version) measures 80–260 V, 0–100 A, up to ~23 kW, 45–65 Hz and
// up to 9999.99 kWh, so these defaults leave headroom without accepting obviously broken values.
function measurementLimits() {
  return {
    voltage:        { unit: "V",   min: 0,  max: limit("READING_MAX_VOLTAGE", 300) },
    current:        { unit: "A",   min: 0,  max: limit("READING_MAX_CURRENT", 100) },
    power:          { unit: "W",   min: 0,  max: limit("READING_MAX_POWER", 30000) },
    apparent_power: { unit: "VA",  min: 0,  max: limit("READING_MAX_APPARENT_POWER", 30000) },
    energy_kwh:     { unit: "kWh", min: 0,  max: limit("READING_MAX_ENERGY_KWH", 100000) },
    frequency:      { unit: "Hz",  min: limit("READING_MIN_FREQUENCY", 40), max: limit("READING_MAX_FREQUENCY", 70) },
    power_factor:   { unit: "",    min: 0,  max: 1 },
    temperature:    { unit: "°C",  min: limit("READING_MIN_TEMPERATURE", -40), max: limit("READING_MAX_TEMPERATURE", 150) },
  };
}

function optionalId(body, key) {
  const raw = body?.[key];
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== "string" || !ID_PATTERN.test(raw.trim())) {
    return { error: `${key} must be 1-64 characters of letters, digits, '.', '_' or '-'` };
  }
  return { value: raw.trim() };
}

// Returns { values, sensorStatus, contactorState, sensorError, breakerId, controllerId } on
// success, or { error, field, code } on failure. values has every measurement key, set to
// null when the field wasn't sent.
function parseReading(body) {
  const values = {};

  for (const [key, range] of Object.entries(measurementLimits())) {
    const raw = body?.[key];

    if (raw === undefined || raw === null) {
      values[key] = null;
      continue;
    }

    let n = NaN;
    if (typeof raw === "number") n = raw;
    else if (typeof raw === "string" && raw.trim() !== "") n = Number(raw);

    if (!Number.isFinite(n)) {
      return { code: "INVALID_MEASUREMENT", field: key, error: `${key} must be a finite number` };
    }
    if (n < range.min || n > range.max) {
      return {
        code: "MEASUREMENT_OUT_OF_RANGE",
        field: key,
        error: `${key} must be between ${range.min} and ${range.max}${range.unit ? " " + range.unit : ""}`,
      };
    }

    values[key] = n;
  }

  const sensorStatus = body?.sensor_status ?? "online";
  if (!SENSOR_STATUSES.includes(sensorStatus)) {
    return { code: "INVALID_FIELD", field: "sensor_status", error: "sensor_status must be online, offline or error" };
  }

  let contactorState = body?.contactor_state ?? null;
  if (typeof contactorState === "string") contactorState = contactorState.toUpperCase();
  if (contactorState !== null && !CONTACTOR_STATES.includes(contactorState)) {
    return { code: "INVALID_FIELD", field: "contactor_state", error: "contactor_state must be ON, OFF, TRIPPED or UNKNOWN" };
  }

  let sensorError = body?.sensor_error ?? body?.error ?? null;
  if (sensorError !== null) sensorError = String(sensorError).slice(0, 200);

  const breaker = optionalId(body, "breaker_id");
  if (breaker.error) return { code: "INVALID_FIELD", field: "breaker_id", error: breaker.error };
  const controller = optionalId(body, "controller_id");
  if (controller.error) return { code: "INVALID_FIELD", field: "controller_id", error: controller.error };
  const device = optionalId(body, "device_id");
  if (device.error) return { code: "INVALID_FIELD", field: "device_id", error: device.error };
  if (controller.value && device.value && controller.value !== device.value) {
    return { code: "INVALID_FIELD", field: "controller_id", error: "controller_id and device_id disagree" };
  }

  const hasMeasurement = Object.values(values).some((v) => v !== null);

  // A healthy report must carry at least one measurement. A payload with none (e.g. the
  // sensor failed to read but firmware still sent "online") must not overwrite the last
  // good reading with nulls. Failure reports say so with sensor_status "error"/"offline".
  if (sensorStatus === "online" && !hasMeasurement) {
    return {
      code: "NO_MEASUREMENTS",
      error: "At least one measurement is required, or send sensor_status \"error\" to report a sensor failure",
    };
  }

  return {
    values,
    hasMeasurement,
    sensorStatus,
    contactorState,
    sensorError: sensorStatus === "online" ? null : sensorError,
    breakerId: breaker.value,
    controllerId: controller.value ?? device.value,
  };
}

module.exports = { parseReading, measurementLimits, SENSOR_STATUSES, CONTACTOR_STATES, ID_PATTERN };