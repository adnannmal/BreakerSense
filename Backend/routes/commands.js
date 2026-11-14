// GET /api/commands/:command_id — status of a remote command (owner only).
// QUEUED/DELIVERED are not proof of switching; APPLIED means "controller reported it set its output".
const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { apiError } = require("../middleware/errors");
const { getCommand, serializeCommand } = require("../services/commands");

const router = express.Router();
router.use(requireAuth);

router.get("/:command_id", async (req, res) => {
  try {
    const c = await getCommand(pool, req.userId, req.params.command_id);
    if (!c) return apiError(res, 404, "COMMAND_NOT_FOUND", "Command not found");
    return res.json(serializeCommand(c));
  } catch (err) {
    console.error("Get command error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", "Could not load command");
  }
});

module.exports = router;
