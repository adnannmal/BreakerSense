// Integration-test harness: the REAL Express app + node-pg, talking to a real Postgres engine
// (PGlite, Postgres compiled to WebAssembly) through its wire-protocol socket server.
// Nothing touches Railway. Each test file runs in its own process with its own empty database.

const { once } = require("node:events");
const path = require("node:path");

async function startHarness({ env = {}, migrate = true } = {}) {
  Object.assign(process.env, {
    JWT_SECRET: "integration-test-secret-0123456789abcdef",
    PGSSL: "false",
    RATE_LIMIT_AUTH_MAX: "100000",
    RATE_LIMIT_DEVICE_MAX: "100000",
    RATE_LIMIT_COMMAND_MAX: "100000",
    RATE_LIMIT_KEY_MAX: "100000",
    ...env,
  });

  const { PGlite } = require("@electric-sql/pglite");
  const { PGLiteSocketServer } = require("@electric-sql/pglite-socket");
  const pg = await PGlite.create();
  const socket = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1", maxConnections: 20 });
  await socket.start();
  const port = socket.getServerConn().split(":").pop();
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${port}/postgres`;

  const root = path.join(__dirname, "..");
  const { pool } = require(path.join(root, "db"));
  const { runMigrations } = require(path.join(root, "migrations"));
  if (migrate) await runMigrations(pool, { log: () => {} });

  const app = require(path.join(root, "app")).createApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, urlPath, { token, apiKey, body, headers = {} } = {}) {
    const res = await fetch(base + urlPath, {
      method,
      headers: {
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(apiKey && { "X-API-Key": apiKey }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  let userSeq = 0;
  async function registerUser(email = `user${++userSeq}-${Date.now()}@example.test`) {
    const r = await request("POST", "/api/auth/register", { body: { email, password: "correct-horse-battery" } });
    if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
    return { token: r.body.token, email };
  }

  async function addDevice(token, deviceId, extra = {}) {
    const r = await request("POST", "/api/devices", { token, body: { device_id: deviceId, nickname: `${deviceId} name`, capacity_amps: 20, ...extra } });
    if (r.status !== 201) throw new Error(`add device failed ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.api_key;
  }

  async function addBreaker(token, controllerId, breakerId, channel, extra = {}) {
    const r = await request("POST", `/api/controllers/${controllerId}/breakers`, { token, body: { breaker_id: breakerId, channel_number: channel, ...extra } });
    if (r.status !== 201) throw new Error(`add breaker failed ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  const sendReading = (apiKey, body) => request("POST", "/readings", { apiKey, body });
  const telemetry = (apiKey, body) => request("POST", "/api/device/v1/telemetry", { apiKey, body });
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  async function close() {
    await new Promise((r) => server.close(r));
    await pool.end();
    await socket.stop();
    await pg.close();
  }

  return { base, pool, q, request, registerUser, addDevice, addBreaker, sendReading, telemetry, close, runMigrations: () => runMigrations(pool, { log: () => {} }) };
}

module.exports = { startHarness };
