// Validation for telemetry from the ESP32 (legacy POST /readings and v1 telemetry channels).
//
// Every measurement is optional, but a field that IS sent must be a finite number (or numeric
// string) inside its allowed range. Missing = null = "not measured", never 0.
// Limits can be tuned per deployment with env variables.

function limit(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// PZEM-004T measures 80–260 V and up to 100 A (≈23 kW), so these defaults leave headroom
// without accepting obviously broken values.
function measurementLimits() {
  return {
    voltage:        { unit: "V",   min: 0,                                     max: limit("READING_MAX_VOLTAGE", 300) },
    current:        { unit: "A",   min: 0,                                     max: limit("READING_MAX_CURRENT", 100) },
    power:          { unit: "W",   min: 0,                                     max: limit("READING_MAX_POWER", 30000) },
    apparent_power: { unit: "VA",  min: 0,                                     max: limit("READING_MAX_APPARENT_POWER", 30000) },
    temperature:    { unit: "°C",  min: limit("READING_MIN_TEMPERATURE", -40), max: limit("READING_MAX_TEMPERATURE", 150) },
    power_factor:   { unit: "",    min: 0,                                     max: 1 },
    frequency:      { unit: "Hz",  min: limit("READING_MIN_FREQUENCY", 40),    max: limit("READING_MAX_FREQUENCY", 70) },
    energy_kwh:     { unit: "kWh", min: 0,                                     max: limit("READING_MAX_ENERGY_KWH", 100000) },
  };
}

const MEASUREMENTS = Object.keys(measurementLimits());
const CONTACTOR_STATES = ["ON", "OFF"];
const SENSOR_STATUSES = ["online", "offline", "error"];

// Legacy/October field names -> storage names.
const LEGACY_FIELDS = Object.fromEntries(MEASUREMENTS.map((k) => [k, k]));
// v1 telemetry channel field names -> storage names.
const V1_FIELDS = {
  voltage_v: "voltage",
  current_a: "current",
  power_w: "power",
  apparent_power_va: "apparent_power",
  temperature_c: "temperature",
  power_factor: "power_factor",
  frequency_hz: "frequency",
  energy_kwh: "energy_kwh",
};

// Parse measurement fields. Returns { values } or { error, field }.
function parseMeasurements(body, fieldMap) {
  const limits = measurementLimits();
  const values = Object.fromEntries(MEASUREMENTS.map((k) => [k, null]));
  for (const [inName, key] of Object.entries(fieldMap)) {
    const raw = body?.[inName];
    if (raw === undefined || raw === null) continue;

    let n = NaN;
    if (typeof raw === "number") n = raw;
    else if (typeof raw === "string" && raw.trim() !== "") n = Number(raw);

    const range = limits[key];
    if (!Number.isFinite(n)) {
      return { field: inName, error: `${inName} must be a finite number` };
    }
    if (n < range.min || n > range.max) {
      return { field: inName, error: `${inName} must be between ${range.min} and ${range.max}${range.unit ? " " + range.unit : ""}` };
    }
    values[key] = n;
  }
  return { values };
}

function hasMeasurement(values) {
  return Object.values(values).some((v) => v !== null);
}

// Legacy POST /readings body. Returns
//   { values, status, sensorStatus, breakerId } on success, or { error, field } on failure.
// status        reported contactor (GPIO) state ON/OFF, from "status" or "contactor_state"
// sensorStatus  "online" | "offline" | "error" | null
function parseReading(body) {
  const status = body?.status ?? null;
  const contactorState = body?.contactor_state ?? null;
  if (status !== null && !CONTACTOR_STATES.includes(status)) {
    return { field: "status", error: "status must be ON or OFF" };
  }
  if (contactorState !== null && !CONTACTOR_STATES.includes(contactorState)) {
    return { field: "contactor_state", error: "contactor_state must be ON or OFF" };
  }
  if (status !== null && contactorState !== null && status !== contactorState) {
    return { field: "contactor_state", error: "status and contactor_state disagree" };
  }

  const sensorStatus = body?.sensor_status ?? null;
  if (sensorStatus !== null && !SENSOR_STATUSES.includes(sensorStatus)) {
    return { field: "sensor_status", error: "sensor_status must be online, offline or error" };
  }

  const breakerId = body?.breaker_id ?? null;
  if (breakerId !== null && (typeof breakerId !== "string" || !breakerId.trim())) {
    return { field: "breaker_id", error: "breaker_id must be a non-empty string" };
  }

  const parsed = parseMeasurements(body, LEGACY_FIELDS);
  if (parsed.error) return parsed;
  const { values } = parsed;

  // A failed meter read is reported as sensor_status error/offline WITHOUT numbers.
  if ((sensorStatus === "error" || sensorStatus === "offline") && hasMeasurement(values)) {
    return { field: "sensor_status", error: `a ${sensorStatus} report must not include measurements` };
  }

  // A payload with nothing at all must not overwrite the last good reading.
  if (!hasMeasurement(values) && status === null && contactorState === null && sensorStatus === null) {
    return { error: `At least one measurement (${MEASUREMENTS.join(", ")}) or a status is required` };
  }

  return { values, status: status ?? contactorState, sensorStatus, breakerId: breakerId ? breakerId.trim() : null };
}

module.exports = {
  parseReading,
  parseMeasurements,
  hasMeasurement,
  measurementLimits,
  MEASUREMENTS,
  V1_FIELDS,
  CONTACTOR_STATES,
  SENSOR_STATUSES,
};
