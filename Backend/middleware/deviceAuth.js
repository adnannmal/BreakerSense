
const { pool } = require("../db");
const { verifyDeviceKey } = require("../security/deviceKeys");

async function requireDeviceAuth(req, res, next) {
  const deviceId = req.body?.device_id;
  const apiKey = req.get("X-API-Key");

  if (typeof deviceId !== "string" || !deviceId.trim()) {
    return res.status(400).json({
      error: "device_id is required",
    });
  }

  if (!apiKey) {
    return res.status(401).json({
      error: "Device API key required",
    });
  }

  try {
    const result = await pool.query(
      `SELECT device_id, api_key_hash
       FROM devices
       WHERE device_id = $1`,
      [deviceId.trim()]
    );

    const device = result.rows[0];

    if (
      !device ||
      !verifyDeviceKey(apiKey, device.api_key_hash)
    ) {
      return res.status(401).json({
        error: "Invalid device credentials",
      });
    }

    req.deviceId = device.device_id;
    next();
  } catch (error) {
    console.error("Device authentication database error");

    return res.status(500).json({
      error: "Device authentication unavailable",
    });
  }
}

module.exports = { requireDeviceAuth };
