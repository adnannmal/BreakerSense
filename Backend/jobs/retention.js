// Scheduled pruning of raw readings_log history (replaces the old random 1%-of-requests DELETE).
// Labeled appliance recordings live in ml_session_readings and are never pruned here.
const { config } = require("../config");

async function pruneReadingsLog(pool, days = config().readingsRetentionDays) {
  const r = await pool.query(`DELETE FROM readings_log WHERE created_at < NOW() - make_interval(days => $1::int)`, [days]);
  return r.rowCount;
}

function startRetentionJob(pool, { intervalMs = 60 * 60 * 1000 } = {}) {
  const run = () =>
    pruneReadingsLog(pool)
      .then((n) => n && console.log(`Retention: pruned ${n} readings_log rows`))
      .catch((e) => console.error("Retention job error:", e.message));
  const timer = setInterval(run, intervalMs);
  timer.unref();
  setTimeout(run, 30_000).unref();
  return timer;
}

module.exports = { pruneReadingsLog, startRetentionJob };
