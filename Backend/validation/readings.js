// Validation for POST /readings payloads.
//
// Every measurement field is optional, but a field that IS sent must be a finite number
// (or a numeric string) inside its allowed range. A device may also report its ON/OFF state.
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
    voltage:     { unit: "V",  min: 0,                                     max: limit("READING_MAX_VOLTAGE", 300) },
    current:     { unit: "A",  min: 0,                                     max: limit("READING_MAX_CURRENT", 100) },
    power:       { unit: "W",  min: 0,                                     max: limit("READING_MAX_POWER", 30000) },
    temperature: { unit: "°C", min: limit("READING_MIN_TEMPERATURE", -40), max: limit("READING_MAX_TEMPERATURE", 150) },
  };
}

// Returns { values, status } on success or { error, field } on failure.
// Missing measurements are null; status is null until the device reports ON or OFF.
function parseReading(body) {
  const values = {};
  const status = body?.status;

  if (status !== undefined && status !== null && !["ON", "OFF"].includes(status)) {
    return { field: "status", error: "status must be ON or OFF" };
  }

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
      return { field: key, error: `${key} must be a finite number` };
    }
    if (n < range.min || n > range.max) {
      return { field: key, error: `${key} must be between ${range.min} and ${range.max} ${range.unit}` };
    }

    values[key] = n;
  }

  // A payload with no measurements at all (e.g. the sensor failed to read) must not
  // overwrite the last good reading with nulls.
  if (Object.values(values).every((v) => v === null) && status == null) {
    return { error: "At least one measurement (voltage, current, power, temperature) is required" };
  }

  return { values, status: status ?? null };
}

module.exports = { parseReading, measurementLimits };