// models/Guild.js - Per-guild configuration and persisted state (pinned tournament messages).
// channelIds/roleIds/categoryIds are free-form maps (e.g. { calendar: '123', mod: '456' })
// so new keys can be added without a schema migration as the multi-server rework lands.

const mongoose = require('mongoose');

const guildSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  roleIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  categoryIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  pinnedMessages: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.Guild || mongoose.model('Guild', guildSchema);
