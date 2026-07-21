// models/Party.js - One document per pre-formed party (party.js), scoped per guild.

const mongoose = require('mongoose');

const partySchema = new mongoose.Schema({
  partyId: { type: String, required: true, unique: true },
  guildId: { type: String, required: true },
  leaderId: String,
  leaderUsername: String,
  members: { type: [mongoose.Schema.Types.Mixed], default: [] },
  channelId: String,
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.Party || mongoose.model('Party', partySchema);
