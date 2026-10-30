/**
 * index.js - Main Express + Socket.IO Server
 * 
 * Entry point for the MicroClimate Monitor backend.
 * Sets up the HTTP server, REST API routes, WebSocket events,
 * serial/demo data handling, and threshold-based alerting.
 */

// ---------------------------------------------------------------------------
// Load environment variables from .env
// ---------------------------------------------------------------------------
require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

// Local modules
const db = require('./db');
const { router: authRouter, authenticateToken, JWT_SECRET } = require('./auth');
const serialManager = require('./serial');

// ---------------------------------------------------------------------------
// App & Server setup
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);

// Socket.IO with CORS enabled for development
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Parse JSON request bodies
app.use(express.json());

// Serve static files from the public/ directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Auth routes (no token required for signup/login/logout)
// ---------------------------------------------------------------------------

app.use('/api', authRouter);

// ---------------------------------------------------------------------------
// Alert cooldown tracking
// Prevents duplicate alerts for the same parameter within 60 seconds
// ---------------------------------------------------------------------------

/** @type {Map<string, number>} parameterName → last alert timestamp (ms) */
const alertCooldowns = new Map();
const ALERT_COOLDOWN_MS = 60 * 1000; // 60 seconds

/**
 * Check whether we should suppress an alert for a given parameter.
 * @param {string} parameter
 * @returns {boolean} true if the alert should be sent (not in cooldown)
 */
function canAlert(parameter) {
  const now = Date.now();
  const lastAlert = alertCooldowns.get(parameter);
  if (lastAlert && now - lastAlert < ALERT_COOLDOWN_MS) {
    return false; // Still in cooldown
  }
  alertCooldowns.set(parameter, now);
  return true;
}

// ---------------------------------------------------------------------------
// Serial data callback
// Called every time a new sensor reading arrives (real or demo)
// ---------------------------------------------------------------------------

serialManager.onData = (data) => {
  try {
    const { temp, hum, soil } = data;
    const timestamp = new Date().toISOString();

    // 1. Save reading to the database
    db.saveReading(temp, hum, soil);

    // 2. Emit the reading to ALL connected (authenticated) Socket.IO clients
    io.emit('reading', { temp, hum, soil, timestamp });

    // 3. Check thresholds for ALL registered users and generate alerts
    const users = db.getAllUserIds();
    for (const { id: userId } of users) {
      const t = db.getThresholds(userId);

      // Temperature checks
      if (temp < t.tempMin && canAlert('temp_low')) {
        emitAlert('Temperature', temp, t.tempMin, 'warning',
          `Temperature dropped to ${temp}°C (below minimum ${t.tempMin}°C)`);
      }
      if (temp > t.tempMax && canAlert('temp_high')) {
        emitAlert('Temperature', temp, t.tempMax, 'critical',
          `Temperature spiked to ${temp}°C (above maximum ${t.tempMax}°C)`);
      }

      // Humidity checks
      if (hum < t.humMin && canAlert('hum_low')) {
        emitAlert('Humidity', hum, t.humMin, 'warning',
          `Humidity dropped to ${hum}% (below minimum ${t.humMin}%)`);
      }
      if (hum > t.humMax && canAlert('hum_high')) {
        emitAlert('Humidity', hum, t.humMax, 'critical',
          `Humidity rose to ${hum}% (above maximum ${t.humMax}%)`);
      }

      // Soil moisture checks
      if (soil < t.soilMin && canAlert('soil_low')) {
        emitAlert('Soil Moisture', soil, t.soilMin, 'warning',
          `Soil moisture dropped to ${soil}% (below minimum ${t.soilMin}%)`);
      }
      if (soil > t.soilMax && canAlert('soil_high')) {
        emitAlert('Soil Moisture', soil, t.soilMax, 'critical',
          `Soil moisture rose to ${soil}% (above maximum ${t.soilMax}%)`);
      }

      // Only need to check thresholds once if they're the same for all users.
      // For per-user thresholds, we check all users but use a single cooldown.
      // In practice most deployments have a single user.
      break; // Remove this break if you want per-user threshold evaluation
    }
  } catch (err) {
    console.error('[Server] Error processing sensor data:', err.message);
  }
};

/**
 * Save an alert to the database and broadcast it via Socket.IO.
 */
function emitAlert(parameter, value, threshold, severity, message) {
  const alert = { parameter, value, threshold, severity, message };
  const { id } = db.saveAlert(alert);
  const timestamp = new Date().toISOString();

  const fullAlert = { id, timestamp, parameter, value, threshold, severity, message };
  io.emit('alert', fullAlert);
  console.log(`[Alert] ${severity.toUpperCase()}: ${message}`);
}

// ---------------------------------------------------------------------------
// Protected API routes (all require authenticateToken)
// ---------------------------------------------------------------------------

