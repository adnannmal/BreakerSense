const jwt = require("jsonwebtoken");

// Protects routes by checking for "Authorization: Bearer <token>".
// If valid, attaches the logged-in user's id to req.userId.
// Only HS256 tokens signed with JWT_SECRET are accepted.
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = header.slice("Bearer ".length).trim();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (!Number.isInteger(payload.userId)) throw new Error("bad payload");
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function signUserToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
}

module.exports = { requireAuth, signUserToken };
