// models/Guild.js - Per-guild configuration and persisted state (pinned tournament messages).
// channelIds/roleIds/categoryIds are free-form maps (e.g. { calendar: '123', mod: '456' })
// so new keys can be added without a schema migration as the multi-server rework lands.
// categoryIds.match holds the shared "Matches" category (formerly store.js's flat
// settings.matchCategoryId). creativeChannels mirrors the old store.js field, scoped per guild:
// { '1v1': {channelId, messageId}, '2v2': {...} }. setupMessageIds tracks the message IDs
// /matchmaker-setup posts (register/getRoles/howto) so re-running it is idempotent.
// secrets holds per-guild third-party credentials (currently unused, reserved for future
// integrations) — plaintext, consistent with this project's existing .env-based token handling.

const mongoose = require('mongoose');

const guildSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  roleIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  categoryIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Forum tag IDs — parallel to categoryIds, but for the forum-post-based tournament channels
  // (channelIds.tournamentForum holds the forum channel itself). Region used to be expressed by
  // which category a tournament's text channel lived in; a forum post can't be parented into a
  // per-region category the same way (one shared forum holds every region's posts), so region is
  // instead an applied TAG on the post — tagIds.EU/NAC/ME hold that forum's tag IDs for this guild.
  tagIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  pinnedMessages: { type: mongoose.Schema.Types.Mixed, default: {} },
  creativeChannels: { type: mongoose.Schema.Types.Mixed, default: {} },
  setupMessageIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  secrets: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.Guild || mongoose.model('Guild', guildSchema);
