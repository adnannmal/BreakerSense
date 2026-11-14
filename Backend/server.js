require("dotenv").config();

// Fail loudly at startup instead of 500-ing on the first login.
for (const name of ["DATABASE_URL", "JWT_SECRET"]) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name} (set it in Railway > Variables)`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET.length < 32) {
  console.warn("WARNING: JWT_SECRET is shorter than 32 characters; use a long random value in production.");
}
if (!process.env.CORS_ORIGIN) {
  console.warn("WARNING: CORS_ORIGIN is not set; any website can call this API from a browser.");
}

const { createApp } = require("./app");
const { pool, initDb } = require("./db");
const { startRetentionJob } = require("./jobs/retention");

const PORT = process.env.PORT || 4000;

initDb()
  .then(() => {
    startRetentionJob(pool);
    createApp().listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err.message);
    process.exit(1);
  });
