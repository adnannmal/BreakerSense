const { iso } = require("./health");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = ["pending", "delivered"];

function commandTtlSeconds() {
  const n = Number(process.env.COMMAND_TTL_SECONDS);
  return n > 0 ? Math.floor(n) : 30;
}

// Commands are expired lazily: any read or write path first moves in-flight commands whose
// expires_at has passed to 'expired', so a controller that reconnects later never receives them.
async function expireStaleCommands(db, { controllerId, breakerPk } = {}) {
  const where = [];
  const params = [];
  if (controllerId) {
    params.push(controllerId);
    where.push(`controller_id = $${params.length}`);
  }
  if (breakerPk) {
    params.push(breakerPk);
    where.push(`breaker_pk = $${params.length}`);
  }
  await db.query(
    `UPDATE commands SET status = 'expired'
     WHERE status IN ('pending', 'delivered') AND expires_at <= NOW()
     ${where.length ? "AND " + where.join(" AND ") : ""}`,
    params
  );
}

// Public shape of a command (docs/API_CONTRACT.md "Command object").
// row must include breaker_id (joined from breakers).
function formatCommand(row) {
  return {
    command_id: row.command_id,
    controller_id: row.controller_id,
    breaker_id: row.breaker_id,
    requested_state: row.requested_state,
    status: row.status,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    delivered_at: iso(row.delivered_at),
    delivery_count: row.delivery_count,
    acknowledged_at: iso(row.acknowledged_at),
    reported_contactor_state: row.reported_contactor_state,
    error: row.error,
    // The firmware reports the state it commanded; there is no independent contactor feedback yet.
    physically_verified: false,
  };
}

const COMMAND_SELECT = `
  SELECT c.*, b.breaker_id, b.channel_number
  FROM commands c JOIN breakers b ON b.id = c.breaker_pk`;

module.exports = { UUID_PATTERN, ACTIVE_STATUSES, commandTtlSeconds, expireStaleCommands, formatCommand, COMMAND_SELECT };