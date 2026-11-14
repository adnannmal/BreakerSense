// Tunable backend settings (all optional environment variables).
// Read at call time so tests can change them before building the app.

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function config() {
  return {
    // A controller is "online" if it made an authenticated request within this many seconds.
    onlineAfterSeconds: int("ONLINE_AFTER_SECONDS", 30),
    // A breaker's latest measurement is "stale" after this many seconds.
    staleAfterSeconds: int("STALE_AFTER_SECONDS", 30),
    // Remote ON/OFF commands expire after this many seconds if not acknowledged.
    commandTtlSeconds: int("COMMAND_TTL_SECONDS", 30),
    // An acknowledgment may arrive this long after expiry if the command was delivered in time.
    commandAckGraceSeconds: int("COMMAND_ACK_GRACE_SECONDS", 10),
    // readings_log (raw ~3 s history) retention. Labeled ML recordings are kept separately forever.
    readingsRetentionDays: int("READINGS_RETENTION_DAYS", 7),
    // Device-reported recorded_at further than this from server time is ignored.
    maxClockSkewSeconds: int("MAX_CLOCK_SKEW_SECONDS", 300),
  };
}

module.exports = { config };
