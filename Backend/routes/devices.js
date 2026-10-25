
const express = require("express");

const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const {
  generateDeviceKey,
  hashDeviceKey,
} = require("../security/deviceKeys");

const router = express.Router();

// All device-management routes require user authentication.
router.use(requireAuth);

// Default breaker thresholds.
const DEFAULT_VOLTAGE_THRESHOLD = 264;
const DEFAULT_TEMPERATURE_THRESHOLD = 60;

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
  created_at
`;

// ---------------------------------------------------------
// GET /api/devices
// Retrieve the logged-in user's registered breakers.
// ---------------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${DEVICE_COLUMNS}
       FROM devices
       WHERE user_id = $1
       ORDER BY created_at`,
      [req.userId]
    );

    return res.json(result.rows);

  } catch (error) {
    console.error("Fetch devices error:", error);

    return res.status(500).json({
      error: "Could not load devices",
    });
  }
});

// ---------------------------------------------------------
// POST /api/devices
// Register a new breaker and generate its first API key.
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

  // Validate device ID.
  if (
    typeof device_id !== "string" ||
    !device_id.trim()
  ) {
    return res.status(400).json({
      error: "device_id is required",
    });
  }

  const deviceId = device_id.trim();

  // Validate initial status.
  const startStatus = status || "OFF";

  if (!["ON", "OFF", "TRIPPED"].includes(startStatus)) {
    return res.status(400).json({
      error: "Status must be ON, OFF, or TRIPPED",
    });
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
    return res.status(400).json({
      error: "capacity_amps must be a positive number",
    });
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
      return res.status(400).json({
        error: "Thresholds must be non-negative numbers",
      });
    }
  }

  try {
    // Check whether the device ID is already registered.
    const existing = await pool.query(
      `SELECT device_id
       FROM devices
       WHERE device_id = $1`,
      [deviceId]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "That device_id is already registered",
      });
    }

    // Generate a unique API key for this device.
    // This happens only when a device is registered.
    const apiKey = generateDeviceKey();
    const apiKeyHash = hashDeviceKey(apiKey);

    // Insert the device into PostgreSQL.
    const result = await pool.query(
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
        voltage_threshold ?? DEFAULT_VOLTAGE_THRESHOLD,
        current_threshold ?? capacity,
        power_threshold ?? null,
        temperature_threshold ?? DEFAULT_TEMPERATURE_THRESHOLD,
        apiKeyHash,
      ]
    );

    // Return the plaintext API key exactly once.
    // PostgreSQL stores only its hash.
    res.set("Cache-Control", "no-store");

    return res.status(201).json({
      ...result.rows[0],
      api_key: apiKey,
    });

  } catch (error) {
    console.error("Register device error:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        error: "That device_id is already registered",
      });
    }

    return res.status(500).json({
      error: "Could not register device",
    });
  }
});

// ---------------------------------------------------------
// POST /api/devices/:device_id/rotate-key
// Generate a replacement API key for an existing breaker.
// ---------------------------------------------------------

router.post("/:device_id/rotate-key", async (req, res) => {
  const deviceId = req.params.device_id;

  try {
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
      return res.status(404).json({
        error: "Device not found",
      });
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

  } catch (error) {
    console.error("Device key rotation error:", error);

    return res.status(500).json({
      error: "Could not rotate device key",
    });
  }
});

module.exports = router;
