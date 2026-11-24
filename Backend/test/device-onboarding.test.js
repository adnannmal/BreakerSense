const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const deviceRoutes = require("../routes/devices");
const readingsRoutes = require("../routes/readings");
const { generateDeviceKey, hashDeviceKey } = require("../security/deviceKeys");

const app = express();
app.use(express.json());
app.use("/api/devices", deviceRoutes);
app.use("/readings", readingsRoutes);

const jwtSecret = "device-onboarding-test-secret";
const token = jwt.sign({ userId: 7 }, jwtSecret);
let server;
let baseUrl;
let originalQuery;

before(async () => {
  process.env.JWT_SECRET = jwtSecret;
  originalQuery = pool.query;
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  pool.query = originalQuery;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("assigns a logical channel only to a device owned by the user", async () => {
  let queryParameters;
  pool.query = async (query, parameters) => {
    assert.match(query, /UPDATE devices\s+SET channel = \$1/);
    queryParameters = parameters;
    return {
      rows: [{ device_id: parameters[1], channel: parameters[0] }],
    };
  };

  const response = await fetch(`${baseUrl}/api/devices/esp32-1/channel`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: "Panel A / Circuit 1" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    device_id: "esp32-1",
    channel: "Panel A / Circuit 1",
  });
  assert.deepEqual(queryParameters, ["Panel A / Circuit 1", "esp32-1", 7]);
});

test("clears a logical channel when the assignment is removed", async () => {
  pool.query = async (query, parameters) => {
    assert.deepEqual(parameters, [null, "esp32-1", 7]);
    return { rows: [{ device_id: "esp32-1", channel: null }] };
  };

  const response = await fetch(`${baseUrl}/api/devices/esp32-1/channel`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: null }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    device_id: "esp32-1",
    channel: null,
  });
});

test("registers the assigned channel and returns the device key without caching it", async () => {
  let insertedParameters;
  pool.query = async (query, parameters) => {
    if (/SELECT device_id\s+FROM devices/.test(query)) {
      return { rows: [] };
    }
    assert.match(query, /INSERT INTO devices/);
    insertedParameters = parameters;
    return {
      rows: [{
        device_id: parameters[0],
        channel: parameters[4],
        nickname: parameters[2],
      }],
    };
  };

  const response = await fetch(`${baseUrl}/api/devices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      device_id: "esp32-new",
      nickname: "Workshop",
      location: "Garage",
      channel: "Panel A / Circuit 1",
      capacity_amps: 20,
      status: "OFF",
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.channel, "Panel A / Circuit 1");
  assert.match(body.api_key, /^bk_[a-f0-9]{64}$/);
  assert.deepEqual(insertedParameters.slice(0, 6), [
    "esp32-new",
    7,
    "Workshop",
    "Garage",
    "Panel A / Circuit 1",
    20,
  ]);
});

test("rejects overlong channel labels before querying the database", async () => {
  pool.query = async () => {
    throw new Error("Database should not be queried for invalid channel labels");
  };

  const response = await fetch(`${baseUrl}/api/devices/esp32-1/channel`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: "x".repeat(81) }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "channel must be 80 characters or fewer",
  });
});

test("rotating a key invalidates the previous connection timestamp", async () => {
  pool.query = async (query, parameters) => {
    assert.match(query, /SET api_key_hash = \$1,\s+last_seen_at = NULL/);
    assert.match(parameters[0], /^[a-f0-9]{64}$/);
    assert.deepEqual(parameters.slice(1), ["esp32-1", 7]);
    return { rows: [{ device_id: "esp32-1" }] };
  };

  const response = await fetch(
    `${baseUrl}/api/devices/esp32-1/rotate-key`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body.api_key, /^bk_[a-f0-9]{64}$/);
});

test("records an authenticated status-only payload as device contact", async () => {
  const apiKey = generateDeviceKey();
  const apiKeyHash = hashDeviceKey(apiKey);
  let heartbeatRecorded = false;
  pool.query = async (query, parameters) => {
    if (/SELECT device_id, api_key_hash/.test(query)) {
      return { rows: [{ device_id: "esp32-1", api_key_hash: apiKeyHash }] };
    }
    if (/SELECT device_id, nickname/.test(query)) {
      return {
        rows: [{
          device_id: "esp32-1",
          nickname: "Test breaker",
          voltage_threshold: 264,
          current_threshold: 20,
          power_threshold: null,
          temperature_threshold: 60,
        }],
      };
    }
    if (/UPDATE devices SET last_seen_at = NOW\(\)/.test(query)) {
      heartbeatRecorded = parameters[0] === "esp32-1";
      return { rows: [] };
    }
    if (/SET status = \$1/.test(query)) {
      return { rows: [] };
    }
    throw new Error(`Unexpected database query: ${query}`);
  };

  const response = await fetch(`${baseUrl}/readings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ device_id: "esp32-1", status: "OFF" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    device_id: "esp32-1",
    status: "OFF",
  });
  assert.equal(heartbeatRecorded, true);
});
