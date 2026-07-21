// yunite.js - Yunite API integration for Discord ID → Epic ID lookup, per guild.
//
// Each server admin supplies their own Yunite API token during /matchmaker-setup (stored in
// that guild's Mongo config via guild-config.js) — Yunite scopes account links per Discord
// guild, and each server authorizes the MatchMaker app on Yunite's own dashboard independently.
// process.env.YUNITE_TOKEN is kept only as a fallback for guilds that haven't set their own
// (in practice, just this bot's own dev/test server).

const { getYuniteToken } = require('./guild-config');

const BASE_URL = 'https://yunite.xyz/api/v3';

async function getEpicFromDiscord(discordId, guildId) {
  const token = getYuniteToken(guildId) ?? process.env.YUNITE_TOKEN;
  if (!token) {
    throw new Error('No Yunite API token configured for this server — run /matchmaker-setup.');
  }

  const response = await fetch(`${BASE_URL}/guild/${guildId}/registration/links`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Y-Api-Token': token,
    },
    body: JSON.stringify({
      type: 'DISCORD',
      userIds: [discordId],
    }),
  });

  if (!response.ok) {
    throw new Error(`Yunite API error: ${response.status}`);
  }

  const data = await response.json();

  // Check if user was found and linked
  if (data.notFound?.includes(discordId)) {
    throw new Error('Discord account not found in Yunite.');
  }

  if (data.notLinked?.includes(discordId)) {
    throw new Error('You have not linked your Epic account. Please register in #register first.');
  }

  const user = data.users?.[0];
  if (!user) {
    throw new Error('Could not retrieve Epic account from Yunite.');
  }

  return {
    epicId: user.epic.epicID,
    epicName: user.epic.epicName,
    platform: user.chosenPlatform,
  };
}

// Lightweight reachability check for /bot-status — an empty userIds array still hits the real
// endpoint with this guild's real auth, so a non-ok response (bad/missing token, Yunite down,
// etc.) or a network exception both correctly report "not reachable" without needing a real
// linked Discord ID.
async function checkYuniteReachable(guildId) {
  const token = getYuniteToken(guildId) ?? process.env.YUNITE_TOKEN;
  if (!token) return false;

  try {
    const response = await fetch(`${BASE_URL}/guild/${guildId}/registration/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Y-Api-Token': token,
      },
      body: JSON.stringify({ type: 'DISCORD', userIds: [] }),
    });
    return response.ok;
  } catch (err) {
    return false;
  }
}

module.exports = { getEpicFromDiscord, checkYuniteReachable };
