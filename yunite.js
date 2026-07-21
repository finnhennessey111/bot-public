// yunite.js - Yunite API integration for Discord ID → Epic ID lookup

const YUNITE_TOKEN = process.env.YUNITE_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const BASE_URL = 'https://yunite.xyz/api/v3';

async function getEpicFromDiscord(discordId) {
  const response = await fetch(`${BASE_URL}/guild/${GUILD_ID}/registration/links`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Y-Api-Token': YUNITE_TOKEN,
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

module.exports = { getEpicFromDiscord };