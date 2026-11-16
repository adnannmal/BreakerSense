// BreakerSense - single-channel recovery firmware
// Based on the clean PZEM/remote-control revision 8d0104438520.
// This is a recovery baseline, not the proposed Sprint 3 multi-channel API.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <PZEM004Tv30.h>
#include <time.h>
#include <math.h>
#include <cstring>

#include "secrets.h"      // WIFI_SSID, WIFI_PASSWORD, DEVICE_ID, DEVICE_API_KEY
#include "railway_cert.h" // RAILWAY_ROOT_CA

namespace {
constexpr uint8_t MOSFET_PIN = 25;
constexpr uint8_t PZEM_RX_PIN = 16;
constexpr uint8_t PZEM_TX_PIN = 17;
constexpr unsigned long UPDATE_INTERVAL_MS = 3000;
constexpr unsigned long WIFI_RETRY_INTERVAL_MS = 10000;

// Safe default for recovery. ONLY consider enabling after qualified review
// and verifying the driver on an isolated, current-limited low-voltage fixture.
// This is a software interlock, NOT a replacement for a hardware fail-safe.
constexpr bool ENABLE_OUTPUT_ON = false;

const char *BACKEND_URL = "https://breaker-backend-production-bb10.up.railway.app";
PZEM004Tv30 pzem(Serial2, PZEM_RX_PIN, PZEM_TX_PIN);

// Commanded GPIO state, NOT verified physical contactor position.
bool outputCommandedOn = false;
unsigned long lastUpdate = 0;
unsigned long lastWifiRetry = 0;

struct MeterReading {
    float voltage;
    float current;
    float power;
    float energy;
    float frequency;
    float powerFactor;
};

void commandOff() {
    digitalWrite(MOSFET_PIN, LOW);
    outputCommandedOn = false;
    Serial.println("[OUTPUT] OFF commanded (physical feedback unverified).");
}

bool commandOn() {
    if (!ENABLE_OUTPUT_ON) {
        Serial.println("[SAFETY] ON blocked: output test not enabled.");
        return false;
    }
    digitalWrite(MOSFET_PIN, HIGH);
    outputCommandedOn = true;
    Serial.println("[OUTPUT] ON commanded (physical feedback unverified).");
    return true;
}

void connectWiFi() {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.println("[WiFi] Connecting...");
    const unsigned long started = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - started < 15000UL) {
        delay(250);
    }
    if (WiFi.status() == WL_CONNECTED) {
        Serial.print("[WiFi] Connected. IP: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("[WiFi] Connection pending or unavailable.");
    }
}

void maintainWiFi() {
    if (WiFi.status() == WL_CONNECTED) return;
    if (millis() - lastWifiRetry < WIFI_RETRY_INTERVAL_MS) return;
    lastWifiRetry = millis();
    Serial.println("[WiFi] Retrying...");
    WiFi.reconnect();
}

void setupClock() {
    configTime(0, 0, "time.cloudflare.com", "pool.ntp.org", "time.google.com");
    const unsigned long started = millis();
    while (time(nullptr) < 1700000000 && millis() - started < 15000UL) {
        delay(250);
    }
    Serial.println(time(nullptr) >= 1700000000 ?
                   "[NTP] Time synchronized." : "[NTP] No valid time yet.");
}

bool networkReady() {
    return WiFi.status() == WL_CONNECTED && time(nullptr) >= 1700000000;
}

bool readPZEM(MeterReading &r) {
    r.voltage = pzem.voltage();
    r.current = pzem.current();
    r.power = pzem.power();
    r.energy = pzem.energy();
    r.frequency = pzem.frequency();
    r.powerFactor = pzem.pf();

    // A failed UART read is NOT a zero-power reading.
    if (!isfinite(r.voltage) || !isfinite(r.current) || !isfinite(r.power) ||
        !isfinite(r.energy) || !isfinite(r.frequency) || !isfinite(r.powerFactor) ||
        r.voltage < 0 || r.current < 0 || r.power < 0 || r.energy < 0 ||
        r.frequency < 0 || r.powerFactor < 0 || r.powerFactor > 1) {
        Serial.println("[PZEM] Invalid or unavailable reading.");
        return false;
    }
    return true;
}

void printReading(const MeterReading &r) {
    Serial.println("\n------ PZEM LIVE DATA ------");
    Serial.printf("Voltage: %.2f V\n", r.voltage);
    Serial.printf("Current: %.4f A\n", r.current);
    Serial.printf("Real Power: %.2f W\n", r.power);
    Serial.printf("Energy: %.4f kWh\n", r.energy);
    Serial.printf("Frequency: %.2f Hz\n", r.frequency);
    Serial.printf("Power Factor: %.3f\n", r.powerFactor);
    Serial.printf("GPIO Command State: %s\n", outputCommandedOn ? "ON" : "OFF");
    Serial.println("Physical Contactor Feedback: UNKNOWN");
    Serial.println("----------------------------");
}

// The existing Railway backend expects these legacy endpoints and X-API-Key.
int postToBackend(const char *path, const String &payload, String &response) {
    response = "";
    if (!networkReady()) {
        Serial.println("[API] Skipped: Wi-Fi or NTP unavailable.");
        return -1;
    }
    WiFiClientSecure client;
    client.setCACert(RAILWAY_ROOT_CA);
    HTTPClient http;
    if (!http.begin(client, String(BACKEND_URL) + path)) {
        Serial.println("[API] HTTPS initialization failed.");
        return -1;
    }
    http.setTimeout(3500);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-API-Key", DEVICE_API_KEY);
    const int code = http.POST(payload);
    if (code > 0) response = http.getString();
    http.end();
    return code;
}

void sendReading(const MeterReading &r) {
    JsonDocument body;
    body["device_id"] = DEVICE_ID;
    body["voltage"] = r.voltage;
    body["current"] = r.current;
    body["power"] = r.power;
    // Legacy API only; do not invent unsupported temperature readings.
    body["status"] = outputCommandedOn ? "ON" : "OFF";
    String payload;
    serializeJson(body, payload);
    String reply;
    const int code = postToBackend("/readings", payload, reply);
    Serial.printf("[API] Live reading upload HTTP: %d\n", code);
    if (code > 0 && code != 200) Serial.println(reply);
}

void sendStatusOnly() {
    // A sensor fault must not overwrite the last valid electrical measurements.
    JsonDocument body;
    body["device_id"] = DEVICE_ID;
    body["status"] = outputCommandedOn ? "ON" : "OFF";
    String payload;
    serializeJson(body, payload);
    String reply;
    const int code = postToBackend("/readings", payload, reply);
    Serial.printf("[API] Status-only upload HTTP: %d\n", code);
    if (code > 0 && code != 200) Serial.println(reply);
}

void checkRemoteCommand(bool meterValid) {
    if (!networkReady()) return;
    JsonDocument request;
    request["device_id"] = DEVICE_ID;
    String payload;
    serializeJson(request, payload);
    String reply;
    const int code = postToBackend("/readings/command", payload, reply);
    if (code != 200) {
        Serial.printf("[COMMAND] Poll failed: %d\n", code);
        return;
    }
    JsonDocument data;
    if (deserializeJson(data, reply)) {
        Serial.println("[COMMAND] Invalid JSON response.");
        return;
    }
    const char *requested = data["requested_status"] | "";
    if (strcmp(requested, "OFF") == 0) {
        if (outputCommandedOn) commandOff();
    } else if (strcmp(requested, "ON") == 0 && !outputCommandedOn) {
        if (!meterValid) {
            Serial.println("[SAFETY] Remote ON blocked: sensor unavailable.");
            return;
        }
        commandOn();
    }
}

void handleSerialCommands() {
    if (!Serial.available()) return;
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    cmd.toUpperCase();
    if (cmd == "ON") {
        commandOn();
    } else if (cmd == "OFF") {
        commandOff();
    } else if (cmd == "READ") {
        MeterReading r;
        if (readPZEM(r)) printReading(r);
    } else if (cmd == "STATUS") {
        Serial.printf("[STATUS] GPIO commanded: %s, physical state: UNKNOWN\n",
                      outputCommandedOn ? "ON" : "OFF");
    } else if (cmd.length()) {
        Serial.println("Commands: ON, OFF, READ, STATUS");
    }
}
} // namespace

void setup() {
    // GPIO default must ALSO be enforced externally during boot/reset.
    digitalWrite(MOSFET_PIN, LOW);
    pinMode(MOSFET_PIN, OUTPUT);
    digitalWrite(MOSFET_PIN, LOW);
    outputCommandedOn = false;

    Serial.begin(9600);
    Serial.setTimeout(100);
    Serial.println("\nBreakerSense - PZEM single-channel recovery firmware");
    Serial.println(ENABLE_OUTPUT_ON ? "[SAFETY] Low-voltage ON test enabled." :
                                     "[SAFETY] Output ON disabled by default.");
    connectWiFi();
    setupClock();
    Serial.println("[SYSTEM] Ready. Commands: ON, OFF, READ, STATUS");
}

void loop() {
    handleSerialCommands();
    maintainWiFi();
    if (millis() - lastUpdate < UPDATE_INTERVAL_MS) return;
    lastUpdate = millis();

    MeterReading r;
    const bool valid = readPZEM(r);
    if (valid) printReading(r);
    checkRemoteCommand(valid);
    if (valid) sendReading(r);
    else sendStatusOnly();
    Serial.println("[SYSTEM] Cycle complete.");
}
