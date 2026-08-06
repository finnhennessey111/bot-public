// models/TierBandStats.js - One document per real-PR band, holding the aggregate behavioral
// statistics tier-comparison.js's daily batch job computes from real registered players currently
// in that band. This collection is always fully DERIVED (never incrementally maintained) — every
// run of runDailyTierBandComputation replaces its entire contents from a fresh read of real player
// data, so a band with zero currently-qualifying players simply has no document here at all, rather
// than a stale one lingering with an outdated playerCount. See tier-comparison.js's doc comment for
// the full system this feeds.

const mongoose = require('mongoose');

const tierBandStatsSchema = new mongoose.Schema({
  // Inclusive lower bound of this band's PR range; bandMax (= bandMin + BAND_WIDTH_PR, exclusive)
  // is stored too purely for readability/debugging — tier-comparison.js's own BAND_WIDTH_PR
  // constant is what everything actually derives boundaries from, this is never recomputed FROM
  // bandMax at read time.
  bandMin: { type: Number, required: true },
  bandMax: { type: Number, required: true },
  // How many real, distinct (deduped by epicId — same rule players.js's getAllScoredPlayers already
  // applies everywhere else) players actually CONTRIBUTED to the averages below — i.e. had at least
  // MIN_EVENTS_FOR_TIER_SIGNAL qualifying events of their own. NOT a raw count of every player whose
  // totalPR happens to fall in this range — a player with too little history to compute their own
  // trend/consistency from contributes nothing here and isn't counted, since counting them would
  // make an underpopulated band look more statistically valid than it actually is. This is exactly
  // the field getTierComparisonModifier's MIN_BAND_PLAYERS gate checks.
  playerCount: { type: Number, required: true },
  // Mean of each contributing player's own window-average decayed PR (tier-comparison.js's
  // computeWindowStats#avgLevel) — "typical recent performance level" for this band.
  avgLevel: { type: Number, default: null },
  // Mean of each contributing player's own OLS trend slope — "typical trajectory" for this band.
  avgTrend: { type: Number, default: null },
  // Mean of each contributing player's own coefficient-of-variation consistency measure — "typical
  // reliability" for this band. null when no contributing player had a normalizable (non-zero
  // average level) consistency value.
  avgConsistency: { type: Number, default: null },
  computedAt: { type: Date, default: Date.now },
});

tierBandStatsSchema.index({ bandMin: 1 }, { unique: true });

module.exports = mongoose.models.TierBandStats || mongoose.model('TierBandStats', tierBandStatsSchema);
