// models/Queue.js - One document per guild holding the full tournament matchmaking queue
// blob (tournamentName -> region -> array of waiting units), mirroring store.js's `queues`
// shape. Kept as a single Mixed blob rather than normalized documents since the shape is
// still evolving alongside queue.js. `creativeData` mirrors store.js's `creativeQueues[guildId]`
// (mode -> region -> array of waiting units) — kept on the same per-guild doc rather than a
// separate collection since both are small, guild-scoped queue blobs.

const mongoose = require('mongoose');

const queueSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  creativeData: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

module.exports = mongoose.models.Queue || mongoose.model('Queue', queueSchema);
