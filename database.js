// database.js - In-memory store for registered users and their profiles

const users = {};

function registerUser(discordId, epicUsername, platform) {
  users[discordId] = {
    discordId,
    epicUsername,
    platform,
    region: null,
    extraRegions: [],
    roles: [],
    language: null,
    bio: null,
    totalPR: null,
    thisSeasonPR: null,
    prBand: null,
    registeredAt: new Date(),
  };
}

function getUser(discordId) {
  return users[discordId] ?? null;
}

function updateUser(discordId, fields) {
  if (!users[discordId]) return false;
  Object.assign(users[discordId], fields);
  return true;
}

function isRegistered(discordId) {
  return !!users[discordId];
}

module.exports = { registerUser, getUser, updateUser, isRegistered };