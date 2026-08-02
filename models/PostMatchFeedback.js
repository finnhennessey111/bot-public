// models/PostMatchFeedback.js - Post-match outcome/difficulty survey for CREATIVE matches only
// (kind 'creative-pairwise' — 1v1/2v2 — or 'creative-team' — 6s/8s; channel-lifecycle.js's own
// kind values. Tournament matches never get a doc here at all). Separate collection from
// models/MatchFeedback.js's existing creative rating system on purpose — different trigger point
// (this prompts immediately once the match concludes, that one waits for the player's next queue
// join) and different questions (win/loss + difficulty-for-skill-level here, vs. a great/okay/
// not-great rating there).
//
// CRITICAL DESIGN CONSTRAINT: this collection is pure data capture for later manual review. A
// player's own answer here must NEVER feed back into their own score/matching in any way — doing
// so would incentivize a player to lie about difficulty specifically to game their own future
// matches. No code anywhere in this codebase reads `responses` to compute a score, a modifier, or
// anything else scoring-related — see post-match-feedback.js's doc comment and
// test/post-match-feedback.test.js, which asserts this directly against the real scoring code.

const mongoose = require('mongoose');

const responseSchema = new mongoose.Schema({
  discordId: { type: String, required: true },
  outcome: { type: String, enum: ['win', 'loss'], required: true },
  difficulty: { type: String, enum: ['too_easy', 'fair', 'too_hard'], required: true },
  respondedAt: { type: Date, default: Date.now },
}, { _id: false });

const playerRefSchema = new mongoose.Schema({
  discordId: { type: String, required: true },
}, { _id: false });

const postMatchFeedbackSchema = new mongoose.Schema({
  matchId: { type: String, required: true, unique: true },
  // 'creative-pairwise' | 'creative-team' — mirrors channel-lifecycle.js's scheduleChannelDeletion
  // kind values exactly, so the same string that gates which matches get a deletion timer here
  // also gates which ones get a survey, with no separate classification logic to drift out of sync.
  kind: { type: String, required: true },
  mode: String,
  region: String,
  // Snapshotted at match-formation time (post-match-feedback.js's recordMatchParticipants) — who
  // to prompt once the match concludes. Deliberately just discordId, no scoring fields at all
  // (unlike models/MatchFeedback.js's playerSnapshotSchema) — this collection has no legitimate
  // reason to ever touch a player's score inputs.
  players: { type: [playerRefSchema], default: [] },
  // Guards against double-DMing: the explicit "Close Channel" button cancels the auto-delete
  // timer before running its own deletion, so in practice only one of those two conclusion paths
  // ever fires per match — but this makes that guarantee explicit and restart-safe (post-match-
  // feedback.js's sendPromptsIfNeeded does an atomic findOneAndUpdate on this field) rather than
  // relying on it.
  prompted: { type: Boolean, default: false },
  responses: { type: [responseSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});

postMatchFeedbackSchema.index({ matchId: 1 });

module.exports = mongoose.models.PostMatchFeedback || mongoose.model('PostMatchFeedback', postMatchFeedbackSchema);
