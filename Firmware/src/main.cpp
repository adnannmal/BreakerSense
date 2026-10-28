#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <WiFi.h>
#include "secrets.h"
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include "railway_cert.h"

Adafruit_ADS1115 ads;

// Pins
const int MOSFET_PIN = 25;
const int VOLTAGE_PIN = 35;

// Contactor state
bool contactorOn = false;

// Settings
const int SAMPLE_COUNT = 300;
const unsigned long UPDATE_INTERVAL = 3000;
const float ESP32_ADC_MAX = 4095.0;
const float ESP32_ADC_VOLTAGE = 3.3;

// ADS1115 GAIN_ONE = 0.000125 V per bit
const float ADS_LSB_SIZE = 0.000125;


// Function declarations
void handleSerialCommands();
void turnContactorOn();
void turnContactorOff();

float readVoltageRMS();
float readADSCurrentRMS();

void connectWiFi() {
    Serial.print("Connecting to Wi-Fi");

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long start = millis();

    while (WiFi.status() != WL_CONNECTED &&
           millis() - start < 15000) {
        delay(500);
        Serial.print(".");
    }

    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("Wi-Fi Connected!");
        Serial.print("ESP32 IP Address: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("Wi-Fi connection failed.");
    }
}

void testRailwayHTTPS() {
    Serial.println("Testing Railway HTTPS...");

    WiFiClientSecure client;
    client.setCACert(RAILWAY_ROOT_CA);

    HTTPClient http;

    if (!http.begin(
        client,
        "https://breaker-backend-production-bb10.up.railway.app/health"
    )) {
        Serial.println("HTTPS initialization failed");
        return;
    }

    http.setTimeout(10000);

    int responseCode = http.GET();

    Serial.print("HTTP Response: ");
    Serial.println(responseCode);

    if (responseCode == 200) {
        Serial.println(http.getString());
        Serial.println("Secure Railway connection successful!");
    } else if (responseCode < 0) {
        Serial.println(http.errorToString(responseCode));
    }

    http.end();
}


void sendTestReading() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("Cannot send: Wi-Fi disconnected.");
        return;
    }

    // Require a synchronized clock for TLS validation.
    if (time(nullptr) < 1700000000) {
        Serial.println("Cannot send: clock not synchronized.");
        return;
    }

    WiFiClientSecure client;
    client.setCACert(RAILWAY_ROOT_CA);

    HTTPClient http;

    const char* url =
        "https://breaker-backend-production-bb10.up.railway.app/readings";

    if (!http.begin(client, url)) {
        Serial.println("Failed to initialize HTTPS.");
        return;
    }

    http.setTimeout(10000);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-API-Key", DEVICE_API_KEY);

    // Simulated values only, NOT sensor measurements.
    String payload = "{";
    payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
    payload += "\"voltage\":120.4,";
    payload += "\"current\":0.5,";
    payload += "\"power\":60.2";
    payload += "}";

    Serial.println("Sending simulated reading to Railway...");

    int responseCode = http.POST(payload);

    Serial.print("HTTP Response: ");
    Serial.println(responseCode);

    if (responseCode == 200) {
        Serial.println("Reading uploaded successfully!");
    } else if (responseCode > 0) {
        Serial.println("Backend rejected reading:");
        Serial.println(http.getString());
    } else {
        Serial.print("HTTPS error: ");
        Serial.println(http.errorToString(responseCode));
    }

    http.end();
}

void setup() {
  Serial.begin(9600);
  connectWiFi(); // Connect to Wi-Fi

  if (WiFi.status() == WL_CONNECTED) {

      Serial.println("Starting NTP synchronization...");

      configTime(
          0,
          0,
          "time.cloudflare.com",
          "pool.ntp.org",
          "time.google.com"
      );

      unsigned long start = millis();
      time_t now = time(nullptr);

      while (now < 1700000000 && millis() - start < 30000) {
          delay(1000);

          now = time(nullptr);

          Serial.print("Waiting for time: ");
          Serial.println((long)now);
      }

      if (now >= 1700000000) {
          struct tm timeinfo;
          gmtime_r(&now, &timeinfo);

          Serial.println("NTP synchronization successful!");
          Serial.print("Current UTC time: ");
          Serial.println(asctime(&timeinfo));

          testRailwayHTTPS();
      } else {
          Serial.println("NTP failed after 30 seconds.");
          Serial.println("Check internet access and UDP port 123.");
      }
  }

  
  pinMode(MOSFET_PIN, OUTPUT); // Set MOSFET_PIN as output
  digitalWrite(MOSFET_PIN, LOW); // Ensure the contactor is off initially

  Wire.begin(21, 22); // Initialize I2C with SDA on GPIO21 and SCL on GPIO22


  Serial.println();
  Serial.println("Smart Breaker Basic Test Started");
  Serial.println("Type ON or OFF");
  Serial.println();
}


