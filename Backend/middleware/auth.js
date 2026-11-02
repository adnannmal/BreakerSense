const jwt = require("jsonwebtoken");
const { sendError } = require("../lib/errors");

const JWT_ALGORITHM = "HS256";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

function signUserToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { algorithm: JWT_ALGORITHM, expiresIn: JWT_EXPIRES_IN });
}

// Protects routes by checking for "Authorization: Bearer <token>".
// If valid, attaches the logged-in user's id to req.userId.
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return sendError(res, 401, "AUTH_REQUIRED", "No token provided");
  }

  const token = header.slice("Bearer ".length).trim();
  try {
    // Pin the algorithm so a token signed any other way is rejected.
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
    if (!Number.isInteger(payload.userId)) {
      return sendError(res, 401, "INVALID_TOKEN", "Invalid or expired token");
    }
    req.userId = payload.userId;
    next();
  } catch (err) {
    return sendError(res, 401, "INVALID_TOKEN", "Invalid or expired token");
  }
}

module.exports = { requireAuth, signUserToken };