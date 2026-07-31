// models/TournamentApproval.js - Manual-approval gate state for tournament-approval.js. One doc
// per Fortnite Tracker eventId (the same stable per-region-tournament identity channel-manager.js
// already uses for dedup/rename) — global, not per-guild, since the gate decides once and applies
// across every server the bot is in, same shape as the shared scrape it gates.
//
// status: 'pending' (DMed, awaiting a decision) -> 'approved' | 'rejected' | 'expired' (the
// tournament's own start time passed with nobody deciding — see expirePendingApprovals' doc
// comment for why this doesn't auto-approve instead).

const mongoose = require('mongoose');

const tournamentApprovalSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'expired'], required: true },
  // Snapshot of the tournament-scraper.js group object at the moment it was first seen — name,
  // region, beginTime, lastBeginTime, isTrios, consoleOnly, isPermanent, isRankedCup, eventId.
  // Mixed (not a fixed sub-schema) since this just mirrors whatever shape tournament-scraper.js's
  // buildTournamentGroups produces, same "still evolving" reasoning as models/Queue.js.
  tournament: { type: mongoose.Schema.Types.Mixed, required: true },
  // The owner DM's {channelId, messageId} — lets expirePendingApprovals edit the DM in place when
  // a pending tournament's start time passes with no decision, from outside any live interaction.
  dmChannelId: { type: String, default: null },
  dmMessageId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  decidedAt: { type: Date, default: null },
});

module.exports = mongoose.models.TournamentApproval || mongoose.model('TournamentApproval', tournamentApprovalSchema);
