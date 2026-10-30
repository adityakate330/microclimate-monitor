/**
 * serial.js - Serial Port Management and Demo Mode
 * 
 * Manages communication with an Arduino/microcontroller over a serial port
 * and provides a "demo mode" that generates realistic fake sensor data.
 */

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// ---------------------------------------------------------------------------
// SerialManager
// ---------------------------------------------------------------------------

class SerialManager {
  constructor() {
    /** @type {SerialPort|null} Currently open serial port */
    this.port = null;
    /** @type {ReadlineParser|null} Line parser attached to the port */
    this.parser = null;
    /** @type {string|null} Path of the connected port (e.g. "COM3") */
    this.portPath = null;
    /** @type {boolean} Whether demo mode is active */
    this.demoMode = false;
    /** @type {NodeJS.Timeout|null} Demo data generation interval */
    this.demoInterval = null;
    /** @type {number} Counter used for sin/cos wave generation */
    this.demoTick = 0;
    /**
     * Callback invoked whenever a new data reading is received.
     * Set by index.js to handle saving, threshold checking, and broadcasting.
     * @type {function({ temp: number, hum: number, soil: number })|null}
     */
    this.onData = null;
  }

  // -------------------------------------------------------------------------
  // Port listing
  // -------------------------------------------------------------------------

  /**
   * List all available serial ports on the system.
   * @returns {Promise<Array<{ path: string, manufacturer: string, vendorId: string, productId: string }>>}
   */
  async listPorts() {
    try {
      const ports = await SerialPort.list();
      return ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer || 'Unknown',
        vendorId: p.vendorId || '',
        productId: p.productId || '',
      }));
    } catch (err) {
      console.error('[Serial] Error listing ports:', err.message);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Connect / Disconnect
  // -------------------------------------------------------------------------

  /**
   * Open a serial connection to the given port path.
   * Expects the device to send JSON lines like: {"temp":22.5,"hum":60.1,"soil":45.3}
   * @param {string} portPath - e.g. "COM3" or "/dev/ttyUSB0"
   * @returns {Promise<void>}
   */
  connect(portPath) {
    return new Promise((resolve, reject) => {
      // Don't open if already connected
      if (this.port && this.port.isOpen) {
        return reject(new Error('Already connected. Disconnect first.'));
      }

      // Stop demo mode if it's running
      if (this.demoMode) {
        this.stopDemo();
      }

      try {
        // Open the serial port at 9600 baud (standard Arduino speed)
        this.port = new SerialPort({ path: portPath, baudRate: 9600 });
        this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));
        this.portPath = portPath;

        // Handle incoming data lines
        this.parser.on('data', (line) => {
          try {
            const data = JSON.parse(line.trim());
            if (this.onData && data.temp !== undefined && data.hum !== undefined && data.soil !== undefined) {
              this.onData({
                temp: parseFloat(data.temp),
                hum: parseFloat(data.hum),
                soil: parseFloat(data.soil),
              });
            }
          } catch (parseErr) {
            // Ignore lines that aren't valid JSON (e.g. debug messages)
            console.warn('[Serial] Non-JSON line received:', line.trim());
          }
        });

        // Handle port open event
        this.port.on('open', () => {
          console.log(`[Serial] Connected to ${portPath}`);
          resolve();
        });

        // Handle errors
        this.port.on('error', (err) => {
          console.error('[Serial] Port error:', err.message);
        });

        // Handle unexpected close
        this.port.on('close', () => {
          console.log('[Serial] Port closed');
          this.port = null;
          this.parser = null;
          this.portPath = null;
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Close the current serial connection.
   * @returns {Promise<void>}
   */
  disconnect() {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.port.isOpen) {
        this.port = null;
        this.parser = null;
        this.portPath = null;
        return resolve();
      }

      this.port.close((err) => {
        if (err) {
          console.error('[Serial] Error closing port:', err.message);
          return reject(err);
        }
        this.port = null;
        this.parser = null;
        this.portPath = null;
        console.log('[Serial] Disconnected');
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Demo mode
  // -------------------------------------------------------------------------

  /**
   * Start generating fake sensor data every 2 seconds.
   * Uses sin/cos wave patterns with small random noise for realism.
   * Occasionally generates out-of-range spikes to test alert functionality.
   */
  startDemo() {
    if (this.demoMode) return; // Already running

    // Disconnect any real port first
    if (this.port && this.port.isOpen) {
      this.port.close();
      this.port = null;
      this.parser = null;
      this.portPath = null;
    }

    this.demoMode = true;
    this.demoTick = 0;

    console.log('[Serial] Demo mode started – generating fake sensor data every 2s');

    this.demoInterval = setInterval(() => {
      this.demoTick++;

      // --- Generate realistic oscillating values ---
      // Temperature: oscillates between 20-30°C using a sine wave
      let temp = 25 + 5 * Math.sin(this.demoTick * 0.05);
      // Humidity: oscillates between 45-75% using a cosine wave (offset phase)
      let hum = 60 + 15 * Math.cos(this.demoTick * 0.03);
      // Soil moisture: oscillates between 35-65% using a sine wave (different frequency)
      let soil = 50 + 15 * Math.sin(this.demoTick * 0.04);

      // Add a small amount of random noise (±1)
      temp += (Math.random() - 0.5) * 2;
      hum += (Math.random() - 0.5) * 2;
      soil += (Math.random() - 0.5) * 2;

      // --- Occasionally generate out-of-range spikes (5% chance) ---
      if (Math.random() < 0.05) {
        // Pick a random parameter to spike
        const spike = Math.floor(Math.random() * 3);
        if (spike === 0) {
          temp = Math.random() > 0.5 ? 38 + Math.random() * 5 : 10 - Math.random() * 5;
        } else if (spike === 1) {
          hum = Math.random() > 0.5 ? 85 + Math.random() * 10 : 20 - Math.random() * 10;
        } else {
          soil = Math.random() > 0.5 ? 75 + Math.random() * 10 : 20 - Math.random() * 10;
        }
      }

      // Round to 1 decimal place for clean display
      temp = Math.round(temp * 10) / 10;
      hum = Math.round(hum * 10) / 10;
      soil = Math.round(soil * 10) / 10;

      // Invoke the data callback (same as real serial data)
      if (this.onData) {
        this.onData({ temp, hum, soil });
      }
    }, 2000);
  }

  /**
   * Stop generating fake sensor data.
   */
  stopDemo() {
    if (this.demoInterval) {
      clearInterval(this.demoInterval);
      this.demoInterval = null;
    }
    this.demoMode = false;
    this.demoTick = 0;
    console.log('[Serial] Demo mode stopped');
  }

  // -------------------------------------------------------------------------
  // Status helpers
  // -------------------------------------------------------------------------

  /**
   * Check if a real serial port is currently connected.
   * @returns {boolean}
   */
  isConnected() {
    return !!(this.port && this.port.isOpen);
  }

  /**
   * Get the current connection status.
   * @returns {{ connected: boolean, port: string|null, demoMode: boolean }}
   */
  getStatus() {
    return {
      connected: this.isConnected(),
      port: this.portPath,
      demoMode: this.demoMode,
    };
  }
}

// ---------------------------------------------------------------------------
// Export a singleton instance
// ---------------------------------------------------------------------------

module.exports = new SerialManager();
