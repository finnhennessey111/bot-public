// models/Player.js - A player's registered profile, scoped per guild.

const mongoose = require('mongoose');

// Mirrors scraper.js's parseProfileData() event shape — stored so a cached read never needs to
// re-scrape just to show a player's recent tournament history. { _id: false } since these are
// always read/written as a whole array (upsertPlayer's $set), never addressed by their own id.
const recentEventSchema = new mongoose.Schema({
  name: String,
  date: String,
  placement: Number,
  prPoints: Number,
  rosterSize: Number,
  matches: Number,
  wins: Number,
  elims: Number,
  kd: Number,
}, { _id: false });

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
  recentEvents: { type: [recentEventSchema], default: [] },
  // Last time totalPR/thisSeasonPR/prBand/recentEvents were scraped from Fortnite Tracker —
  // drives both the 24h queue-join cache (players.js's getPlayerStats) and the 1h /refresh-stats
  // cooldown (players.js's refreshPlayerStats). Null until the player's first scrape.
  lastUpdated: { type: Date, default: null },
  registeredAt: { type: Date, default: Date.now },
});

playerSchema.index({ discordId: 1, guildId: 1 }, { unique: true });

module.exports = mongoose.models.Player || mongoose.model('Player', playerSchema);
