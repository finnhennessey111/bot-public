// models/DeletedTournamentChannel.js - State for channel-deletion-undo.js's accidental-deletion
// flow. One doc per (guildId, eventId) — deliberately compound, NOT eventId alone: tournament-
// scraper.js's eventId is the same real-tournament identity across every guild running it (see
// channel-manager.js's findExistingTournamentChannel), but a mod deleting their server's copy of
// the channel must never suppress recreation in every OTHER unrelated server. Mirrors the exact
// same (guildId, tournamentEventId) match findExistingTournamentChannel already uses.
//
// status: 'pending_confirmation' (deleted, DM sent, awaiting the restore window) ->
// 'restored' (Restore clicked — channel recreated) | 'permanently_deleted' (window expired, or the
// audit log couldn't identify who deleted it — see channel-deletion-undo.js's doc comment for why
// that fails toward "stays deleted" rather than silently recreating).
//
// A later deletion of the same (guildId, eventId) — e.g. restored, then deleted again — upserts
// this same document back to 'pending_confirmation' with a fresh snapshot rather than erroring on
// the unique key, so the flow repeats cleanly instead of only ever working once per tournament.

const mongoose = require('mongoose');

const deletedTournamentChannelSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  eventId: { type: String, required: true },
  status: { type: String, enum: ['pending_confirmation', 'restored', 'permanently_deleted'], required: true },
  tournamentName: { type: String, required: true },
  region: { type: String, required: true },
  // Snapshot of the pinnedMessages[channelId] entry at the moment of deletion — the only place
  // this data still exists once the channel itself is gone. Mixed (not a fixed sub-schema) since
  // it just mirrors whatever shape channel-manager.js's pinnedMessages entries currently have, same
  // "still evolving" reasoning as models/TournamentApproval.js's `tournament` field.
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  // {id, tag} from the audit log, or null if the deleter couldn't be determined.
  deletedBy: { type: mongoose.Schema.Types.Mixed, default: null },
  deletedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  // The deleter's DM {channelId, messageId} — lets the expiry sweep edit it in place when the
  // window closes with no response, from outside any live interaction.
  dmChannelId: { type: String, default: null },
  dmMessageId: { type: String, default: null },
  decidedAt: { type: Date, default: null },
});

deletedTournamentChannelSchema.index({ guildId: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.models.DeletedTournamentChannel
  || mongoose.model('DeletedTournamentChannel', deletedTournamentChannelSchema);
