// changelog.js - Global "Recent Updates" changelog (models/Changelog.js) shown in every guild's
// persistent #setup embed. One shared collection, not per-guild — every server sees the same
// feed. postUpdate is owner-only (gated at the call site — index.js's /post-update command checks
// BOT_OWNER_DISCORD_ID before ever calling this); this module itself does no auth, same division
// of responsibility as feedback.js (capture logic here, gating at the interaction handler).

const ChangelogModel = require('./models/Changelog');

const MAX_ENTRIES = 5;

async function postUpdate(text, postedBy) {
  await ChangelogModel.create({ text, postedBy });
}

// Newest first, capped at MAX_ENTRIES — older entries stay in Mongo (never deleted), just not
// shown. Returns [] (not a throw) on failure, same non-fatal-read philosophy as this bot's other
// display-only Mongo reads — a changelog fetch failing should never block #setup from posting.
async function getRecentEntries() {
  try {
    return await ChangelogModel.find({}).sort({ createdAt: -1 }).limit(MAX_ENTRIES).lean();
  } catch (err) {
    console.error('[changelog] Failed to fetch recent entries:', err.message);
    return [];
  }
}

module.exports = { postUpdate, getRecentEntries };
