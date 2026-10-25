
const crypto = require("node:crypto");

const KEY_PREFIX = "bk_";

// Generate a secure, random API key for an ESP32 device.
function generateDeviceKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString("hex");
}

// Store only the SHA-256 hash in PostgreSQL.
function hashDeviceKey(key) {
  return crypto
    .createHash("sha256")
    .update(key, "utf8")
    .digest("hex");
}

// Check the expected API key format.
function isValidDeviceKey(key) {
  return (
    typeof key === "string" &&
    /^bk_[a-f0-9]{64}$/.test(key)
  );
}

// Securely compare a received API key against its stored hash.
function verifyDeviceKey(key, storedHash) {
  if (!isValidDeviceKey(key)) {
    return false;
  }

  if (
    typeof storedHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(storedHash)
  ) {
    return false;
  }

  const receivedHash = Buffer.from(
    hashDeviceKey(key),
    "hex"
  );

  const expectedHash = Buffer.from(
    storedHash,
    "hex"
  );

  return crypto.timingSafeEqual(
    receivedHash,
    expectedHash
  );
}

module.exports = {
  generateDeviceKey,
  hashDeviceKey,
  isValidDeviceKey,
  verifyDeviceKey,
};
