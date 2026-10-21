const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const params = [req.userId];
    let deviceFilter = "";
    if (req.query.device_id) {
      params.push(req.query.device_id);
      deviceFilter = "AND a.device_id = $2";
    }
    const result = await pool.query(
      `SELECT a.*, d.nickname FROM alerts a
       JOIN devices d ON d.device_id = a.device_id
       WHERE d.user_id = $1 AND a.resolved = FALSE ${deviceFilter}
       ORDER BY a.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Fetch alerts error:", err);
    res.status(500).json({ error: "Could not load alerts" });
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
