const { pool } = require("../db");
const { hashDeviceKey, isValidDeviceKey } = require("../security/deviceKeys");
const { sendError } = require("../lib/errors");

// Authenticates an ESP32 controller by its X-API-Key.
//
// The key alone identifies the controller (every key hash is unique). If the request ALSO
// names a controller — body controller_id / device_id, or the X-Controller-Id header — it
// must be the same controller, so one ESP32 can never post as, or for, another one.
// On success sets req.controllerId (and req.deviceId, its legacy name).
async function requireDeviceAuth(req, res, next) {
  const apiKey = req.get("X-API-Key");

  if (!apiKey) {
    return sendError(res, 401, "DEVICE_KEY_REQUIRED", "Device API key required");
  }
  // Same answer for malformed and unknown keys, and never echo the key back.
  if (!isValidDeviceKey(apiKey)) {
    return sendError(res, 401, "INVALID_DEVICE_CREDENTIALS", "Invalid device credentials");
  }

  const claimed = [req.body?.controller_id, req.body?.device_id, req.get("X-Controller-Id")]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => (typeof v === "string" ? v.trim() : v));

  try {
    // Lookup by SHA-256 of a 256-bit random key: an index probe, not a secret comparison.
    const result = await pool.query(`SELECT device_id FROM devices WHERE api_key_hash = $1`, [hashDeviceKey(apiKey)]);
    const device = result.rows[0];

    if (!device) {
      return sendError(res, 401, "INVALID_DEVICE_CREDENTIALS", "Invalid device credentials");
    }
    if (claimed.some((id) => id !== device.device_id)) {
      return sendError(res, 403, "CONTROLLER_MISMATCH", "This API key does not belong to that controller");
    }

    req.controllerId = device.device_id;
    req.deviceId = device.device_id;
    next();
  } catch (error) {
    console.error("Device authentication database error:", error.code || "", error.message);
    return sendError(res, 503, "DEVICE_AUTH_UNAVAILABLE", "Device authentication unavailable");
  }
}

module.exports = { requireDeviceAuth };