// models/Queue.js - Single global document holding the full tournament matchmaking queue blob
// (tournamentName -> region -> array of waiting units), mirroring store.js's `queues` shape. The
// queue pool is shared across every installed guild (cross-server matchmaking), so this is keyed
// by a constant guildId ('__global__', see store.js), not a real guild. Kept as a single Mixed
// blob rather than normalized documents since the shape is still evolving alongside queue.js.
// `creativeData` mirrors store.js's `creativeQueues` (mode -> region -> array of waiting units) —
// kept on the same doc rather than a separate collection since both are small queue blobs.

const mongoose = require('mongoose');

const queueSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  creativeData: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

module.exports = mongoose.models.Queue || mongoose.model('Queue', queueSchema);
