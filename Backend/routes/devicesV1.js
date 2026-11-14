// /api/device/v1 — controller (ESP32) API, authenticated with X-API-Key.
//   POST /telemetry               multi-channel readings / heartbeat
//   POST /commands/poll           pending ON/OFF commands for this controller
//   POST /commands/:command_id/ack APPLIED | FAILED | REJECTED
// The controller is identified by body.controller_id + its key. Channel -> breaker mapping is
// done on the server; a controller can never address another controller's breakers.

const express = require("express");
const { pool } = require("../db");
const { config } = require("../config");
const { requireDeviceAuth } = require("../middleware/deviceAuth");
const { rateLimit } = require("../middleware/rateLimit");
const { apiError } = require("../middleware/errors");
const { parseMeasurements, hasMeasurement, V1_FIELDS } = require("../validation/readings");
const { recordReport } = require("../services/ingest");
const { pollCommands, ackCommand, serializeCommand, CommandError } = require("../services/commands");

const MAX_CHANNELS = 8;

function parseTelemetry(body) {
  const { sequence, recorded_at, firmware_version, channels } = body || {};
  if (sequence !== undefined && sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0)) {
    return { error: "sequence must be a non-negative integer", field: "sequence" };
  }
  if (firmware_version !== undefined && firmware_version !== null && (typeof firmware_version !== "string" || firmware_version.length > 32)) {
    return { error: "firmware_version must be a string of at most 32 characters", field: "firmware_version" };
  }
  let recordedAt = null;
  const warnings = [];
  if (recorded_at !== undefined && recorded_at !== null) {
    const d = typeof recorded_at === "string" ? new Date(recorded_at) : new Date(NaN);
    if (Number.isNaN(d.getTime())) return { error: "recorded_at must be an ISO 8601 timestamp", field: "recorded_at" };
    if (Math.abs(d.getTime() - Date.now()) > config().maxClockSkewSeconds * 1000) warnings.push("recorded_at_ignored_clock_skew");
    else recordedAt = d;
  }
  if (!Array.isArray(channels) || channels.length === 0 || channels.length > MAX_CHANNELS) {
    return { error: `channels must be a list of 1-${MAX_CHANNELS} channel reports`, field: "channels" };
  }

  const seen = new Set();
  const parsed = [];
  for (const [i, ch] of channels.entries()) {
    const idx = ch?.channel_index;
    if (!Number.isInteger(idx) || idx < 1 || idx > MAX_CHANNELS) {
      return { error: `channels[${i}].channel_index must be an integer 1-${MAX_CHANNELS}`, field: `channels[${i}].channel_index` };
    }
    if (seen.has(idx)) return { error: `channel_index ${idx} appears twice`, field: `channels[${i}].channel_index` };
    seen.add(idx);

    const m = parseMeasurements(ch, V1_FIELDS);
    if (m.error) return { error: `channels[${i}].${m.error}`, field: `channels[${i}].${m.field}` };

    if (ch.sensor_ok !== undefined && ch.sensor_ok !== null && typeof ch.sensor_ok !== "boolean") {
      return { error: `channels[${i}].sensor_ok must be true or false`, field: `channels[${i}].sensor_ok` };
    }
    if (ch.sensor_ok === false && hasMeasurement(m.values)) {
      return { error: `channels[${i}]: a sensor_ok=false report must not include measurements`, field: `channels[${i}].sensor_ok` };
    }
    const state = ch.reported_output_state ?? null;
    if (state !== null && !["ON", "OFF", "UNKNOWN"].includes(state)) {
      return { error: `channels[${i}].reported_output_state must be ON, OFF or UNKNOWN`, field: `channels[${i}].reported_output_state` };
    }
    parsed.push({
      channel_index: idx,
      values: m.values,
      sensorStatus: ch.sensor_ok === false ? "error" : hasMeasurement(m.values) ? "online" : null,
      contactorState: state === "UNKNOWN" ? null : state,
    });
  }
  return { sequence: sequence ?? null, recordedAt, firmwareVersion: firmware_version ?? null, channels: parsed, warnings };
}

