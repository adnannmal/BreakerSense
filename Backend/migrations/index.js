
 // Versioned, additive database migrations.
 //
 // Uses a BreakerSense-specific tracking table to avoid conflicts
 // with an existing schema_migrations table.
 //
 // Each migration runs once, inside its own transaction.
 // A PostgreSQL advisory lock prevents concurrent migrations.
 //
 // Existing application tables and user data are preserved.

const MIGRATIONS = [
  require("./001_baseline"),
  require("./002_pzem_fields"),
  require("./003_controllers_breakers"),
  require("./004_commands"),
  require("./005_ml_appliance"),
];

const LOCK_KEY = 4815162342;

const MIGRATION_TABLE = "breakersense_schema_migrations";

async function runMigrations(pool, { log = console.log } = {}) {
  const client = await pool.connect();

  try {
    // Prevent multiple instances from migrating simultaneously.
    await client.query(
      "SELECT pg_advisory_lock($1)",
      [LOCK_KEY]
    );

    // Create a dedicated BreakerSense migration tracking table.
    await client.query(`
      CREATE TABLE IF NOT EXISTS breakersense_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Find migrations that have already been applied.
    const { rows } = await client.query(
      "SELECT version FROM breakersense_schema_migrations"
    );

    const applied = new Set(
      rows.map((r) => r.version)
    );

    const ran = [];

    // Apply any pending migrations.
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }

      await client.query("BEGIN");

      try {
        await migration.up(client);

        await client.query(
          `INSERT INTO breakersense_schema_migrations
           (version, name)
           VALUES ($1, $2)`,
          [migration.version, migration.name]
        );

        await client.query("COMMIT");

      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});

        throw new Error(
          `Migration ${migration.version}_${migration.name} failed: ${error.message}`
        );
      }

      ran.push(
        `${migration.version}_${migration.name}`
      );

      log(
        `Applied migration ${migration.version}_${migration.name}`
      );
    }

    return ran;

  } finally {
    await client.query(
      "SELECT pg_advisory_unlock($1)",
      [LOCK_KEY]
    ).catch(() => {});

    client.release();
  }
}

module.exports = {
  runMigrations,
  MIGRATIONS,
};
