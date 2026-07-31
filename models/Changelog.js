// models/Changelog.js - Global "Recent Updates" changelog shown in every guild's persistent
// #setup embed (embeds.js's buildSetupInstructionsEmbed). One shared collection, NOT per-guild —
// every server sees the same feed. Entries are only ever appended (via /post-update, owner-only —
// see changelog.js), never edited/deleted; the last ~5 are read back out for display.

const mongoose = require('mongoose');

const changelogSchema = new mongoose.Schema({
  text: { type: String, required: true },
  postedBy: { type: String, required: true }, // Discord ID of whoever posted it (BOT_OWNER_DISCORD_ID)
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.Changelog || mongoose.model('Changelog', changelogSchema);
