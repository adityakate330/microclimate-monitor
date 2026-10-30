/**
 * db.js - SQLite Database Setup and Query Helpers
 * 
 * Uses better-sqlite3 for synchronous database operations.
 * Creates all necessary tables and provides helper functions
 * for CRUD operations on users, readings, thresholds, and alerts.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

// Ensure the data/ directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Open (or create) the SQLite database file
const dbPath = path.join(dataDir, 'microclimate.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
// Enable foreign key support
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Table creation
// ---------------------------------------------------------------------------

db.exec(`
  -- Users table: stores account information
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    email      TEXT    NOT NULL UNIQUE,
    password   TEXT    NOT NULL,           -- bcrypt-hashed password
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Readings table: stores sensor data points
  CREATE TABLE IF NOT EXISTS readings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    temp      REAL,    -- temperature in °C
    hum       REAL,    -- relative humidity in %
    soil      REAL     -- soil moisture in %
  );

  -- Thresholds table: per-user alert threshold configuration
  CREATE TABLE IF NOT EXISTS thresholds (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE REFERENCES users(id),
    tempMin REAL DEFAULT 15,
    tempMax REAL DEFAULT 35,
    humMin  REAL DEFAULT 30,
    humMax  REAL DEFAULT 80,
    soilMin REAL DEFAULT 30,
    soilMax REAL DEFAULT 70
  );

  -- Alerts table: stores triggered alert events
  CREATE TABLE IF NOT EXISTS alerts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    parameter TEXT,     -- which sensor parameter triggered the alert
    value     REAL,     -- the actual reading value
    threshold REAL,     -- the threshold that was violated
    severity  TEXT,     -- 'warning' or 'critical'
    message   TEXT      -- human-readable alert description
  );
`);

// ---------------------------------------------------------------------------
// Prepared statements (compiled once for performance)
// ---------------------------------------------------------------------------

const stmts = {
  insertUser:        db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)'),
  findUserByEmail:   db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserById:       db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?'),
  getUserWithPass:   db.prepare('SELECT id, name, email, password FROM users WHERE id = ?'),
  updatePassword:    db.prepare('UPDATE users SET password = ? WHERE id = ?'),

  insertReading:     db.prepare('INSERT INTO readings (temp, hum, soil) VALUES (?, ?, ?)'),

  getThresholds:     db.prepare('SELECT tempMin, tempMax, humMin, humMax, soilMin, soilMax FROM thresholds WHERE user_id = ?'),
  upsertThresholds:  db.prepare(`
    INSERT INTO thresholds (user_id, tempMin, tempMax, humMin, humMax, soilMin, soilMax)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      tempMin = excluded.tempMin,
      tempMax = excluded.tempMax,
      humMin  = excluded.humMin,
      humMax  = excluded.humMax,
      soilMin = excluded.soilMin,
      soilMax = excluded.soilMax
  `),

  insertAlert:       db.prepare('INSERT INTO alerts (parameter, value, threshold, severity, message) VALUES (?, ?, ?, ?, ?)'),
  clearAlerts:       db.prepare('DELETE FROM alerts'),

  getAllUserIds:      db.prepare('SELECT id FROM users'),
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Create a new user account.
 * @param {string} name  - Display name
 * @param {string} email - Email address (must be unique)
 * @param {string} hashedPassword - Bcrypt-hashed password
 * @returns {{ id: number }} The new user's ID
 */
function createUser(name, email, hashedPassword) {
  const result = stmts.insertUser.run(name, email, hashedPassword);
  return { id: result.lastInsertRowid };
}

/**
 * Find a user by email address.
 * @param {string} email
 * @returns {object|undefined} The full user row, or undefined if not found
 */
function findUserByEmail(email) {
  return stmts.findUserByEmail.get(email);
}

/**
 * Get a user by ID (safe version – no password field returned).
 * @param {number} id
 * @returns {{ id: number, name: string, email: string }|undefined}
 */
function getUserById(id) {
  return stmts.getUserById.get(id);
}

/**
 * Get user with password for verification.
 * @param {number} id
 * @returns {object|undefined}
 */