void loop() {
    // Preserve manual contactor commands.
    handleSerialCommands();

    static unsigned long lastUpdate = 0;

    if (millis() - lastUpdate >= UPDATE_INTERVAL) {
        lastUpdate = millis();

        // Existing sensor functions.
        float voltage = readVoltageRMS();
        float adsCurrent = readADSCurrentRMS();

        Serial.println("----- Readings -----");

        Serial.print("Contactor: ");
        Serial.println(contactorOn ? "ON" : "OFF");

        Serial.print("Voltage Sensor GPIO35: ");
        Serial.println(voltage, 2);
        Serial.println(" V");

        Serial.print("ADS1115 CT A0/A1: ");
        Serial.print(adsCurrent, 4);
        Serial.println(" A");

        // Network test only — simulated values.
        sendTestReading();

        Serial.println("--------------------");
    }
}


void handleSerialCommands() { // Handle serial commands to control the contactor
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    command.toUpperCase();

    if (command == "ON") {
      turnContactorOn();
    } else if (command == "OFF") {
      turnContactorOff();
    } else {
      Serial.println("Unknown command. Type ON or OFF.");
    }
  }
}

void turnContactorOn() { // Turn the contactor on by setting the MOSFET_PIN HIGH
  digitalWrite(MOSFET_PIN, HIGH);
  contactorOn = true;
  Serial.println("Contactor ON");
}

void turnContactorOff() { // Turn the contactor off by setting the MOSFET_PIN LOW
  digitalWrite(MOSFET_PIN, LOW);
  contactorOn = false;
  Serial.println("Contactor OFF");
}

float readESP32SensorRMS(int pin) { // Read RMS voltage from ESP32 ADC pin
  long sum = 0;

  for (int i = 0; i < SAMPLE_COUNT; i++) { // take readings and sum them up
    sum += analogRead(pin);
  }

  float midpoint = sum / (float)SAMPLE_COUNT; // calculate midpoint for DC offset
  float squaredSum = 0;

  for (int i = 0; i < SAMPLE_COUNT; i++) { // take readings again to calculate RMS
    float raw = analogRead(pin);
    float centered = raw - midpoint;
    squaredSum += centered * centered;
  }

  float adcRMS = sqrt(squaredSum / SAMPLE_COUNT); // calculate RMS value
  float sensorVoltageRMS = adcRMS * (ESP32_ADC_VOLTAGE / ESP32_ADC_MAX); // convert to voltage

  return sensorVoltageRMS;
}

float readADSCurrentSensorRMS() { // Read RMS current from ADS1115 differential input A0/A1
  long sum = 0;

  for (int i = 0; i < SAMPLE_COUNT; i++) { // take readings and sum them up
    int16_t raw = ads.readADC_Differential_0_1();
    sum += raw;
  }

  float midpoint = sum / (float)SAMPLE_COUNT; // calculate midpoint for DC offset
  float squaredSum = 0;

  for (int i = 0; i < SAMPLE_COUNT; i++) { // take readings again to calculate RMS
    int16_t raw = ads.readADC_Differential_0_1();
    float centered = raw - midpoint;
    squaredSum += centered * centered;
  }

  float adcRMS = sqrt(squaredSum / SAMPLE_COUNT); // calculate RMS value
  float sensorVoltageRMS = adcRMS * ADS_LSB_SIZE;

  return sensorVoltageRMS;
}

float readVoltageRMS() {
    int raw = analogRead(35);
    return (float)raw;
}

float readADSCurrentRMS() {
    return 0.0;
}