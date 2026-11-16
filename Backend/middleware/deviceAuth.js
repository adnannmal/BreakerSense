const { pool } = require("../db");
const { verifyDeviceKey } = require("../security/deviceKeys");

// Authenticates an ESP32 controller: body.device_id (legacy) or body.controller_id, plus the
// X-API-Key header. The key is checked against the SHA-256 hash stored for THAT controller, so a
// key can never be used to post as another controller. On success sets req.deviceId (= controller id)
// and req.device, and records last_seen_at for online/offline health.
// Failures never log or echo the key.
async function requireDeviceAuth(req, res, next) {
  const body = req.body || {};
  const legacyId = body.device_id;
  const controllerId = body.controller_id;
  const apiKey = req.get("X-API-Key");

  if (legacyId !== undefined && controllerId !== undefined && legacyId !== controllerId) {
    return res.status(400).json({ error: "device_id and controller_id must match" });
  }
  const id = controllerId ?? legacyId;
  if (typeof id !== "string" || !id.trim()) {
    return res.status(400).json({ error: "device_id is required" });
  }
  if (!apiKey) {
    return res.status(401).json({ error: "Device API key required" });
  }

  try {
    const result = await pool.query(
      `SELECT device_id, user_id, api_key_hash, status, last_sequence FROM devices WHERE device_id = $1`,
      [id.trim()]
    );
    const device = result.rows[0];
    if (!device || !verifyDeviceKey(apiKey, device.api_key_hash)) {
      return res.status(401).json({ error: "Invalid device credentials" });
    }
    await pool.query(`UPDATE devices SET last_seen_at = NOW() WHERE device_id = $1`, [device.device_id]);
    req.deviceId = device.device_id;
    req.device = device;
    next();
  } catch (error) {
    console.error("Device authentication database error");
    return res.status(500).json({ error: "Device authentication unavailable" });
  }
}

module.exports = { requireDeviceAuth };
