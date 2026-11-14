const { Pool, types } = require("pg");
const { runMigrations } = require("./migrations");

// Postgres NUMERIC columns come back from node-pg as STRINGS ("237.4") by default.
// Parse them as real numbers so the frontend gets 237.4 instead of "237.4".
// (1700 is the Postgres type id for NUMERIC.)
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

// SSL: Railway's *internal* URL (postgres.railway.internal) and a local Postgres don't use SSL;
// Railway's *public* proxy URL does. Decide from the hostname instead of NODE_ENV, because
// NODE_ENV isn't reliably "production" on Railway. Override with PGSSL=true / PGSSL=false.
function useSsl(connectionString) {
  if (process.env.PGSSL === "true") return true;
  if (process.env.PGSSL === "false") return false;
  if (!connectionString) return false;
  try {
    const host = new URL(connectionString).hostname;
    return !(host === "localhost" || host === "127.0.0.1" || host.endsWith(".railway.internal"));
  } catch {
    return false;
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX) || 10,
});

// Schema lives in versioned migrations (./migrations). Each runs once, in a transaction,
// and is recorded in schema_migrations. Additive only: nothing is dropped or deleted.
async function initDb() {
  await runMigrations(pool);
  console.log("Database tables ready");
}

module.exports = { pool, initDb };
