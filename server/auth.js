/**
 * auth.js - Authentication Routes and JWT Middleware
 * 
 * Handles user signup, login, logout, and the "me" endpoint.
 * Uses bcryptjs for password hashing and jsonwebtoken for tokens.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createUser, findUserByEmail, getUserById, getUserWithPass, updateUserPassword, saveThresholds } = require('./db');

const router = express.Router();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const JWT_SECRET = process.env.JWT_SECRET || 'microclimate-super-secret-key-change-me';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';
const BCRYPT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// JWT Middleware – protects routes that require authentication
// ---------------------------------------------------------------------------

/**
 * Express middleware that verifies the JWT from the Authorization header.
 * On success it attaches `req.user` with { id, email }.
 */
function authenticateToken(req, res, next) {
  try {
    // The token can come as "Bearer <token>" in the Authorization header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // grab the part after "Bearer "

    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    // Verify the token signature and expiry
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, email, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /api/signup
 * Register a new user account.
 * Body: { name, email, password }
 */
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // ---- Input validation ----
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    // Simple email format check
    if (!email.includes('@') || !email.includes('.')) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    // ---- Check if email is already taken ----
    const existing = findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // ---- Hash the password ----
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // ---- Create the user ----
    const { id } = createUser(name, email, hashedPassword);

    // ---- Create default thresholds for the new user ----
    saveThresholds(id, {
      tempMin: 15, tempMax: 35,
      humMin: 30, humMax: 80,
      soilMin: 30, soilMax: 70,
    });

    // ---- Generate JWT ----
    const token = jwt.sign({ id, email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    res.status(201).json({
      success: true,
      token,
      user: { id, name, email },
    });
  } catch (err) {
    console.error('[Auth] Signup error:', err.message);
    res.status(500).json({ error: 'Internal server error during signup.' });
  }
});

/**
 * POST /api/login
 * Authenticate an existing user.
 * Body: { email, password }
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // ---- Input validation ----
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // ---- Find the user ----
    const user = findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // ---- Compare passwords ----
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // ---- Generate JWT ----
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    res.json({
      success: true,
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

/**
 * POST /api/logout
 * Client-side logout – just acknowledge success.
 * (JWT is stateless, so the client simply discards the token.)
 */
router.post('/logout', (_req, res) => {
  res.json({ success: true });
});

/**
 * GET /api/me
 * Return the currently authenticated user's info.
 * Requires authenticateToken middleware.
 */
router.get('/me', authenticateToken, (req, res) => {
  try {
    const user = getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ id: user.id, name: user.name, email: user.email, created_at: user.created_at });
  } catch (err) {
    console.error('[Auth] Me error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /api/change-password
 * Change password for current logged-in user.
 * Body: { currentPassword, newPassword }
 */
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const user = getUserWithPass(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.status(400).json({ error: 'Incorrect current password.' });
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    updateUserPassword(req.user.id, hashed);
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    console.error('[Auth] Change password error:', err.message);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  router,
  authenticateToken,
  JWT_SECRET,
};
