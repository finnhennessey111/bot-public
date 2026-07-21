// models/MatchChannel.js - One document per scheduled-deletion match channel
// (channel-lifecycle.js), scoped per guild. `data` mirrors the record shape stored in
// store.js's `matchChannels` (textChannelId, voiceChannelId, kind, deleteAt, warned, ...).

const mongoose = require('mongoose');

const matchChannelSchema = new mongoose.Schema({
  textChannelId: { type: String, required: true, unique: true },
  guildId: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

module.exports = mongoose.models.MatchChannel || mongoose.model('MatchChannel', matchChannelSchema);
