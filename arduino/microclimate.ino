/*
 * ============================================================
 *  MicroClimate Monitor — Arduino Firmware
 * ============================================================
 *
 *  College project: reads temperature, humidity, and soil
 *  moisture every 2 seconds and sends each reading to the
 *  computer over Serial as a single JSON line.
 *
 *  A companion Python script (or any serial‑terminal program)
 *  can receive and log the data.
 *
 * ------------------------------------------------------------
 *  REQUIRED LIBRARIES  (install via Arduino Library Manager)
 * ------------------------------------------------------------
 *  1. "DHT sensor library" by Adafruit
 *     → provides the DHT class used to talk to the sensor
 *  2. "Adafruit Unified Sensor" by Adafruit
 *     → dependency required by the DHT library
 *
 *  To install:
 *    Sketch → Include Library → Manage Libraries…
 *    Search for "DHT sensor library" and install it.
 *    If prompted, also install "Adafruit Unified Sensor".
 *
 * ------------------------------------------------------------
 *  COMPONENTS LIST
 * ------------------------------------------------------------
 *  • 1 × Arduino Uno (or Nano / Mega)
 *  • 1 × DHT11 temperature & humidity sensor (3‑pin module)
 *  • 1 × Capacitive or resistive soil‑moisture sensor (analog)
 *  • 1 × 10 kΩ pull‑up resistor (only if using a bare DHT11;
 *        most breakout modules include one on‑board)
 *  • Breadboard + jumper wires
 *  • USB cable for Serial communication
 *
 * ------------------------------------------------------------
 *  WIRING DIAGRAM  (ASCII)
 * ------------------------------------------------------------
 *
 *         Arduino Uno
 *        ┌──────────┐
 *        │          │
 *   5V ──┤ 5V       │
 *        │          │
 *  GND ──┤ GND      │
 *        │          │              ┌─────────────┐
 *   D2 ──┤ D2       │──────────── │ DHT11 DATA  │
 *        │          │              │  (+ to 5V)  │
 *        │          │              │  (− to GND) │
 *        │          │              └─────────────┘
 *        │          │
 *        │          │              ┌──────────────────┐
 *   A0 ──┤ A0       │──────────── │ Soil Sensor AOUT │
 *        │          │              │  (VCC  to 5V)    │
 *        │          │              │  (GND  to GND)   │
 *        └──────────┘              └──────────────────┘
 *
 *  DHT11 wiring (3‑pin module):
 *    VCC  → Arduino 5V
 *    DATA → Arduino D2  (10 kΩ pull‑up to 5V if bare sensor)
 *    GND  → Arduino GND
 *
 *  Soil moisture sensor wiring:
 *    VCC  → Arduino 5V
 *    GND  → Arduino GND
 *    AOUT → Arduino A0
 *
 * ============================================================
 */

// ── Library ────────────────────────────────────────────────
#include "DHT.h"            // Adafruit DHT sensor library

// ── Pin definitions ────────────────────────────────────────
#define DHTPIN        2     // Digital pin connected to DHT11 DATA
#define SOIL_PIN      A0    // Analog pin connected to soil sensor

// ── Sensor type ────────────────────────────────────────────
#define DHTTYPE       DHT11 // Change to DHT22 if using that model

// ── Soil‑moisture calibration constants ────────────────────
// Measure the raw analog value when the sensor is in dry air
// and when it is submerged in water, then update these values.
//   DRY_VALUE  → raw reading in completely dry conditions
//   WET_VALUE  → raw reading in fully saturated / wet soil
// Most capacitive sensors output a HIGHER value when dry and
// a LOWER value when wet, so DRY_VALUE > WET_VALUE.
#define DRY_VALUE     1023
#define WET_VALUE     300

// ── Timing ─────────────────────────────────────────────────
// How often to take a reading (in milliseconds).
// The DHT11 can only be read once every ~1–2 seconds.
#define READ_INTERVAL 2000  // 2 seconds

// ── Create the DHT sensor object ───────────────────────────
DHT dht(DHTPIN, DHTTYPE);

// ============================================================
//  setup()  — runs once when the board powers on or resets
// ============================================================
void setup() {
  // Start the Serial connection at 9600 baud so we can send
  // JSON data to the computer.
  Serial.begin(9600);

  // Initialize the DHT sensor library.
  dht.begin();

  // Short startup message (useful for debugging).
  Serial.println("{\"status\":\"MicroClimate Monitor started\"}");
}

// ============================================================
//  loop()  — runs repeatedly after setup()
// ============================================================
void loop() {

  // ── 1. Read temperature and humidity from the DHT11 ──────
  // read functions return NaN if the sensor cannot be read.
  float temperature = dht.readTemperature();   // °C
  float humidity    = dht.readHumidity();       // %

  // ── 2. Check for read failures ───────────────────────────
  // isnan() returns true when the float is "Not a Number",
  // which means the sensor did not respond correctly.
  if (isnan(temperature) || isnan(humidity)) {
    // Send an error message so the receiver knows this
    // reading was skipped.
    Serial.println("{\"error\":\"DHT read failed\"}");

    // Wait before trying again.
    delay(READ_INTERVAL);
    return;   // Skip the rest of loop() for this cycle.
  }

  // ── 3. Read raw soil moisture (analog 0–1023) ────────────
  int rawSoil = analogRead(SOIL_PIN);

  // ── 4. Convert raw value to a 0–100 % moisture scale ────
  // map() linearly re‑maps rawSoil from the calibration
  // range [DRY_VALUE … WET_VALUE] to [0 … 100].
  //   • When rawSoil == DRY_VALUE → result is 0 %
  //   • When rawSoil == WET_VALUE → result is 100 %
  int moisturePercent = map(rawSoil, DRY_VALUE, WET_VALUE, 0, 100);

  // constrain() clamps the result so it never falls outside
  // 0–100 even if the raw value is beyond the calibration
  // endpoints.
  moisturePercent = constrain(moisturePercent, 0, 100);

  // ── 5. Build and send the JSON string over Serial ────────
  // We construct the JSON manually to keep the firmware
  // small (no need for an external JSON library).
  //
  // Output example:  {"temp":28.50,"hum":62.00,"soil":45}
  Serial.print("{\"temp\":");
  Serial.print(temperature, 2);     // 2 decimal places
  Serial.print(",\"hum\":");
  Serial.print(humidity, 2);        // 2 decimal places
  Serial.print(",\"soil\":");
  Serial.print(moisturePercent);
  Serial.println("}");              // newline terminates the JSON line

  // ── 6. Wait before the next reading ──────────────────────
  delay(READ_INTERVAL);
}
