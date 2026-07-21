// players.js - Guild-scoped player profile storage via models/Player.js. Replaces the old
// database.js, which was a pure in-memory, non-guild-scoped registry whose registerUser() was
// never called and whose updateUser() silently no-op'd on any player who'd never been
// "registered" first — every select-menu-driven profile update was effectively lost. upsertPlayer
// here always creates-or-updates in one atomic call, so that bug can't recur.

const PlayerModel = require('./models/Player');

async function getPlayer(guildId, discordId) {
  return PlayerModel.findOne({ guildId, discordId }).lean();
}

async function upsertPlayer(guildId, discordId, fields) {
  return PlayerModel.findOneAndUpdate(
    { guildId, discordId },
    { $set: fields, $setOnInsert: { guildId, discordId, registeredAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  ).lean();
}

async function isRegisteredPlayer(guildId, discordId) {
  return !!(await getPlayer(guildId, discordId));
}

module.exports = { getPlayer, upsertPlayer, isRegisteredPlayer };
