// discord-dm.js - DMs an arbitrary Discord ID with no known guild context. Used by notifications.js
// (the global expiry sweep) and webhook-server.js (payment-failed alerts) — neither runs inside a
// guild-scoped interaction, so index.js's existing dmPlayer helper (which resolves via
// guild.members.fetch) doesn't apply. Same try/catch/log shape, just via client.users.fetch.
async function dmUser(client, discordId, payload) {
  try {
    const user = await client.users.fetch(discordId);
    await user.send(payload);
  } catch (err) {
    console.error(`[dm] Could not DM ${discordId}:`, err.message);
  }
}

module.exports = { dmUser };
