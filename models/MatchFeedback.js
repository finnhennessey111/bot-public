// models/MatchFeedback.js - Raw feedback capture for both creative and tournament matches, tied
// to a snapshot of each involved player's scoring inputs at match time, so it can be analyzed
// later to refine the matching algorithm. Data capture only — no aggregation/dashboard reads this
// collection yet (see feedback.js).
//
// Two very different capture triggers write here:
//   - creative (1v1/2v2 via creative-queue.js, 6s/8s via creative-team-queue.js/
//     team-match-lifecycle.js): one doc per FORMED match, written immediately with `players`
//     populated and `feedback` empty. Each involved player may later rate their own experience of
//     that match (feedback.js prompts this the next time they queue for the same mode) — `players`
//     can be 2 (1v1/2v2) or up to 8 (6s/8s), so `feedback` is an array keyed by discordId, not a
//     pair of named fields, to fit both shapes uniformly.
//   - tournament (matching.js's rejectMatch, via index.js): one doc per REJECTED proposal, written
//     at reject time (accepted tournament matches never get a doc — there's no "why did you like
//     it" loop for tournaments, only "why did you reject" is captured). `feedback` here will only
//     ever hold the single rejecting player's response.
//
// mode holds whichever label the match itself used to identify its queue — the creative mode
// string (e.g. "1v1 Realistics") for kind:'creative', or the tournament name for kind:'tournament'
// — mirroring matching.js's createMatch, which already threads creative's mode through its own
// generic `tournamentName` parameter slot.

const mongoose = require('mongoose');

const playerSnapshotSchema = new mongoose.Schema({
  discordId: { type: String, required: true },
  totalPR: Number,
  thisSeasonPR: Number,
  matchScore: Number,
  soloModifier: Number,
}, { _id: false });

const feedbackResponseSchema = new mongoose.Schema({
  discordId: { type: String, required: true },
  // creative only:
  rating: { type: String, enum: ['great', 'okay', 'not_great'], default: null },
  notGreatReason: { type: String, default: null },
  // tournament only:
  rejectReason: { type: String, default: null },
  respondedAt: { type: Date, default: Date.now },
}, { _id: false });

const matchFeedbackSchema = new mongoose.Schema({
  matchId: { type: String, required: true, unique: true },
  kind: { type: String, enum: ['creative', 'tournament'], required: true },
  mode: String,
  region: String,
  players: { type: [playerSnapshotSchema], default: [] },
  feedback: { type: [feedbackResponseSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});

// Feedback-eligibility lookup (feedback.js's getPendingCreativePrompt): "this player's most
// recent creative match in this mode" — sorted by createdAt descending, filtered by kind+mode and
// players.discordId.
matchFeedbackSchema.index({ kind: 1, mode: 1, 'players.discordId': 1, createdAt: -1 });

module.exports = mongoose.models.MatchFeedback || mongoose.model('MatchFeedback', matchFeedbackSchema);
