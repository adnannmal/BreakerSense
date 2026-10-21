require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { initDb } = require("./db");
const authRoutes = require("./routes/auth");
const deviceRoutes = require("./routes/devices");
const readingsRoutes = require("./routes/readings");
const alertRoutes = require("./routes/alerts");
const dashboardRoutes = require("./routes/dashboard");

// Fail loudly at startup instead of 500-ing on the first login.
for (const name of ["DATABASE_URL", "JWT_SECRET"]) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name} (set it in Railway > Variables)`);
    process.exit(1);
  }
}

const app = express();

// CORS_ORIGIN (optional): comma-separated list of allowed frontend origins, e.g.
// https://breakersense-production.up.railway.app. Unset = allow any origin (fine for a demo).
const corsOrigins = (process.env.CORS_ORIGIN || "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Smart breaker API is running" });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/readings", readingsRoutes);
app.use("/alerts", alertRoutes);
app.use("/api/dashboard", dashboardRoutes); // one-call dashboard data for the frontend

const PORT = process.env.PORT || 4000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