function getUserWithPass(id) {
  return stmts.getUserWithPass.get(id);
}

/**
 * Update user password.
 * @param {number} id
 * @param {string} hashedPassword
 */
function updateUserPassword(id, hashedPassword) {
  stmts.updatePassword.run(hashedPassword, id);
}

/**
 * Save a sensor reading to the database.
 * @param {number} temp - Temperature in °C
 * @param {number} hum  - Humidity in %
 * @param {number} soil - Soil moisture in %
 */
function saveReading(temp, hum, soil) {
  stmts.insertReading.run(temp, hum, soil);
}

/**
 * Get historical readings filtered by time range or custom range.
 * @param {'1h'|'6h'|'24h'|'7d'|'custom'} range - Time window
 * @param {string} [start] - Optional ISO date
 * @param {string} [end] - Optional ISO date
 * @returns {Array<{ timestamp: string, temp: number, hum: number, soil: number }>}
 */
function getReadings(range, start, end) {
  if (range === 'custom' && start && end) {
    const stmt = db.prepare(
      `SELECT timestamp, temp, hum, soil
       FROM readings
       WHERE timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC`
    );
    return stmt.all(start, end);
  }

  // Map range strings to SQLite time modifiers
  const rangeMap = {
    '1h':  '-1 hour',
    '6h':  '-6 hours',
    '24h': '-24 hours',
    '7d':  '-7 days',
  };
  const modifier = rangeMap[range] || '-1 hour';

  const stmt = db.prepare(
    `SELECT timestamp, temp, hum, soil
     FROM readings
     WHERE timestamp >= datetime('now', ?)
     ORDER BY timestamp ASC`
  );
  return stmt.all(modifier);
}

/**
 * Get threshold settings for a specific user.
 * Returns defaults if the user hasn't customised them yet.
 * @param {number} userId
 * @returns {{ tempMin: number, tempMax: number, humMin: number, humMax: number, soilMin: number, soilMax: number }}
 */
function getThresholds(userId) {
  const row = stmts.getThresholds.get(userId);
  // Return defaults if no row exists yet
  return row || { tempMin: 15, tempMax: 35, humMin: 30, humMax: 80, soilMin: 30, soilMax: 70 };
}

/**
 * Create or update threshold settings for a user.
 * @param {number} userId
 * @param {{ tempMin: number, tempMax: number, humMin: number, humMax: number, soilMin: number, soilMax: number }} data
 */
function saveThresholds(userId, data) {
  stmts.upsertThresholds.run(
    userId,
    data.tempMin, data.tempMax,
    data.humMin, data.humMax,
    data.soilMin, data.soilMax
  );
}

/**
 * Save an alert event.
 * @param {{ parameter: string, value: number, threshold: number, severity: string, message: string }} alert
 * @returns {{ id: number }} The new alert's ID
 */
function saveAlert(alert) {
  const result = stmts.insertAlert.run(
    alert.parameter, alert.value, alert.threshold, alert.severity, alert.message
  );
  return { id: result.lastInsertRowid };
}

/**
 * Get recent alerts, newest first.
 * @param {number} [limit=100]
 * @returns {Array<{ id: number, timestamp: string, parameter: string, value: number, threshold: number, severity: string, message: string }>}
 */
function getAlerts(limit = 100) {
  const stmt = db.prepare(
    `SELECT id, timestamp, parameter, value, threshold, severity, message
     FROM alerts
     ORDER BY timestamp DESC
     LIMIT ?`
  );
  return stmt.all(limit);
}

/**
 * Delete all alerts.
 */
function clearAlerts() {
  stmts.clearAlerts.run();
}

/**
 * Get all user IDs (used to check thresholds for every registered user).
 * @returns {Array<{ id: number }>}
 */
function getAllUserIds() {
  return stmts.getAllUserIds.all();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  db,
  createUser,
  findUserByEmail,
  getUserById,
  getUserWithPass,
  updateUserPassword,
  saveReading,
  getReadings,
  getThresholds,
  saveThresholds,
  saveAlert,
  getAlerts,
  clearAlerts,
  getAllUserIds,
};
