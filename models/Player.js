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
  // Lowercased mirror of epicUsername, kept in sync by players.js's upsertPlayer/linkEpicAccount —
  // exists purely so elo.js's public "check your ELO" lookup (players.js's
  // findCanonicalByEpicUsername) can do a fast, case-insensitive, INDEXED exact match instead of a
  // regex scan, which matters for an unauthenticated endpoint anyone could search repeatedly.
  epicUsernameLower: String,
  epicId: String,
  // True once this player has completed the Epic OAuth flow (epic-oauth.js) themselves. Gates
  // resolveEpicIdentity's Epic-OAuth path in index.js: without this flag, a stale epicId sitting
  // in this same field from some other source could otherwise be mistaken for a real OAuth link.
  epicOAuthLinked: { type: Boolean, default: false },
  epicLinkedAt: { type: Date, default: null },
  platform: String,
  region: String,
  extraRegions: { type: [String], default: [] },
  ingameRoles: { type: [String], default: [] },
  languages: { type: [String], default: [] },
  ageBracket: String,
  bio: String,
  totalPR: { type: Number, default: null },
  thisSeasonPR: { type: Number, default: null },
  prBand: String,
  recentEvents: { type: [recentEventSchema], default: [] },
  // Last time totalPR/thisSeasonPR/prBand/recentEvents were scraped from Fortnite Tracker —
  // drives both the recency-based queue-join cache TTL (players.js's getPlayerStats/
  // cacheTtlMsFor) and the 1h /refresh-stats cooldown (players.js's refreshPlayerStats). Null
  // until the player's first scrape. This is always this player's HOME region, default (all-
  // input) platform snapshot — the one every existing caller (findCanonicalByEpicUsername,
  // getAllScoredPlayers, elo.js, the profile embed) already assumes exists.
  lastUpdated: { type: Date, default: null },
  // Per-(region, platform-segment) PR snapshots, ADDITIONAL to the home-context fields above —
  // populated lazily, only for a context a player has actually queued under that genuinely
  // differs from their home context (players.js's getStatsForContext): a different region (#3 —
  // "use their PR for the region they're actually about to play in") and/or a different Fortnite
  // Tracker input segment for a Console player (#6 — gamepad for a console-exclusive tournament,
  // kbm otherwise). Never populated preemptively for every region/platform combo — only the one
  // context a real queue join actually needed. Keyed `${region}|${platformSegment}` (e.g.
  // "NAC|gamepad"). Same recency-based TTL logic as the home context (cacheTtlMsFor) applies to
  // each entry independently, keyed off that entry's own lastUpdated/recentEvents.
  statsByContext: {
    type: Map,
    of: new mongoose.Schema({
      totalPR: Number,
      thisSeasonPR: Number,
      prBand: String,
      recentEvents: { type: [recentEventSchema], default: [] },
      lastUpdated: Date,
    }, { _id: false }),
    default: {},
  },
  registeredAt: { type: Date, default: Date.now },
});

playerSchema.index({ discordId: 1, guildId: 1 }, { unique: true });
// Non-unique — the same real Epic account is legitimately registered under one Player doc PER
// guild it's used in (players.js's findCanonicalByEpicUsername resolves the multiple docs down to
// one canonical result via epicId).
playerSchema.index({ epicUsernameLower: 1 });
playerSchema.index({ epicId: 1 });

module.exports = mongoose.models.Player || mongoose.model('Player', playerSchema);
