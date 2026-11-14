// Store one breaker's telemetry report (shared by legacy POST /readings and v1 telemetry).
//
// Rules:
// - Server time (NOW()) is the authoritative timestamp; a device-supplied recorded_at is kept
//   separately and only used to stop out-of-order packets from replacing the latest value.
// - Status-only / sensor-error reports update health + contactor state but never touch the
//   latest good measurement or history.
// - The channel-1 "legacy alias" breaker (breaker_id = device_id) also keeps the old `readings`
//   table and devices.status in sync so the existing dashboard keeps working.

const { hasMeasurement } = require("../validation/readings");

// Which metrics raise threshold alerts. Power alerts stay disabled (as before).
const ALERT_METRICS = [
  { key: "current", label: "Current", unit: "A", thresholdCol: "current_threshold" },
  { key: "voltage", label: "Voltage", unit: "V", thresholdCol: "voltage_threshold" },
  { key: "temperature", label: "Temperature", unit: "°C", thresholdCol: "temperature_threshold" },
];

function isAlias(breaker) {
  return breaker.breaker_id === breaker.controller_id && breaker.channel_number === 1;
}

async function recordReport(db, report) {
  const { breaker, values, contactorState = null, sequence = null, deviceRecordedAt = null, source } = report;
  const measured = hasMeasurement(values);
  const sensorStatus = report.sensorStatus ?? (measured ? "online" : null);

  await db.query(
    `UPDATE breakers
     SET last_seen_at = NOW(),
         contactor_state = COALESCE($2::text, contactor_state),
         contactor_state_at = CASE WHEN $2::text IS NULL THEN contactor_state_at ELSE NOW() END,
         sensor_status = COALESCE($3::text, sensor_status),
         sensor_status_at = CASE WHEN $3::text IS NULL THEN sensor_status_at ELSE NOW() END,
         updated_at = NOW()
     WHERE breaker_id = $1`,
    [breaker.breaker_id, contactorState, sensorStatus]
  );

  if (contactorState && isAlias(breaker)) {
    await db.query(
      `UPDATE devices
       SET status = $1,
           requested_status = CASE WHEN requested_status = $1 THEN NULL ELSE requested_status END,
           command_expires_at = CASE WHEN requested_status = $1 THEN NULL ELSE command_expires_at END
       WHERE device_id = $2`,
      [contactorState, breaker.controller_id]
    );
  }
  // Legacy firmware has no ack endpoint: reporting the requested state counts as "applied (reported)".
  if (contactorState && source === "legacy") {
    await db.query(
      `UPDATE commands
       SET status = 'APPLIED', acknowledged_at = NOW(), reported_state = $2, ack_source = 'legacy_status_report'
       WHERE breaker_id = $1 AND action = $2 AND status IN ('QUEUED', 'DELIVERED') AND expires_at > NOW()`,
      [breaker.breaker_id, contactorState]
    );
  }

  if (!measured) return { stored: false, sensor_status: sensorStatus, contactor_state: contactorState };

  const v = values;
  const log = await db.query(
    `INSERT INTO readings_log (device_id, breaker_id, channel_number, voltage, current, power, apparent_power,
                               temperature, power_factor, frequency, energy_kwh, sequence, device_recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, created_at`,
    [breaker.controller_id, breaker.breaker_id, breaker.channel_number, v.voltage, v.current, v.power,
      v.apparent_power, v.temperature, v.power_factor, v.frequency, v.energy_kwh, sequence, deviceRecordedAt]
  );
  const measuredAt = log.rows[0].created_at;

  const latest = await db.query(
    `INSERT INTO breaker_latest (breaker_id, voltage, current, power, apparent_power, power_factor, frequency,
                                 energy_kwh, temperature, measured_at, device_recorded_at, sequence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (breaker_id) DO UPDATE SET
       voltage = EXCLUDED.voltage, current = EXCLUDED.current, power = EXCLUDED.power,
       apparent_power = EXCLUDED.apparent_power, power_factor = EXCLUDED.power_factor,
       frequency = EXCLUDED.frequency, energy_kwh = EXCLUDED.energy_kwh, temperature = EXCLUDED.temperature,
       measured_at = EXCLUDED.measured_at, device_recorded_at = EXCLUDED.device_recorded_at,
       sequence = EXCLUDED.sequence
     WHERE breaker_latest.device_recorded_at IS NULL
        OR EXCLUDED.device_recorded_at IS NULL
        OR EXCLUDED.device_recorded_at >= breaker_latest.device_recorded_at
     RETURNING breaker_id`,
    [breaker.breaker_id, v.voltage, v.current, v.power, v.apparent_power, v.power_factor, v.frequency,
      v.energy_kwh, v.temperature, measuredAt, deviceRecordedAt, sequence]
  );
  const latestUpdated = latest.rows.length > 0;

  let legacyRow = null;
  if (isAlias(breaker) && latestUpdated) {
    const r = await db.query(
      `INSERT INTO readings (device_id, voltage, current, power, temperature, apparent_power, power_factor, frequency, energy_kwh, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET voltage = $2, current = $3, power = $4, temperature = $5, apparent_power = $6,
                     power_factor = $7, frequency = $8, energy_kwh = $9, updated_at = NOW()
       RETURNING *`,
      [breaker.controller_id, v.voltage, v.current, v.power, v.temperature, v.apparent_power, v.power_factor, v.frequency, v.energy_kwh]
    );
    legacyRow = r.rows[0];
  }

  await evaluateAlerts(db, breaker, v);

  return {
    stored: true,
    latest_updated: latestUpdated,
    reading_id: String(log.rows[0].id),
    measured_at: new Date(measuredAt).toISOString(),
    legacyRow,
  };
}

// One open alert per breaker+metric; auto-resolves when the value is back within limits.
async function evaluateAlerts(db, breaker, values) {
  const label = breaker.name || breaker.breaker_id;
  for (const m of ALERT_METRICS) {
    const value = values[m.key];
    const limit = breaker[m.thresholdCol];
    if (value === null || limit === null || limit === undefined) continue;

    if (value > limit) {
      const open = await db.query(
        `SELECT id FROM alerts WHERE breaker_id = $1 AND metric = $2 AND resolved = FALSE LIMIT 1`,
        [breaker.breaker_id, m.key]
      );
      if (open.rows.length === 0) {
        await db.query(
          `INSERT INTO alerts (device_id, breaker_id, metric, title, message, severity) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            breaker.controller_id,
            breaker.breaker_id,
            m.key,
            `${m.label} above threshold`,
            `${label} reported ${value}${m.unit}, over its ${limit}${m.unit} limit.`,
            value >= limit * 1.2 ? "High" : "Medium",
          ]
        );
      }
    } else {
      await db.query(
        `UPDATE alerts SET resolved = TRUE WHERE breaker_id = $1 AND metric = $2 AND resolved = FALSE`,
        [breaker.breaker_id, m.key]
      );
    }
  }
}

module.exports = { recordReport, isAlias };
