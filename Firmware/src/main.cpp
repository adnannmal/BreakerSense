#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PZEM004Tv30.h>
#include <ArduinoJson.h>
#include <time.h>
#include <math.h>

#include "secrets.h"
#include "railway_cert.h"

// =====================================================
// BREAKERSENSE ESP32
//
// Features:
// - PZEM-004T live electrical measurements
// - Wi-Fi and authenticated HTTPS to Railway
// - Upload real voltage, current, and power
// - Poll for remote ON/OFF commands
// - Report software GPIO state to the backend
// - Preserve manual ON/OFF/READ serial commands
//
// IMPORTANT:
// GPIO25 must ONLY drive an isolated low-voltage
// test indicator during this integration test.
// =====================================================

// --------------------
// Hardware pins
// --------------------

const int MOSFET_PIN = 25;

const int PZEM_RX_PIN = 16;
const int PZEM_TX_PIN = 17;

PZEM004Tv30 pzem(
    Serial2,
    PZEM_RX_PIN,
    PZEM_TX_PIN
);

// --------------------
// Safety configuration
// --------------------

// Leave FALSE while connected to any mains
// contactor-control hardware.
//
// Change to TRUE only when GPIO25 drives a
// verified isolated low-voltage test indicator.
const bool ENABLE_OUTPUT_ON = true;

// Software GPIO state only.
// NOT verified physical contactor feedback.
bool contactorOn = false;

// --------------------
// Backend configuration
// --------------------

const char* BACKEND_URL =
    "https://breaker-backend-production-bb10.up.railway.app";

// WIFI_SSID, WIFI_PASSWORD, DEVICE_ID,
// DEVICE_API_KEY come from secrets.h.

// --------------------
// Timing
// --------------------

const unsigned long UPDATE_INTERVAL = 3000;
const unsigned long WIFI_RETRY_INTERVAL = 10000;

unsigned long lastUpdate = 0;
unsigned long lastWifiRetry = 0;

// --------------------
// PZEM measurement
// --------------------

struct MeterReading {
    float voltage;
    float current;
    float power;
    float energy;
    float frequency;
    float powerFactor;
};

// =====================================================
// GPIO OUTPUT CONTROL
// =====================================================

void turnContactorOff() {
    digitalWrite(MOSFET_PIN, LOW);
    contactorOn = false;

    Serial.println(
        "[GPIO] OFF command issued."
    );
}

bool turnContactorOn() {
    if (!ENABLE_OUTPUT_ON) {
        Serial.println(
            "[SAFETY] ON blocked. "
            "Low-voltage output test not enabled."
        );
        return false;
    }

    digitalWrite(MOSFET_PIN, HIGH);
    contactorOn = true;

    Serial.println(
        "[GPIO] ON command issued."
    );

    return true;
}

// =====================================================
// WIFI
// =====================================================

void connectWiFi() {
    Serial.println("[WiFi] Connecting...");

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long start = millis();

    while (
        WiFi.status() != WL_CONNECTED &&
        millis() - start < 15000
    ) {
        delay(500);
        Serial.print(".");
    }

    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("[WiFi] Connected!");

        Serial.print("[WiFi] IP: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("[WiFi] Connection failed.");
    }
}

void maintainWiFi() {
    if (WiFi.status() == WL_CONNECTED) {
        return;
    }

    if (
        millis() - lastWifiRetry <
        WIFI_RETRY_INTERVAL
    ) {
        return;
    }

    lastWifiRetry = millis();

    Serial.println("[WiFi] Reconnecting...");
    WiFi.reconnect();
}

// =====================================================
// TIME SYNCHRONIZATION
// =====================================================

void setupTime() {
    configTime(
        0,
        0,
        "time.cloudflare.com",
        "pool.ntp.org",
        "time.google.com"
    );

    Serial.println("[NTP] Synchronizing...");

    unsigned long start = millis();

    while (
        time(nullptr) < 1700000000 &&
        millis() - start < 15000
    ) {
        delay(500);
    }

    if (time(nullptr) >= 1700000000) {
        Serial.println(
            "[NTP] Time synchronized."
        );
    } else {
        Serial.println(
            "[NTP] No valid time yet."
        );
    }
}

bool networkReady() {
    return (
        WiFi.status() == WL_CONNECTED &&
        time(nullptr) >= 1700000000
    );
}

// =====================================================
// PZEM LIVE READINGS
// =====================================================

