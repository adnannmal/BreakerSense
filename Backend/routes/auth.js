const express = require("express");
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { signUserToken } = require("../middleware/auth");
const { sendError } = require("../lib/errors");
const { rateLimit } = require("../lib/rateLimit");

const router = express.Router();

// Slow down password guessing: 20 attempts per IP per 15 minutes across login + register.
const authLimiter = rateLimit({ name: "auth", windowMs: 15 * 60_000, max: 20, key: (req) => req.ip });

// The BreakerSense frontend logs in with an EMAIL, the original API used a USERNAME.
// Accept either: the email is simply stored in the `username` column (lower-cased so
// "Test@x.com" and "test@x.com" are the same account).
function readCredentials(body) {
  const { username, email, password } = body || {};
  const raw = email ?? username;
  const name = typeof raw === "string" ? raw.trim() : "";
  return {
    username: email !== undefined && email !== null ? name.toLowerCase() : name,
    password,
  };
}

// POST /api/auth/register
router.post("/register", authLimiter, async (req, res) => {
  const { username, password } = readCredentials(req.body);

  if (!username || !password || typeof password !== "string") {
    return sendError(res, 400, "VALIDATION_FAILED", "Email and password are required");
  }
  if (username.length > 254) {
    return sendError(res, 400, "VALIDATION_FAILED", "Email is too long");
  }
  if (password.length < 6) {
    return sendError(res, 400, "VALIDATION_FAILED", "Password must be at least 6 characters");
  }
  // bcrypt only uses the first 72 bytes; reject longer passwords instead of silently truncating.
  if (Buffer.byteLength(password, "utf8") > 72) {
    return sendError(res, 400, "VALIDATION_FAILED", "Password must be at most 72 bytes");
  }

  try {
    const existing = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
    if (existing.rows.length > 0) {
      return sendError(res, 409, "ACCOUNT_EXISTS", "An account with that email already exists");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
      [username, passwordHash]
    );

    const user = result.rows[0];
    const token = signUserToken(user.id);

    res.status(201).json({ token, username: user.username, email: user.username });
  } catch (err) {
    // Two registrations for the same email at the same moment.
    if (err.code === "23505") {
      return sendError(res, 409, "ACCOUNT_EXISTS", "An account with that email already exists");
    }
    console.error("Register error:", err.code || "", err.message);
    sendError(res, 500, "INTERNAL_ERROR", "Something went wrong creating your account");
  }
});

// POST /api/auth/login
router.post("/login", authLimiter, async (req, res) => {
  const { username, password } = readCredentials(req.body);

  if (!username || !password || typeof password !== "string") {
    return sendError(res, 400, "VALIDATION_FAILED", "Email and password are required");
  }

  try {
    const result = await pool.query("SELECT id, username, password_hash FROM users WHERE username = $1", [username]);
    const user = result.rows[0];

    if (!user) {
      return sendError(res, 401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return sendError(res, 401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    const token = signUserToken(user.id);
    res.json({ token, username: user.username, email: user.username });
  } catch (err) {
    console.error("Login error:", err.code || "", err.message);
    sendError(res, 500, "INTERNAL_ERROR", "Something went wrong logging you in");
  }
});

module.exports = router;