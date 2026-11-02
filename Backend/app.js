const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/auth");
const deviceRoutes = require("./routes/devices");
const readingsRoutes = require("./routes/readings");
const alertRoutes = require("./routes/alerts");
const dashboardRoutes = require("./routes/dashboard");
const controllerRoutes = require("./routes/controllers");
const commandRoutes = require("./routes/commands");
const deviceCommandRoutes = require("./routes/deviceCommands");
const { sendError } = require("./lib/errors");

// Builds the Express app without starting it, so tests can run it on a random port.
function createApp() {
  const app = express();

  app.disable("x-powered-by");
  // Railway sits behind one proxy; trust it so req.ip (used by rate limits) is the real client.
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));

  // CORS_ORIGIN (optional): comma-separated list of allowed frontend origins, e.g.
  // https://breakersense-production.up.railway.app. Unset = allow any origin (fine for a demo).
  const corsOrigins = (process.env.CORS_ORIGIN || "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
  app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));
  app.use(express.json({ limit: "16kb" }));

  app.get("/", (req, res) => {
    res.json({ status: "ok", message: "Smart breaker API is running" });
  });

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  app.use("/api/auth", authRoutes);
  app.use("/api/devices", deviceRoutes);           // controller registration + key rotation
  app.use("/api/controllers", controllerRoutes);   // controllers, breakers, history, commands (JWT)
  app.use("/api/commands", commandRoutes);         // command status (JWT)
  app.use("/api/device/commands", deviceCommandRoutes); // ESP32 poll + ack (X-API-Key)
  app.use("/readings", readingsRoutes);            // ESP32 telemetry (X-API-Key) — path kept as-is
  app.use("/alerts", alertRoutes);
  app.use("/api/dashboard", dashboardRoutes);      // one-call dashboard data for the frontend

  app.use((req, res) => sendError(res, 404, "NOT_FOUND", `No route for ${req.method} ${req.path}`));

  // Malformed JSON, oversized bodies, and anything else thrown outside a route handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return sendError(res, 400, "INVALID_JSON", "Request body is not valid JSON");
    if (err.type === "entity.too.large") return sendError(res, 413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    console.error("Unhandled error:", err.message);
    sendError(res, 500, "INTERNAL_ERROR", "Something went wrong");
  });

  return app;
}

module.exports = { createApp };