const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendError, asyncHandler } = require("../lib/errors");
const { UUID_PATTERN, expireStaleCommands, formatCommand, COMMAND_SELECT } = require("../lib/commands");

const router = express.Router();
router.use(requireAuth);

// GET /api/commands/:command_id — status of one command, owner only.
// The frontend polls this after creating a command until status is no longer pending/delivered.
router.get(
  "/:command_id",
  asyncHandler("Get command", async (req, res) => {
    if (!UUID_PATTERN.test(req.params.command_id)) {
      return sendError(res, 404, "COMMAND_NOT_FOUND", "Command not found");
    }
    const owner = await pool.query(
      `SELECT c.breaker_pk FROM commands c JOIN devices d ON d.device_id = c.controller_id
       WHERE c.command_id = $1 AND d.user_id = $2`,
      [req.params.command_id, req.userId]
    );
    if (owner.rows.length === 0) return sendError(res, 404, "COMMAND_NOT_FOUND", "Command not found");

    await expireStaleCommands(pool, { breakerPk: owner.rows[0].breaker_pk });
    const result = await pool.query(`${COMMAND_SELECT} WHERE c.command_id = $1`, [req.params.command_id]);
    res.json({ server_time: new Date().toISOString(), ...formatCommand(result.rows[0]) });
  })
);

module.exports = router;