// ---- Sensor Readings ----
app.get('/api/readings', authenticateToken, (req, res) => {
  try {
    const range = req.query.range || '1h';
    const start = req.query.start;
    const end = req.query.end;
    const readings = db.getReadings(range, start, end);
    res.json(readings);
  } catch (err) {
    console.error('[API] Error fetching readings:', err.message);
    res.status(500).json({ error: 'Failed to fetch readings.' });
  }
});

// ---- Thresholds ----
app.get('/api/thresholds', authenticateToken, (req, res) => {
  try {
    const thresholds = db.getThresholds(req.user.id);
    res.json(thresholds);
  } catch (err) {
    console.error('[API] Error fetching thresholds:', err.message);
    res.status(500).json({ error: 'Failed to fetch thresholds.' });
  }
});

app.post('/api/thresholds', authenticateToken, (req, res) => {
  try {
    const { tempMin, tempMax, humMin, humMax, soilMin, soilMax } = req.body;
    db.saveThresholds(req.user.id, { tempMin, tempMax, humMin, humMax, soilMin, soilMax });
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error saving thresholds:', err.message);
    res.status(500).json({ error: 'Failed to save thresholds.' });
  }
});

// ---- Alerts ----
app.get('/api/alerts', authenticateToken, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const alerts = db.getAlerts(limit);
    res.json(alerts);
  } catch (err) {
    console.error('[API] Error fetching alerts:', err.message);
    res.status(500).json({ error: 'Failed to fetch alerts.' });
  }
});

app.delete('/api/alerts', authenticateToken, (_req, res) => {
  try {
    db.clearAlerts();
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error clearing alerts:', err.message);
    res.status(500).json({ error: 'Failed to clear alerts.' });
  }
});

// ---- Serial Port / Device Management ----
app.get('/api/ports', authenticateToken, async (_req, res) => {
  try {
    const ports = await serialManager.listPorts();
    res.json(ports);
  } catch (err) {
    console.error('[API] Error listing ports:', err.message);
    res.status(500).json({ error: 'Failed to list serial ports.' });
  }
});

app.post('/api/connect', authenticateToken, async (req, res) => {
  try {
    const { port } = req.body;
    if (!port) {
      return res.status(400).json({ error: 'Port path is required.' });
    }
    await serialManager.connect(port);
    // Broadcast status change to all clients
    io.emit('status', serialManager.getStatus());
    res.json({ success: true, port });
  } catch (err) {
    console.error('[API] Error connecting to port:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/disconnect', authenticateToken, async (_req, res) => {
  try {
    await serialManager.disconnect();
    io.emit('status', serialManager.getStatus());
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Error disconnecting:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', authenticateToken, (_req, res) => {
  try {
    res.json(serialManager.getStatus());
  } catch (err) {
    console.error('[API] Error getting status:', err.message);
    res.status(500).json({ error: 'Failed to get status.' });
  }
});

app.post('/api/demo', authenticateToken, (req, res) => {
  try {
    const { enabled } = req.body;
    if (enabled) {
      serialManager.startDemo();
    } else {
      serialManager.stopDemo();
    }
    // Broadcast status change to all clients
    io.emit('status', serialManager.getStatus());
    res.json({ success: true, demoMode: serialManager.demoMode });
  } catch (err) {
    console.error('[API] Error toggling demo mode:', err.message);
    res.status(500).json({ error: 'Failed to toggle demo mode.' });
  }
});

// ---------------------------------------------------------------------------
// Root redirect
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => {
  res.redirect('/index.html');
});

// ---------------------------------------------------------------------------
// Socket.IO authentication & connection handling
// ---------------------------------------------------------------------------

io.use((socket, next) => {
  // Verify JWT from the handshake auth token
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded; // Attach user info to the socket
    next();
  } catch (err) {
    return next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`[Socket.IO] User connected: ${socket.user.email} (socket ${socket.id})`);

  // Send current device status immediately upon connection
  socket.emit('status', serialManager.getStatus());

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] User disconnected: ${socket.user.email} (socket ${socket.id})`);
  });
});

// ---------------------------------------------------------------------------
// Auto-start demo mode if configured
// ---------------------------------------------------------------------------

const demoFlag = process.argv.includes('--demo');
const demoEnv = process.env.DEMO_MODE === 'true';

if (demoFlag || demoEnv) {
  console.log('[Server] Auto-starting demo mode...');
  serialManager.startDemo();
}

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║        🌱 MicroClimate Monitor Server               ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  🌐 URL:       http://localhost:${PORT}                 ║`);
  console.log(`║  📊 Demo Mode: ${serialManager.demoMode ? 'ON ' : 'OFF'}                              ║`);
  console.log(`║  💾 Database:  data/microclimate.db                  ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Endpoints:                                         ║');
  console.log('║    POST /api/signup     - Create an account          ║');
  console.log('║    POST /api/login      - Sign in                    ║');
  console.log('║    GET  /api/readings   - Sensor history             ║');
  console.log('║    GET  /api/alerts     - Alert history              ║');
  console.log('║    GET  /api/status     - Device status              ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
});
