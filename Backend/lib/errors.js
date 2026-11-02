// One error shape for every endpoint:
//   { "error": "Human readable message", "code": "MACHINE_READABLE_CODE", ...extra }
// `error` stays a plain string so existing frontend code that shows `body.error` keeps working;
// new code should branch on `code`. The full list of codes is in docs/API_CONTRACT.md.
function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: message, code, ...extra });
}

// Wrap async route handlers so a thrown error turns into a JSON 500 instead of a hung request.
function asyncHandler(label, fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      // Log the message and Postgres error code only — never request bodies or headers,
      // which can contain API keys, tokens or passwords.
      console.error(`${label} error:`, err.code || "", err.message);
      if (!res.headersSent) sendError(res, 500, "INTERNAL_ERROR", `${label} failed`);
    }
  };
}

module.exports = { sendError, asyncHandler };