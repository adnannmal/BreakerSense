// Unit tests for the /readings validator (no database needed). Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseReading } = require("../validation/readings");

const EMPTY = {
  voltage: null, current: null, power: null, apparent_power: null,
  energy_kwh: null, frequency: null, power_factor: null, temperature: null,
};

test("accepts the currently verified ESP32 payload", () => {
  const r = parseReading({ device_id: "esp32-1", voltage: 120.4, current: 0.5, power: 60.2 });
  assert.deepEqual(r.values, { ...EMPTY, voltage: 120.4, current: 0.5, power: 60.2 });
  assert.equal(r.controllerId, "esp32-1");
  assert.equal(r.breakerId, null);
  assert.equal(r.sensorStatus, "online");
});

test("accepts the full PZEM payload", () => {
  const r = parseReading({
    controller_id: "esp32-001", breaker_id: "breaker-001", voltage: 120.4, current: 0.509, power: 61.3,
    apparent_power: 61.28, energy_kwh: 0.004, frequency: 60.0, power_factor: 1.0,
    contactor_state: "on", sensor_status: "online",
  });
  assert.equal(r.error, undefined);
  assert.equal(r.values.power_factor, 1);
  assert.equal(r.contactorState, "ON");
  assert.equal(r.breakerId, "breaker-001");
});

test("accepts numeric strings", () => {
  assert.equal(parseReading({ voltage: "120.4" }).values.voltage, 120.4);
});

test("contactor OFF: ~120 V with 0 A / 0 W is valid", () => {
  const r = parseReading({ voltage: 120.1, current: 0, power: 0 });
  assert.deepEqual(r.values, { ...EMPTY, voltage: 120.1, current: 0, power: 0 });
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
  assert.equal(parseReading({ power_factor: 1.01 }).field, "power_factor");
  assert.equal(parseReading({ frequency: 99 }).field, "frequency");
  assert.equal(parseReading({ energy_kwh: -0.1 }).field, "energy_kwh");
  assert.equal(parseReading({ temperature: 999 }).field, "temperature");
});

test("negative temperature is allowed within range", () => {
  assert.equal(parseReading({ temperature: -10 }).values.temperature, -10);
});

test("rejects healthy payloads with no measurements so the last good reading is kept", () => {
  assert.equal(parseReading({ device_id: "esp32-1" }).code, "NO_MEASUREMENTS");
  assert.equal(parseReading({ device_id: "esp32-1", voltage: null, current: null }).code, "NO_MEASUREMENTS");
  assert.equal(parseReading(undefined).code, "NO_MEASUREMENTS");
});

test("sensor error reports are accepted without numbers", () => {
  const r = parseReading({ breaker_id: "breaker-001", sensor_status: "error", sensor_error: "PZEM timeout" });
  assert.equal(r.error, undefined);
  assert.equal(r.sensorStatus, "error");
  assert.equal(r.sensorError, "PZEM timeout");
});

test("rejects bad ids, states and disagreeing controller ids", () => {
  assert.equal(parseReading({ voltage: 1, breaker_id: "a b" }).field, "breaker_id");
  assert.equal(parseReading({ voltage: 1, contactor_state: "HALF" }).field, "contactor_state");
  assert.equal(parseReading({ voltage: 1, sensor_status: "ok" }).field, "sensor_status");
  assert.equal(parseReading({ voltage: 1, controller_id: "a", device_id: "b" }).field, "controller_id");
});

test("limits can be changed with env variables", () => {
  process.env.READING_MAX_VOLTAGE = "150";
  try {
    assert.equal(parseReading({ voltage: 200 }).field, "voltage");
  } finally {
    delete process.env.READING_MAX_VOLTAGE;
  }
});