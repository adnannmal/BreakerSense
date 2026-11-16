
 // BreakerSense migration 4: command state machine.
 // Compatible with an existing empty commands table.
 // Keeps legacy breaker_pk/requested_state columns.

async function hasColumn(db, columnName) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'commands'
       AND column_name = $1`,
    [columnName]
  );
  return rows.length > 0;
}

async function hasConstraint(db, constraintName) {
  const { rows } = await db.query(
    `SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.commands'::regclass
       AND conname = $1`,
    [constraintName]
  );
  return rows.length > 0;
}

module.exports = {
  version: 4,
  name: "commands",

  async up(db) {
    // Refuse to guess how to convert old commands.
    // Your existing table currently has zero rows.

    const table = await db.query(
      `SELECT to_regclass('public.commands') AS table_name`
    );

    if (table.rows[0].table_name !== null) {
      const existing = await db.query(
        `SELECT COUNT(*)::integer AS count
         FROM public.commands`
      );

      if (existing.rows[0].count !== 0) {
        throw new Error(
          "Existing commands table is not empty; manual migration required"
        );
      }
    }

    // Create the new schema on fresh databases.
    // Existing tables are preserved.

    await db.query(`
      CREATE TABLE IF NOT EXISTS public.commands (
        command_id UUID PRIMARY KEY
          DEFAULT gen_random_uuid(),
        breaker_id TEXT NOT NULL
          REFERENCES public.breakers(breaker_id)
          ON DELETE CASCADE,
        controller_id TEXT NOT NULL
          REFERENCES public.devices(device_id)
          ON DELETE CASCADE,
        channel_number INTEGER NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'QUEUED',
        requested_by INTEGER
          REFERENCES public.users(id) ON DELETE SET NULL,
        idempotency_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        delivered_at TIMESTAMPTZ,
        delivery_count INTEGER NOT NULL DEFAULT 0,
        acknowledged_at TIMESTAMPTZ,
        ack_source TEXT,
        reported_state TEXT,
        failure_reason TEXT
      );
    `);

    // Add missing V1 columns to older tables.

    for (const definition of [
      "breaker_id TEXT REFERENCES public.breakers(breaker_id) ON DELETE CASCADE",
      "channel_number INTEGER",
      "action TEXT",
      "ack_source TEXT",
      "reported_state TEXT",
      "failure_reason TEXT",
    ]) {
      await db.query(
        `ALTER TABLE public.commands
         ADD COLUMN IF NOT EXISTS ${definition};`
      );
    }

    // Retain the legacy columns, but allow NULL.
    // The new backend does not populate these fields.

    for (const legacyColumn of [
      "breaker_pk",
      "requested_state",
    ]) {
      if (await hasColumn(db, legacyColumn)) {
        await db.query(
          `ALTER TABLE public.commands
           ALTER COLUMN ${legacyColumn} DROP NOT NULL;`
        );
      }
    }

    // Ensure the new backend's defaults are present.

    await db.query(`
      ALTER TABLE public.commands
      ALTER COLUMN command_id
      SET DEFAULT gen_random_uuid();
    `);

    await db.query(`
      ALTER TABLE public.commands
      ALTER COLUMN status SET DEFAULT 'QUEUED';
    `);

    await db.query(`
      ALTER TABLE public.commands
      ALTER COLUMN delivery_count SET DEFAULT 0;
    `);

    await db.query(`
      ALTER TABLE public.commands
      ALTER COLUMN created_at SET DEFAULT NOW();
    `);

    // Require the fields for every new command.

    for (const requiredColumn of [
      "breaker_id",
      "channel_number",
      "action",
    ]) {
      await db.query(
        `ALTER TABLE public.commands
         ALTER COLUMN ${requiredColumn} SET NOT NULL;`
      );
    }

    // Enforce valid remote command actions.

    if (!(await hasConstraint(
      db,
      "commands_bs_action_check"
    ))) {
      await db.query(`
        ALTER TABLE public.commands
        ADD CONSTRAINT commands_bs_action_check
        CHECK (action IN ('ON', 'OFF'));
      `);
    }

    // Enforce valid command lifecycle states.

    if (!(await hasConstraint(
      db,
      "commands_bs_status_check"
    ))) {
      await db.query(`
        ALTER TABLE public.commands
        ADD CONSTRAINT commands_bs_status_check
        CHECK (status IN (
          'QUEUED',
          'DELIVERED',
          'APPLIED',
          'FAILED',
          'REJECTED',
          'EXPIRED',
          'SUPERSEDED'
        ));
      `);
    }

    // Add owner foreign key if missing.

    if (!(await hasConstraint(
      db,
      "commands_requested_by_fkey"
    ))) {
      await db.query(`
        ALTER TABLE public.commands
        ADD CONSTRAINT commands_requested_by_fkey
        FOREIGN KEY (requested_by)
        REFERENCES public.users(id)
        ON DELETE SET NULL;
      `);
    }

    // Ensure unique command identifiers.

    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      commands_bs_command_id_unique
      ON public.commands (command_id);
    `);

    // Prevent duplicate idempotency keys per user.

    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      commands_bs_idempotency_unique
      ON public.commands (
        requested_by,
        idempotency_key
      );
    `);

    // Optimize pending-command polling.

    await db.query(`
      CREATE INDEX IF NOT EXISTS
      commands_pending_idx
      ON public.commands (
        controller_id,
        expires_at
      )
      WHERE status IN ('QUEUED', 'DELIVERED');
    `);

    // Optimize command history lookups.

    await db.query(`
      CREATE INDEX IF NOT EXISTS
      commands_breaker_time_idx
      ON public.commands (
        breaker_id,
        created_at DESC
      );
    `);
  },
};