bool readPZEM(MeterReading &r) {
    r.voltage = pzem.voltage();
    r.current = pzem.current();
    r.power = pzem.power();
    r.energy = pzem.energy();
    r.frequency = pzem.frequency();
    r.powerFactor = pzem.pf();

    if (
        !isfinite(r.voltage) ||
        !isfinite(r.current) ||
        !isfinite(r.power) ||
        !isfinite(r.energy) ||
        !isfinite(r.frequency) ||
        !isfinite(r.powerFactor)
    ) {
        Serial.println(
            "[PZEM] Communication/read error."
        );
        return false;
    }

    if (
        r.voltage < 0 ||
        r.current < 0 ||
        r.power < 0 ||
        r.energy < 0 ||
        r.powerFactor < 0 ||
        r.powerFactor > 1
    ) {
        Serial.println(
            "[PZEM] Invalid measurement."
        );
        return false;
    }

    return true;
}

void printReading(const MeterReading &r) {
    Serial.println();
    Serial.println("------ PZEM LIVE DATA ------");

    Serial.print("Voltage: ");
    Serial.print(r.voltage, 2);
    Serial.println(" V");

    Serial.print("Current: ");
    Serial.print(r.current, 4);
    Serial.println(" A");

    Serial.print("Real Power: ");
    Serial.print(r.power, 2);
    Serial.println(" W");

    Serial.print("Energy: ");
    Serial.print(r.energy, 4);
    Serial.println(" kWh");

    Serial.print("Frequency: ");
    Serial.print(r.frequency, 2);
    Serial.println(" Hz");

    Serial.print("Power Factor: ");
    Serial.println(r.powerFactor, 3);

    Serial.print("GPIO Command State: ");
    Serial.println(
        contactorOn ? "ON" : "OFF"
    );

    Serial.println("----------------------------");
}

// =====================================================
// AUTHENTICATED HTTPS HELPER
// =====================================================

// Performs an authenticated POST to Railway.
// Response body is returned through responseBody.

int postToBackend(
    const char* path,
    const String &payload,
    String &responseBody
) {
    responseBody = "";

    if (!networkReady()) {
        Serial.println(
            "[API] Skipped: network/time unavailable."
        );
        return -1;
    }

    WiFiClientSecure client;
    client.setCACert(RAILWAY_ROOT_CA);

    HTTPClient http;

    String url = String(BACKEND_URL) + path;

    if (!http.begin(client, url)) {
        Serial.println(
            "[API] HTTPS initialization failed."
        );
        return -1;
    }

    http.setTimeout(3500);
    http.addHeader(
        "Content-Type",
        "application/json"
    );

    http.addHeader(
        "X-API-Key",
        DEVICE_API_KEY
    );

    int responseCode = http.POST(payload);

    if (responseCode > 0) {
        responseBody = http.getString();
    }

    http.end();

    return responseCode;
}

// =====================================================
// SEND LIVE TELEMETRY
// =====================================================

void sendReading(const MeterReading &r) {
    JsonDocument doc;

    doc["device_id"] = DEVICE_ID;
    doc["voltage"] = r.voltage;
    doc["current"] = r.current;
    doc["power"] = r.power;

    // Backend accepts ON/OFF status.
    // This is commanded GPIO state only.
    doc["status"] =
        contactorOn ? "ON" : "OFF";

    String payload;
    serializeJson(doc, payload);

    String response;

    Serial.println(
        "[API] Uploading live PZEM reading..."
    );

    int code = postToBackend(
        "/readings",
        payload,
        response
    );

    Serial.print("[API] HTTP response: ");
    Serial.println(code);

    if (code == 200) {
        Serial.println(
            "[API] Live reading uploaded."
        );
    } else if (code > 0) {
        Serial.print("[API] Rejected: ");
        Serial.println(response);
    } else {
        Serial.println(
            "[API] Upload failed."
        );
    }
}

// =====================================================
// STATUS-ONLY UPLOAD
// =====================================================

// Used when PZEM readings fail.
// Keeps the last good measurements in the backend
// while still reporting the GPIO command state.

void sendStatusOnly() {
    JsonDocument doc;

    doc["device_id"] = DEVICE_ID;
    doc["status"] =
        contactorOn ? "ON" : "OFF";

    String payload;
    serializeJson(doc, payload);

    String response;

    int code = postToBackend(
        "/readings",
        payload,
        response
    );

    Serial.print(
        "[STATUS] HTTP response: "
    );
    Serial.println(code);

    if (code == 200) {
        Serial.println(
            "[STATUS] GPIO state reported."
        );
    } else if (code > 0) {
        Serial.println(response);
    }
}

