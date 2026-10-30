# 🌱 MicroClimate Monitor

> An intelligent, IoT-driven microclimate detection and precision agriculture monitoring system powered by Arduino Uno firmware and a responsive Node.js + Socket.IO real-time web dashboard.

---

## 📁 Project Directory Location

The complete project is located at:
```text
C:\Users\USER\.gemini\antigravity\scratch\microclimate-monitor
```

### File Hierarchy
```text
microclimate-monitor/
├── arduino/
│   └── microclimate.ino       # Arduino Uno C++ sketch (DHT11 + Soil Moisture)
├── server/
│   ├── index.js               # Main Express + Socket.IO backend & alert manager
│   ├── db.js                  # SQLite persistence (better-sqlite3)
│   ├── auth.js                # JWT auth, bcrypt password hashing & routes
│   └── serial.js              # USB serial port reader (serialport) & demo generator
├── public/
│   ├── index.html             # Presentation-ready glassmorphism Login & Signup
│   ├── dashboard.html         # Live single-page application dashboard
│   ├── css/
│   │   ├── auth.css           # Authentication styling & animations
│   │   └── dashboard.css      # Eco-tech dark/light glassmorphism theme
│   └── js/
│       ├── auth.js            # Auth validation, strength meter & token handling
│       └── dashboard.js       # Live gauges, Chart.js graphs, Web Audio & WebSockets
├── .env                       # Pre-configured environment variables
├── .env.example               # Template environment configuration
├── package.json               # Node.js dependencies and scripts
└── README.md                  # Comprehensive setup & hardware documentation
```

---

## ⚡ Quick Start: Running the Platform

### Step 1: Open PowerShell or Terminal
```powershell
cd C:\Users\USER\.gemini\antigravity\scratch\microclimate-monitor
```

### Step 2: Install Dependencies
```powershell
npm install
```

### Step 3: Start the Backend Server
```powershell
npm start
```
*(By default, `.env` has `DEMO_MODE=true` enabled, so you can immediately test the entire system without needing an Arduino connected!)*

### Step 4: Open the Web Application
Open your browser at:
👉 **[http://localhost:3000](http://localhost:3000)**

1. Register a new account via the **Signup** tab (or sign in).
2. You will be redirected to the **Dashboard** displaying live readings, SVG circular gauges, real-time charts, and alerts.

---

## 🔌 Hardware Setup & Wiring

### Components List
| Component | Quantity | Purpose |
| :--- | :---: | :--- |
| **Arduino Uno R3** | 1 | Microcontroller running `microclimate.ino` |
| **DHT11 Sensor** | 1 | Temperature & Relative Humidity sensor |
| **Analog Soil Moisture Sensor** | 1 | Capacitive or resistive probe with comparator |
| **10kΩ Resistor** | 1 | Pull-up resistor for DHT11 data pin (if bare sensor) |
| **Jumper Wires & Breadboard** | - | Connections |
| **USB Type-A to Type-B Cable** | 1 | Serial data transfer (9600 baud) & power |

### Wiring Diagram

```text
  ┌─────────────────────────────────────────────────────────────┐
  │                        ARDUINO UNO                          │
  │                                                             │
  │      [5V]  ────────┬────────────────┬─────────────────      │
  │      [GND] ────────┼──────┐         ┼──────┐                │
  │      [D2]  ────────┼──────┼─────────┼──────┼─── Data        │
  │      [A0]  ────────┼──────┼─────────┼──────┼──────┐ Analog  │
  └────────────────────┼──────┼─────────┼──────┼──────┼─────────┘
                       │      │         │      │      │
                  VCC ─┘      │    VCC ─┘      │      │
               DHT11      GND ┘   SOIL PROBE  GND     │
               SENSOR             SENSOR              │
                 DATA ────────────────────────────────┘ (D2)
                 AOUT ──────────────────────────────── (A0)
```

#### Pin Mapping Table
| Sensor | Sensor Pin | Arduino Pin | Notes |
| :--- | :--- | :--- | :--- |
| **DHT11** | VCC | `5V` | Power supply |
| **DHT11** | GND | `GND` | Common ground |
| **DHT11** | DATA | `D2` | Digital pin 2 (Add 10kΩ pull-up to 5V if 4-pin bare) |
| **Soil Sensor** | VCC | `5V` | Power supply |
| **Soil Sensor** | GND | `GND` | Common ground |
| **Soil Sensor** | AOUT (AO) | `A0` | Analog pin 0 (Raw 0–1023) |

---

## 🛠 Uploading the Arduino Firmware

1. Install the **Arduino IDE** (from [arduino.cc](https://www.arduino.cc/en/software)).
2. In Arduino IDE, open **Tools → Manage Libraries...** and install:
   - **`DHT sensor library` by Adafruit**
   - **`Adafruit Unified Sensor`**
3. Open `arduino/microclimate.ino`.
4. Select board: **Tools → Board → Arduino Uno**.
5. Select port: **Tools → Port → COMx** (e.g., `COM3`, `COM4` on Windows).
6. Click **Upload** (Arrow button).
7. The Arduino will begin streaming readings every 2 seconds in JSON format:
   ```json
   {"temp":28.50,"hum":62.00,"soil":45}
   ```

---

## ⚙️ Configuration & Features

- **Demo / Simulation Mode**:
  - Controlled in `Settings` page or in `.env` (`DEMO_MODE=true`).
  - Generates smooth mathematical wave sensor readings with realistic seasonal variation.
- **Auto COM Port Detection**:
  - The dashboard auto-enumerates connected COM ports in `Settings → COM Port`. Click **Connect** to lock onto hardware.
- **Smart Alert System**:
  - Default limits: Temperature (15–35°C), Humidity (30–80%), Soil Moisture (30–70%).
  - 60-second cooldown per alert parameter prevents alert spamming.
  - Audio beeps powered by Web Audio API.
- **Analytics & History**:
  - Filter data by 1 hour, 6 hours, 24 hours, 7 days, or custom date/time ranges.
  - One-click **Export CSV** download.
- **Theme & Units**:
  - Seamless toggle between Dark Glassmorphism and Light Glassmorphism.
  - Switch units on-the-fly between Celsius (°C) and Fahrenheit (°F).

---

## 🔍 Troubleshooting

| Issue | Cause | Fix |
| :--- | :--- | :--- |
| **`Access denied` / COM Port Busy** | Arduino IDE Serial Monitor is open | Close Arduino Serial Monitor before clicking "Connect" in dashboard |
| **`DHT read failed`** | Loose wiring or missing pull-up resistor | Verify D2 connection; check that DHT11 VCC is at 5V |
| **Soil always reads 0% or 100%** | Sensor dry/wet calibration offsets | Adjust `DRY_VALUE` and `WET_VALUE` at top of `microclimate.ino` |
| **No serial port visible** | Missing CH340 / FTDI USB driver | Install CH340 / CP2102 driver for clone Arduino boards |
