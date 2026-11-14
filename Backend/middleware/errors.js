// Error helpers.
// New (Sprint 2/3) endpoints:  { "error": { "code": "DEVICE_OFFLINE", "message": "...", "details": {...} } }
// Legacy endpoints keep their original { "error": "..." } string so the current frontend/firmware
// keep working.

function apiError(res, status, code, message, details) {
  return res.status(status).json({ error: { code, message, ...(details !== undefined && { details }) } });
}

// Express error handler: malformed / oversized JSON and anything unexpected.
// Never echoes the request body (it may contain passwords or keys).
function jsonErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body", code: "INVALID_JSON" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large", code: "PAYLOAD_TOO_LARGE" });
  }
  console.error("Unhandled error:", err.message);
  return res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
}

module.exports = { apiError, jsonErrorHandler };