// =====================================================
// REMOTE COMMAND POLLING
// =====================================================

// Backend endpoint:
// POST /readings/command
//
// Request:
// { "device_id": "esp32-1" }
//
// Response:
// {
//   "requested_status": "ON",
//   "command_expires_at": "..."
// }
//
// The backend returns null for expired commands.

void checkRemoteCommand(bool meterValid) {
    if (!networkReady()) {
        return;
    }

    JsonDocument requestDoc;
    requestDoc["device_id"] = DEVICE_ID;

    String payload;
    serializeJson(requestDoc, payload);

    String response;

    int code = postToBackend(
        "/readings/command",
        payload,
        response
    );

    if (code != 200) {
        Serial.print(
            "[COMMAND] Poll failed: "
        );
        Serial.println(code);

        if (code > 0) {
            Serial.println(response);
        }

        return;
    }

    JsonDocument responseDoc;

    DeserializationError error =
        deserializeJson(responseDoc, response);

    if (error) {
        Serial.println(
            "[COMMAND] Invalid JSON response."
        );
        return;
    }

    const char* requested =
        responseDoc["requested_status"] | "";

    // --------------------
    // Remote ON
    // --------------------

    if (strcmp(requested, "ON") == 0) {
        if (contactorOn) {
            return;
        }

        if (!meterValid) {
            Serial.println(
                "[COMMAND] ON blocked: "
                "no valid current PZEM reading."
            );
            return;
        }

        Serial.println(
            "[COMMAND] Remote ON received."
        );

        turnContactorOn();
    }

    // --------------------
    // Remote OFF
    // --------------------

    else if (strcmp(requested, "OFF") == 0) {
        if (contactorOn) {
            Serial.println(
                "[COMMAND] Remote OFF received."
            );

            turnContactorOff();
        }
    }
}

// =====================================================
// SERIAL COMMANDS
// =====================================================

void handleSerialCommands() {
    if (!Serial.available()) {
        return;
    }

    String command =
        Serial.readStringUntil('\n');

    command.trim();
    command.toUpperCase();

    if (command == "ON") {
        turnContactorOn();
    }

    else if (command == "OFF") {
        turnContactorOff();
    }

    else if (command == "READ") {
        MeterReading r;

        if (readPZEM(r)) {
            printReading(r);
        }
    }

    else if (command == "STATUS") {
        Serial.print("[GPIO] State: ");
        Serial.println(
            contactorOn ? "ON" : "OFF"
        );
    }

    else if (command.length() > 0) {
        Serial.println(
            "Commands: ON, OFF, READ, STATUS"
        );
    }
}

// =====================================================
// SETUP
// =====================================================

void setup() {
    // Establish software OFF before network startup.
    // A physical output pull-down and fail-safe
    // driver are still required for reset/boot safety.
    digitalWrite(MOSFET_PIN, LOW);
    pinMode(MOSFET_PIN, OUTPUT);
    digitalWrite(MOSFET_PIN, LOW);
    contactorOn = false;

    Serial.begin(9600);
    Serial.setTimeout(100);

    Serial.println();
    Serial.println("============================");
    Serial.println("       BreakerSense");
    Serial.println("   PZEM + Remote Commands");
    Serial.println("============================");

    if (!ENABLE_OUTPUT_ON) {
        Serial.println(
            "[SAFETY] GPIO ON is disabled."
        );
    } else {
        Serial.println(
            "[SAFETY] Low-voltage test enabled."
        );
    }

    connectWiFi();
    setupTime();

    Serial.println();
    Serial.println("[SYSTEM] Ready");
    Serial.println(
        "Commands: ON, OFF, READ, STATUS"
    );
}

// =====================================================
// MAIN LOOP
// =====================================================

void loop() {
    handleSerialCommands();
    maintainWiFi();

    if (
        millis() - lastUpdate >=
        UPDATE_INTERVAL
    ) {
        lastUpdate = millis();

        MeterReading reading;

        // Read PZEM first.
        bool meterValid = readPZEM(reading);

        if (meterValid) {
            printReading(reading);
        } else {
            Serial.println(
                "[SYSTEM] PZEM data unavailable."
            );
        }

        // Look for website ON/OFF commands.
        checkRemoteCommand(meterValid);

        // Report new GPIO state and live values.
        if (meterValid) {
            sendReading(reading);
        } else {
            // Do not fabricate electrical readings.
            sendStatusOnly();
        }

        Serial.println(
            "[SYSTEM] Cycle complete."
        );
    }
}