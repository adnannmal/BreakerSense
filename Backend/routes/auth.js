const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");

const router = express.Router();

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
router.post("/register", async (req, res) => {
  const { username, password } = readCredentials(req.body);

  if (!username || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
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
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.status(201).json({ token, username: user.username, email: user.username });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Something went wrong creating your account" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { username, password } = readCredentials(req.body);

  if (!username || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, username: user.username, email: user.username });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Something went wrong logging you in" });
  }
});

module.exports = router;
