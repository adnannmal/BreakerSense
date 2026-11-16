// Durable remote ON/OFF commands with an explicit state machine:
//   QUEUED -> DELIVERED -> APPLIED | FAILED | REJECTED
//   QUEUED/DELIVERED -> EXPIRED (TTL passed) | SUPERSEDED (newer command for the same breaker)
// APPLIED means the controller REPORTED it set its output; it is not physical contactor feedback.

module.exports = {
  version: 4,
  name: "commands",
  async up(db) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS commands (
        command_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        breaker_id TEXT NOT NULL REFERENCES breakers(breaker_id) ON DELETE CASCADE,
        controller_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
        channel_number INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('ON', 'OFF')),
        status TEXT NOT NULL DEFAULT 'QUEUED'
          CHECK (status IN ('QUEUED', 'DELIVERED', 'APPLIED', 'FAILED', 'REJECTED', 'EXPIRED', 'SUPERSEDED')),
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        idempotency_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        delivered_at TIMESTAMPTZ,
        delivery_count INTEGER NOT NULL DEFAULT 0,
        acknowledged_at TIMESTAMPTZ,
        ack_source TEXT,
        reported_state TEXT,
        failure_reason TEXT,
        UNIQUE (requested_by, idempotency_key)
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS commands_pending_idx ON commands (controller_id, expires_at) WHERE status IN ('QUEUED', 'DELIVERED');`);
    await db.query(`CREATE INDEX IF NOT EXISTS commands_breaker_time_idx ON commands (breaker_id, created_at DESC);`);
  },
};
