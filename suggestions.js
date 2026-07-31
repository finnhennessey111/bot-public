// suggestions.js - Centralized suggest-a-feature capture. The bot runs across many servers, so
// suggestions need to reach the developer centrally instead of scattering across dozens of
// separate servers' channels — every submission (index.js's suggestion_modal handler, from the
// #suggestions channel's button+modal — see matchmaker-setup.js's CHANNEL_SPECS) is stored here
// AND forwarded live via a DM to BOT_OWNER_DISCORD_ID (discord-dm.js's existing dmUser helper —
// no prior owner-DM pattern existed in this bot, so this establishes it; the DM path exists so
// this same BOT_OWNER_DISCORD_ID/dmUser combination is what any future admin-facing alert should
// reuse too). Storage and delivery are independent — a DM failure (owner not sharing a server with
// the bot, DMs closed, etc.) never loses the submission, it's already in Mongo by that point.

const SuggestionModel = require('./models/Suggestion');
const { dmUser } = require('./discord-dm');

const BOT_OWNER_DISCORD_ID = process.env.BOT_OWNER_DISCORD_ID || null;

async function recordSuggestion({ guildId, guildName, discordId, discordTag, text }) {
  return SuggestionModel.create({ guildId, guildName, discordId, discordTag, text });
}

async function forwardSuggestionToOwner(client, { guildName, discordId, discordTag, text }) {
  if (!BOT_OWNER_DISCORD_ID) {
    console.warn('[suggestions] BOT_OWNER_DISCORD_ID not set — suggestion stored but not DMed to anyone.');
    return;
  }

  await dmUser(client, BOT_OWNER_DISCORD_ID, {
    embeds: [{
      title: '💡 New Suggestion',
      description: text,
      color: 0x4A90D9,
      fields: [
        { name: 'From', value: `${discordTag} (${discordId})`, inline: true },
        { name: 'Server', value: guildName, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

module.exports = { recordSuggestion, forwardSuggestionToOwner, BOT_OWNER_DISCORD_ID };
