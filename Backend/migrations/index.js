// Versioned, additive database migrations.
//
// Each migration runs once, inside its own transaction, and is recorded in schema_migrations.
// A Postgres advisory lock stops two server instances from migrating at the same time.
// Migrations never DROP tables or DELETE user data. See docs/BACKEND_CHANGES.md for rollback notes.

const MIGRATIONS = [
  require("./001_baseline"),
  require("./002_pzem_fields"),
  require("./003_controllers_breakers"),
  require("./004_commands"),
  require("./005_ml_appliance"),
];

const LOCK_KEY = 4815162342; // arbitrary constant for pg_advisory_lock

async function runMigrations(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    const { rows } = await client.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));

    const ran = [];
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      await client.query("BEGIN");
      try {
        await m.up(client);
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${m.version}_${m.name} failed: ${err.message}`);
      }
      ran.push(`${m.version}_${m.name}`);
      log(`Applied migration ${m.version}_${m.name}`);
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { runMigrations, MIGRATIONS };
