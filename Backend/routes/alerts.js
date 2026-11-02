const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendError } = require("../lib/errors");

const router = express.Router();

router.use(requireAuth);

// GET /alerts?device_id=esp32-1 — open alerts for the user's controllers.
// Each row also carries breaker_id so multi-breaker controllers can be told apart.
router.get("/", async (req, res) => {
  try {
    const params = [req.userId];
    let deviceFilter = "";
    if (req.query.device_id) {
      params.push(req.query.device_id);
      deviceFilter = "AND a.device_id = $2";
    }
    const result = await pool.query(
      `SELECT a.*, d.nickname, b.breaker_id FROM alerts a
       JOIN devices d ON d.device_id = a.device_id
       LEFT JOIN breakers b ON b.id = a.breaker_pk
       WHERE d.user_id = $1 AND a.resolved = FALSE ${deviceFilter}
       ORDER BY a.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Fetch alerts error:", err.code || "", err.message);
    sendError(res, 500, "INTERNAL_ERROR", "Could not load alerts");
  }
});
/*
router.put("/:id/resolve", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE alerts SET resolved = TRUE
       WHERE id = $1 AND device_id IN (SELECT device_id FROM devices WHERE user_id = $2)
       RETURNING *`,
      [req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Alert not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Resolve alert error:", err);
    res.status(500).json({ error: "Could not resolve alert" });
  }
});
*/

module.exports = router;