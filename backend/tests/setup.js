/**
 * Test Setup
 * Location: backend/tests/setup.js
 * Purpose: Global test configuration
 */

// Set test environment
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key-for-jwt-tokens';
process.env.DB_NAME = process.env.DB_NAME || 'hairvelous_test';

// Mock console methods in tests to reduce noise
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

afterAll(async () => {
  try {
    const pool = require('../config/db');
    await pool.end();
  } catch (_err) {
    // Ignore teardown failures in tests.
  }
});
