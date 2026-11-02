const express = require("express");

const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendError, asyncHandler } = require("../lib/errors");
const { ID_PATTERN } = require("../validation/readings");

const {
  generateDeviceKey,
  hashDeviceKey,
} = require("../security/deviceKeys");

// A "device" here is a CONTROLLER (one ESP32). device_id === controller_id.
// Registering one also creates its channel-1 breaker ("breaker-001"), so single-breaker
// setups keep working exactly as before. More breakers: POST /api/controllers/:id/breakers.
const router = express.Router();

// All device-management routes require user authentication.
router.use(requireAuth);

// Default breaker thresholds.
const DEFAULT_VOLTAGE_THRESHOLD = 264;
const DEFAULT_TEMPERATURE_THRESHOLD = 60;
const DEFAULT_BREAKER_ID = "breaker-001";

// Columns returned to the frontend.
// Never include api_key_hash in ordinary device responses.
const DEVICE_COLUMNS = `
  device_id,
  nickname,
  location,
  capacity_amps,
  status,
  voltage_threshold,
  current_threshold,
  power_threshold,
  temperature_threshold,
  created_at,
  last_seen
`;

// ---------------------------------------------------------
// GET /api/devices
// Retrieve the logged-in user's registered controllers (legacy shape).
// ---------------------------------------------------------

router.get(
  "/",
  asyncHandler("Fetch devices", async (req, res) => {
    const result = await pool.query(
      `SELECT ${DEVICE_COLUMNS}
       FROM devices
       WHERE user_id = $1
       ORDER BY created_at`,
      [req.userId]
    );

    return res.json(result.rows);
  })
);

// ---------------------------------------------------------
// POST /api/devices
// Register a new controller + its channel-1 breaker and generate its first API key.
// ---------------------------------------------------------

router.post("/", async (req, res) => {
  const {
    device_id,
    nickname,
    location,
    capacity_amps,
    status,
    voltage_threshold,
    current_threshold,
    power_threshold,
    temperature_threshold,
  } = req.body || {};

  // Validate device ID. It ends up in URLs and firmware config, so keep it simple.
  if (typeof device_id !== "string" || !device_id.trim()) {
    return sendError(res, 400, "VALIDATION_FAILED", "device_id is required", { field: "device_id" });
  }

  const deviceId = device_id.trim();

  if (!ID_PATTERN.test(deviceId)) {
    return sendError(res, 400, "VALIDATION_FAILED", "device_id must be 1-64 characters of letters, digits, '.', '_' or '-'", {
      field: "device_id",
    });
  }

  // Validate initial status (legacy display label; not a command and not hardware state).
  const startStatus = status || "OFF";

  if (!["ON", "OFF", "TRIPPED"].includes(startStatus)) {
    return sendError(res, 400, "VALIDATION_FAILED", "Status must be ON, OFF, or TRIPPED", { field: "status" });
  }

  // Validate breaker capacity.
  const capacity =
    capacity_amps === undefined ||
    capacity_amps === null ||
    capacity_amps === ""
      ? null
      : Number(capacity_amps);

  if (
    capacity !== null &&
    (!Number.isFinite(capacity) || capacity <= 0)
  ) {
    return sendError(res, 400, "VALIDATION_FAILED", "capacity_amps must be a positive number", { field: "capacity_amps" });
  }

  // Validate optional threshold values.
  const thresholds = [
    voltage_threshold,
    current_threshold,
    power_threshold,
    temperature_threshold,
  ];

  for (const threshold of thresholds) {
    if (
      threshold !== undefined &&
      threshold !== null &&
      (
        threshold === "" ||
        !Number.isFinite(Number(threshold)) ||
        Number(threshold) < 0
      )
    ) {
      return sendError(res, 400, "VALIDATION_FAILED", "Thresholds must be non-negative numbers");
    }
  }

  const values = {
    voltage: voltage_threshold ?? DEFAULT_VOLTAGE_THRESHOLD,
    current: current_threshold ?? capacity,
    power: power_threshold ?? null,
    temperature: temperature_threshold ?? DEFAULT_TEMPERATURE_THRESHOLD,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check whether the device ID is already registered.
    const existing = await client.query(
      `SELECT device_id
       FROM devices
       WHERE device_id = $1`,
      [deviceId]
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return sendError(res, 409, "DEVICE_EXISTS", "That device_id is already registered");
    }

    // Generate a unique API key for this device.
    // This happens only when a device is registered.
    const apiKey = generateDeviceKey();
    const apiKeyHash = hashDeviceKey(apiKey);

    const result = await client.query(
      `INSERT INTO devices (
        device_id,
        user_id,
        nickname,
        location,
        capacity_amps,
        status,
        voltage_threshold,
        current_threshold,
        power_threshold,
        temperature_threshold,
        api_key_hash
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11
      )
      RETURNING ${DEVICE_COLUMNS}`,
      [
        deviceId,
        req.userId,
        nickname || null,
        location || null,
        capacity,
        startStatus,
        values.voltage,
        values.current,
        values.power,
        values.temperature,
        apiKeyHash,
      ]
    );

    await client.query(
      `INSERT INTO breakers (controller_id, breaker_id, channel_number, name, capacity_amps,
                             voltage_threshold, current_threshold, power_threshold, temperature_threshold)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8)`,
      [deviceId, DEFAULT_BREAKER_ID, nickname || null, capacity, values.voltage, values.current, values.power, values.temperature]
    );

    await client.query("COMMIT");

    // Return the plaintext API key exactly once.
    // PostgreSQL stores only its hash.
    res.set("Cache-Control", "no-store");

    return res.status(201).json({
      ...result.rows[0],
      controller_id: deviceId,
      breakers: [{ breaker_id: DEFAULT_BREAKER_ID, channel_number: 1 }],
      api_key: apiKey,
    });

  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    if (error.code === "23505") {
      return sendError(res, 409, "DEVICE_EXISTS", "That device_id is already registered");
    }

    console.error("Register device error:", error.code || "", error.message);
    return sendError(res, 500, "INTERNAL_ERROR", "Could not register device");
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------
// POST /api/devices/:device_id/rotate-key
// Generate a replacement API key for an existing controller.
// ---------------------------------------------------------

router.post(
  "/:device_id/rotate-key",
  asyncHandler("Device key rotation", async (req, res) => {
    const deviceId = req.params.device_id;

    // Generate a new secret key and its hash.
    const apiKey = generateDeviceKey();
    const apiKeyHash = hashDeviceKey(apiKey);

    // Update the key only if this user owns the device.
    const result = await pool.query(
      `UPDATE devices
       SET api_key_hash = $1
       WHERE device_id = $2
         AND user_id = $3
       RETURNING device_id`,
      [
        apiKeyHash,
        deviceId,
        req.userId,
      ]
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, "DEVICE_NOT_FOUND", "Device not found");
    }

    // Prevent caching of the new secret.
    res.set("Cache-Control", "no-store");

    // The original key is invalid immediately.
    return res.status(200).json({
      device_id: result.rows[0].device_id,
      api_key: apiKey,
      message:
        "API key rotated successfully. Save this key now.",
    });
  })
);

module.exports = router;