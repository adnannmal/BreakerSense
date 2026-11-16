// Small in-memory fixed-window rate limiter (no dependencies).
// Good enough for one Railway instance; with several instances each one counts separately.
//
//   rateLimit({ name, windowMs, max, key: (req) => string, legacy: true })
//
// Limits are read from env when the app is built (RATE_LIMIT_<NAME>_MAX / _WINDOW_SECONDS),
// so they can be tuned without a code change.

function rateLimit({ name, windowMs, max, key, legacy = false }) {
  const envName = name.toUpperCase();
  const limit = Number(process.env[`RATE_LIMIT_${envName}_MAX`]) || max;
  const window = (Number(process.env[`RATE_LIMIT_${envName}_WINDOW_SECONDS`]) || windowMs / 1000) * 1000;
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(window, 60_000));
  sweep.unref();

  return function limiter(req, res, next) {
    if (process.env.RATE_LIMIT_DISABLED === "true") return next();
    const k = `${name}:${key(req)}`;
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + window };
      hits.set(k, entry);
    }
    entry.count++;
    res.set("RateLimit-Limit", String(limit));
    res.set("RateLimit-Remaining", String(Math.max(0, limit - entry.count)));
    if (entry.count > limit) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retry));
      const message = "Too many requests, try again later";
      return legacy
        ? res.status(429).json({ error: message, code: "RATE_LIMITED" })
        : res.status(429).json({ error: { code: "RATE_LIMITED", message, details: { retry_after_seconds: retry } } });
    }
    return next();
  };
}

module.exports = { rateLimit };
