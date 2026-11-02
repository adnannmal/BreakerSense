require("dotenv").config();
const { initDb, pruneReadingsLog } = require("./db");
const { createApp } = require("./app");

// Fail loudly at startup instead of 500-ing on the first login.
for (const name of ["DATABASE_URL", "JWT_SECRET"]) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name} (set it in Railway > Variables)`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET.length < 32) {
  console.warn("JWT_SECRET is shorter than 32 characters; use a long random value in production.");
}

const app = createApp();
const PORT = process.env.PORT || 4000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

    // Retention: drop history older than READINGS_RETENTION_DAYS (default 7) once an hour.
    const prune = () =>
      pruneReadingsLog()
        .then((n) => n && console.log(`Pruned ${n} old readings`))
        .catch((e) => console.error("Log prune error:", e.message));
    prune();
    setInterval(prune, 60 * 60 * 1000).unref();
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });