const { sendError } = require("./errors");

// Small fixed-window, in-memory rate limiter. Good enough for a single Railway instance;
// with several instances each one counts separately (swap for a Redis store if that happens).
//
//   rateLimit({ name: "login", windowMs: 15 * 60_000, max: 20, key: (req) => req.ip })
//
// Limits can be overridden with env variables RATE_LIMIT_<NAME>_MAX / RATE_LIMIT_<NAME>_WINDOW_MS,
// and switched off entirely with RATE_LIMIT_DISABLED=true.
function rateLimit({ name, windowMs, max, key }) {
  const envName = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const buckets = new Map();

  const middleware = (req, res, next) => {
    if (process.env.RATE_LIMIT_DISABLED === "true") return next();

    const limit = Number(process.env[`RATE_LIMIT_${envName}_MAX`]) || max;
    const window = Number(process.env[`RATE_LIMIT_${envName}_WINDOW_MS`]) || windowMs;
    const id = key(req);
    const now = Date.now();

    let bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + window };
      buckets.set(id, bucket);
    }
    bucket.count += 1;

    if (bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return sendError(res, 429, "RATE_LIMITED", "Too many requests, slow down", { retry_after_seconds: retryAfter });
    }
    next();
  };

  // Drop expired buckets so the map can't grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(id);
  }, 60_000);
  sweep.unref();

  middleware.reset = () => buckets.clear();
  return middleware;
}

module.exports = { rateLimit };