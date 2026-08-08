// models/Guild.js - Per-guild configuration and persisted state (pinned tournament messages).
// channelIds/roleIds/categoryIds are free-form maps (e.g. { calendar: '123', mod: '456' })
// so new keys can be added without a schema migration as the multi-server rework lands.
// categoryIds.match holds the shared "Matches" category (formerly store.js's flat
// settings.matchCategoryId). creativeChannels mirrors the old store.js field, scoped per guild:
// { '1v1': {channelId, messageId}, '2v2': {...} }. setupMessageIds tracks the message IDs
// /matchmaker-setup posts (register/getRoles) so re-running it is idempotent.
// secrets holds per-guild third-party credentials (currently unused, reserved for future
// integrations) — plaintext, consistent with this project's existing .env-based token handling.

const mongoose = require('mongoose');

const guildSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  roleIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  categoryIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Forum tag IDs from an earlier tournament-forum design (one shared "tournaments" forum, region
  // expressed as an applied tag: EU/NAC/ME). Superseded by 9 separate region×build-mode forums
  // (channelIds.tournamentForum_{region}_{buildMode} — see matchmaker-setup.js's
  // TOURNAMENT_FORUM_SPECS), which no longer use tags at all. Left in place, unused by any current
  // code path, rather than deleted — a guild that has this populated still has a real, working
  // shared forum in Discord with real posts inside it; nothing here migrates or removes those, see
  // guild-config.js's GUILD_CONFIG_MIGRATIONS doc comment for the full non-destructive rationale.
  tagIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  pinnedMessages: { type: mongoose.Schema.Types.Mixed, default: {} },
  creativeChannels: { type: mongoose.Schema.Types.Mixed, default: {} },
  setupMessageIds: { type: mongoose.Schema.Types.Mixed, default: {} },
  secrets: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.Guild || mongoose.model('Guild', guildSchema);
