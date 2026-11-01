// Run with: npm test   (uses Node's built-in test runner, no extra packages)
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseReading } = require("../validation/readings");

test("accepts the currently verified ESP32 payload", () => {
  const r = parseReading({ device_id: "esp32-1", voltage: 120.4, current: 0.5, power: 60.2 });
  assert.deepEqual(r.values, { voltage: 120.4, current: 0.5, power: 60.2, temperature: null });
});

test("accepts numeric strings", () => {
  assert.equal(parseReading({ voltage: "120.4" }).values.voltage, 120.4);
});

test("contactor OFF: ~120 V with 0 A / 0 W is valid", () => {
  const r = parseReading({ voltage: 120.1, current: 0, power: 0 });
  assert.deepEqual(r.values, { voltage: 120.1, current: 0, power: 0, temperature: null });
});

test("rejects non-numeric values instead of storing null", () => {
  assert.equal(parseReading({ voltage: "abc", current: 1 }).field, "voltage");
  assert.equal(parseReading({ voltage: 120, current: true }).field, "current");
  assert.equal(parseReading({ voltage: 120, power: "" }).field, "power");
  assert.equal(parseReading({ voltage: 120, power: {} }).field, "power");
});

test("rejects negative and out-of-range values", () => {
  assert.equal(parseReading({ voltage: -1 }).field, "voltage");
  assert.equal(parseReading({ voltage: 1000 }).field, "voltage");
  assert.equal(parseReading({ current: 500 }).field, "current");
  assert.equal(parseReading({ power: -5 }).field, "power");
  assert.equal(parseReading({ temperature: 999 }).field, "temperature");
});

test("negative temperature is allowed within range", () => {
  assert.equal(parseReading({ temperature: -10 }).values.temperature, -10);
});

test("rejects payloads with no measurements so the last good reading is kept", () => {
  assert.ok(parseReading({ device_id: "esp32-1" }).error);
  assert.ok(parseReading({ device_id: "esp32-1", voltage: null, current: null }).error);
  assert.ok(parseReading(undefined).error);
});

test("limits can be changed with env variables", () => {
  process.env.READING_MAX_VOLTAGE = "150";
  try {
    assert.equal(parseReading({ voltage: 200 }).field, "voltage");
  } finally {
    delete process.env.READING_MAX_VOLTAGE;
  }
});