const express = require("express");
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { signUserToken } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128; // bcrypt only uses the first 72 bytes; cap to avoid abuse

// The BreakerSense frontend logs in with an EMAIL, the original API used a USERNAME.
// Accept either: the email is simply stored in the `username` column (lower-cased so
// "Test@x.com" and "test@x.com" are the same account). NOTE: this is not a verified email.
function readCredentials(body) {
  const { username, email, password } = body || {};
  const raw = email ?? username;
  const name = typeof raw === "string" ? raw.trim() : "";
  return {
    username: email !== undefined && email !== null ? name.toLowerCase() : name,
    password,
  };
}

function createAuthRouter() {
  const router = express.Router();
  // Per client IP; Railway sits behind a proxy, so app.set("trust proxy") makes req.ip the real client.
  const limiter = rateLimit({ name: "auth", windowMs: 15 * 60_000, max: 20, key: (req) => req.ip, legacy: true });

  // POST /api/auth/register
  router.post("/register", limiter, async (req, res) => {
    const { username, password } = readCredentials(req.body);

    if (!username || typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    if (username.length > 254) {
      return res.status(400).json({ error: "Email is too long" });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` });
    }

    try {
      const existing = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: "An account with that email already exists" });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const result = await pool.query(
        "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
        [username, passwordHash]
      );
      const user = result.rows[0];
      res.status(201).json({ token: signUserToken(user.id), username: user.username, email: user.username });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "An account with that email already exists" });
      console.error("Register error:", err.message);
      res.status(500).json({ error: "Something went wrong creating your account" });
    }
  });

  // POST /api/auth/login
  router.post("/login", limiter, async (req, res) => {
    const { username, password } = readCredentials(req.body);

    if (!username || typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    try {
      const result = await pool.query("SELECT id, username, password_hash FROM users WHERE username = $1", [username]);
      const user = result.rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      res.json({ token: signUserToken(user.id), username: user.username, email: user.username });
    } catch (err) {
      console.error("Login error:", err.message);
      res.status(500).json({ error: "Something went wrong logging you in" });
    }
  });

  // The frontend has "forgot password" screens, but there is no verified email delivery yet.
  // Answer honestly instead of 404 or pretending a reset email was sent.
  const notAvailable = (req, res) =>
    res.status(501).json({ error: "Password reset is not available yet", code: "NOT_IMPLEMENTED" });
  router.post("/forgot-password", limiter, notAvailable);
  router.post("/reset-password", limiter, notAvailable);

  return router;
}

module.exports = { createAuthRouter };
