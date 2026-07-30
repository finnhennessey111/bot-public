// models/PendingMatch.js - One document per pending match awaiting accept/reject (matching.js).
// Exists specifically so an in-flight accept/reject window survives a restart instead of being
// silently wiped, orphaning the private channel already created for it (match-channels.js creates
// the channel immediately when a match is found, well before this record would otherwise ever
// reach channel-lifecycle.js's durable matchChannels — that only happens once everyone accepts).
// `data` mirrors matching.js's toPersistableRecord(match) shape (matchId, unitA, unitB,
// tournamentName, region, kind, expiryMs, createdAt, acceptedBy as an array, channelsByGuildId as
// an array of [guildId, {channelId, messageId}] pairs) — matching.js's own in-memory pendingMatches
// keeps the richer live shape (Set/Map/a live requeueFn callback); only the plain, JSON-safe
// snapshot ever crosses this boundary.

const mongoose = require('mongoose');

const pendingMatchSchema = new mongoose.Schema({
  matchId: { type: String, required: true, unique: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

module.exports = mongoose.models.PendingMatch || mongoose.model('PendingMatch', pendingMatchSchema);
