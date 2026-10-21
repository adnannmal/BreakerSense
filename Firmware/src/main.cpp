#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>

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

void setup() {
  Serial.begin(9600);

  pinMode(MOSFET_PIN, OUTPUT); // Set MOSFET_PIN as output
  digitalWrite(MOSFET_PIN, LOW); // Ensure the contactor is off initially

  Wire.begin(21, 22); // Initialize I2C with SDA on GPIO21 and SCL on GPIO22


  Serial.println();
  Serial.println("Smart Breaker Basic Test Started");
  Serial.println("Type ON or OFF");
  Serial.println();
}

void loop() {
  handleSerialCommands(); // Check for serial commands to control the contactor

  static unsigned long lastUpdate = 0;

  if (millis() - lastUpdate >= UPDATE_INTERVAL) { // Update readings every UPDATE_INTERVAL milliseconds
    lastUpdate = millis();

    float voltage = readVoltageRMS(); // Read voltage from ESP32 ADC
    float adsCurrent = readADSCurrentRMS(); // Read current from ADS1115

    Serial.println("----- Readings -----");

    Serial.print("Contactor: ");
    Serial.println(contactorOn ? "ON" : "OFF");

    Serial.print("Voltage Sensor GPIO35: ");
    Serial.print(voltage, 2);
    Serial.println(" V");

    Serial.print("ADS1115 CT A0/A1: ");
    Serial.print(adsCurrent, 4);
    Serial.println(" A");

    Serial.println("Type ON or OFF");
    Serial.println();
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