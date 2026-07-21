// db.js - MongoDB connection via Mongoose. Connects on startup and logs success/failure so
// store.js knows whether to persist to MongoDB or fall back to the local JSON store.

const mongoose = require('mongoose');

let connected = false;

async function connect() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.warn('[MongoDB] MONGODB_URI not set — skipping connection.');
    connected = false;
    return false;
  }

  try {
    await mongoose.connect(uri);
    connected = true;
    console.log('[MongoDB] Connected successfully.');
    return true;
  } catch (err) {
    connected = false;
    console.error('[MongoDB] Connection failed:', err.message);
    return false;
  }
}

mongoose.connection.on('disconnected', () => {
  connected = false;
  console.warn('[MongoDB] Disconnected.');
});

mongoose.connection.on('error', (err) => {
  console.error('[MongoDB] Connection error:', err.message);
});

function isConnected() {
  return connected;
}

module.exports = { connect, isConnected, mongoose };