function createDeviceV1Router() {
  const router = express.Router();
  const limiter = rateLimit({
    name: "device",
    windowMs: 60_000,
    max: 120,
    key: (req) => `${req.ip}:${req.body?.controller_id ?? req.body?.device_id ?? "?"}`,
  });
  router.use(limiter, requireDeviceAuth);

  router.post("/telemetry", async (req, res) => {
    const t = parseTelemetry(req.body);
    if (t.error) return apiError(res, 400, "VALIDATION_ERROR", t.error, { field: t.field });

    try {
      // Exact retry of the last packet (same sequence) is acknowledged but not stored twice.
      if (t.sequence !== null && req.device.last_sequence !== null && Number(req.device.last_sequence) === t.sequence) {
        return res.json({ controller_id: req.deviceId, duplicate: true, sequence: t.sequence, server_time: new Date().toISOString() });
      }
      await pool.query(
        `UPDATE devices SET last_sequence = COALESCE($2, last_sequence), firmware_version = COALESCE($3, firmware_version) WHERE device_id = $1`,
        [req.deviceId, t.sequence, t.firmwareVersion]
      );

      const { rows: breakers } = await pool.query(`SELECT * FROM breakers WHERE controller_id = $1`, [req.deviceId]);
      const byChannel = new Map(breakers.map((b) => [b.channel_number, b]));

      const results = [];
      for (const ch of t.channels) {
        const breaker = byChannel.get(ch.channel_index);
        if (!breaker) {
          results.push({ channel_index: ch.channel_index, breaker_id: null, result: "CHANNEL_NOT_ASSIGNED" });
          continue;
        }
        const out = await recordReport(pool, {
          breaker,
          values: ch.values,
          contactorState: ch.contactorState,
          sensorStatus: ch.sensorStatus,
          sequence: t.sequence,
          deviceRecordedAt: t.recordedAt,
          source: "v1",
        });
        results.push({
          channel_index: ch.channel_index,
          breaker_id: breaker.breaker_id,
          result: out.stored ? (out.latest_updated ? "STORED" : "STORED_OUT_OF_ORDER") : "STATUS_ONLY",
        });
      }
      return res.json({
        controller_id: req.deviceId,
        sequence: t.sequence,
        duplicate: false,
        channels: results,
        warnings: t.warnings,
        server_time: new Date().toISOString(),
      });
    } catch (err) {
      console.error("v1 telemetry error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not store telemetry");
    }
  });

  router.post("/commands/poll", async (req, res) => {
    try {
      const commands = await pollCommands(pool, req.deviceId);
      return res.json({
        controller_id: req.deviceId,
        commands: commands.map((c) => ({
          command_id: c.command_id,
          breaker_id: c.breaker_id,
          channel_index: c.channel_number,
          action: c.action,
          created_at: new Date(c.created_at).toISOString(),
          expires_at: new Date(c.expires_at).toISOString(),
          delivery_count: c.delivery_count,
        })),
        server_time: new Date().toISOString(),
      });
    } catch (err) {
      console.error("v1 command poll error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not fetch commands");
    }
  });

  router.post("/commands/:command_id/ack", async (req, res) => {
    const b = req.body || {};
    try {
      const { command, duplicate } = await ackCommand(pool, req.deviceId, req.params.command_id, {
        result: b.result,
        reportedState: b.reported_output_state ?? null,
        reason: b.reason ?? null,
      });
      return res.json({ ...serializeCommand(command), duplicate });
    } catch (err) {
      if (err instanceof CommandError) return apiError(res, err.status, err.code, err.message, err.details);
      console.error("v1 command ack error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Could not record acknowledgment");
    }
  });

  return router;
}

module.exports = { createDeviceV1Router, parseTelemetry };
