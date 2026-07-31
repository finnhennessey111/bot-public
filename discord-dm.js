// discord-dm.js - DMs an arbitrary Discord ID with no known guild context. Used by notifications.js
// (the global expiry sweep), webhook-server.js (payment-failed alerts), suggestions.js, and
// tournament-approval.js — none of these run inside a guild-scoped interaction, so index.js's
// existing dmPlayer helper (which resolves via guild.members.fetch) doesn't apply. Same
// try/catch/log shape, just via client.users.fetch. Returns the sent Message (or null on failure)
// — tournament-approval.js needs the message id to edit the DM in place later (on a decision, or
// on auto-expiry); every earlier caller just ignored the return value, so this is additive.
async function dmUser(client, discordId, payload) {
  try {
    const user = await client.users.fetch(discordId);
    return await user.send(payload);
  } catch (err) {
    console.error(`[dm] Could not DM ${discordId}:`, err.message);
    return null;
  }
}

module.exports = { dmUser };
