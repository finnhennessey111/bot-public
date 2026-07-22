// models/MatchChannel.js - One document per scheduled-deletion match channel *group*
// (channel-lifecycle.js). A group is one or more channels tied to a single match — one text(+voice)
// pair per guild involved, for cross-server matches. `guildIds` lists every guild the group touches
// (used to scope Mongo sync), `data` mirrors the record shape stored in store.js's `matchChannels`
// (groupId, channels: [{guildId, textChannelId, voiceChannelId}], kind, deleteAt, warned, ...).

const mongoose = require('mongoose');

const matchChannelSchema = new mongoose.Schema({
  groupId: { type: String, required: true, unique: true },
  guildIds: { type: [String], default: [] },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

module.exports = mongoose.models.MatchChannel || mongoose.model('MatchChannel', matchChannelSchema);
