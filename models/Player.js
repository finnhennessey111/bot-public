// models/Player.js - A player's registered profile, scoped per guild.

const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  discordId: { type: String, required: true },
  guildId: { type: String, required: true },
  epicUsername: String,
  epicId: String,
  platform: String,
  region: String,
  extraRegions: { type: [String], default: [] },
  ingameRoles: { type: [String], default: [] },
  language: String,
  bio: String,
  totalPR: { type: Number, default: null },
  thisSeasonPR: { type: Number, default: null },
  prBand: String,
  registeredAt: { type: Date, default: Date.now },
});

playerSchema.index({ discordId: 1, guildId: 1 }, { unique: true });

module.exports = mongoose.models.Player || mongoose.model('Player', playerSchema);
