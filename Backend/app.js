// Express app factory (no listening, no DB init) so tests can build the real app.
const express = require("express");
const cors = require("cors");
const { createAuthRouter } = require("./routes/auth");
const { createDeviceRouter } = require("./routes/devices");
const readingsRoutes = require("./routes/readings");
const alertRoutes = require("./routes/alerts");
const dashboardRoutes = require("./routes/dashboard");
const mlRoutes = require("./routes/ml");
const { createControllerRouter } = require("./routes/controllers");
const { createBreakerRouter } = require("./routes/breakers");
const commandRoutes = require("./routes/commands");
const { createDeviceV1Router } = require("./routes/deviceV1");
const { rateLimit } = require("./middleware/rateLimit");
const { jsonErrorHandler } = require("./middleware/errors");

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Railway terminates TLS at a proxy; trust one hop so req.ip is the real client for rate limits.
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));

  // CORS_ORIGIN: comma-separated list of allowed frontend origins (set this in production).
  // Unset = allow any origin (local development only).
  const corsOrigins = (process.env.CORS_ORIGIN || "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
  app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "32kb" }));

  app.get("/", (req, res) => res.json({ status: "ok", message: "Smart breaker API is running" }));
  app.get("/health", (req, res) => res.json({ status: "ok" }));

  // Legacy device upload path: per controller+IP limit (ESP32 posts about every 3 s).
  const legacyDeviceLimiter = rateLimit({
    name: "device",
    windowMs: 60_000,
    max: 120,
    key: (req) => `${req.ip}:${req.body?.device_id ?? req.body?.controller_id ?? "?"}`,
    legacy: true,
  });

  // Existing routes (unchanged paths)
  app.use("/api/auth", createAuthRouter());
  app.use("/api/devices", createDeviceRouter());
  app.use("/readings", (req, res, next) => (req.method === "POST" ? legacyDeviceLimiter(req, res, next) : next()), readingsRoutes);
  app.use("/alerts", alertRoutes);
  app.use("/api/dashboard", dashboardRoutes);

  // New resource API (docs/API_CONTRACT.md)
  app.use("/api/controllers", createControllerRouter());
  app.use("/api/breakers", createBreakerRouter());
  app.use("/api/commands", commandRoutes);
  app.use("/api/device/v1", createDeviceV1Router());
  app.use("/api/ml", mlRoutes);

  app.use((req, res) => res.status(404).json({ error: "Not found", code: "NOT_FOUND" }));
  app.use(jsonErrorHandler);
  return app;
}

module.exports = { createApp };
