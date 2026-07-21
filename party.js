// party.js - Pre-forming parties (up to 5 members) ahead of trios or 6s/8s creative queueing,
// scoped per guild.

const { parties, save } = require('./store');

const MAX_PARTY_SIZE = 5;

// Pending invites structure (ephemeral, not persisted — short-lived like matching.js's pendingMatches):
// pendingInvites[inviteId] = { inviteId, leaderId, leaderUsername, invitedId, invitedUsername, channelId, guildId, createdAt }
const pendingInvites = {};

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function getPartyByDiscordId(guildId, discordId) {
  for (const party of Object.values(parties)) {
    if (party.guildId !== guildId) continue;
    // Tolerate a pre-refactor party record shape (memberId/memberUsername instead of a
    // members array) rather than crashing the whole lookup on one malformed entry.
    if (party.members?.some(m => m.discordId === discordId)) return party;
  }
  return null;
}

function isInParty(guildId, discordId) {
  return !!getPartyByDiscordId(guildId, discordId);
}

// Full member list (including the leader) if in a party, or null if solo — callers build their
// own single-person pseudo-list for the solo case since that needs a Discord username they
// already have on hand (e.g. from `interaction.user`).
function getPartyMembers(guildId, discordId) {
  const party = getPartyByDiscordId(guildId, discordId);
  return party ? party.members : null;
}

function getPartySize(guildId, discordId) {
  const party = getPartyByDiscordId(guildId, discordId);
  return party ? party.members.length : 1;
}

// Whether this leader (or prospective solo leader) has room for one more member.
function canAddMember(guildId, leaderId) {
  return getPartySize(guildId, leaderId) < MAX_PARTY_SIZE;
}

function getPendingInviteByDiscordId(guildId, discordId) {
  for (const invite of Object.values(pendingInvites)) {
    if (invite.guildId !== guildId) continue;
    if (invite.leaderId === discordId || invite.invitedId === discordId) return invite;
  }
  return null;
}

function hasPendingInvite(guildId, discordId) {
  return !!getPendingInviteByDiscordId(guildId, discordId);
}

function createInvite({ leaderId, leaderUsername, invitedId, invitedUsername, channelId, guildId }) {
  const inviteId = generateId('invite');
  pendingInvites[inviteId] = {
    inviteId,
    leaderId,
    leaderUsername,
    invitedId,
    invitedUsername,
    channelId,
    guildId,
    createdAt: new Date(),
  };
  return inviteId;
}

function getInvite(inviteId) {
  return pendingInvites[inviteId] ?? null;
}

function expireInvite(inviteId) {
  const invite = pendingInvites[inviteId];
  if (!invite) return null;
  delete pendingInvites[inviteId];
  return invite;
}

function declineInvite(inviteId) {
  const invite = pendingInvites[inviteId];
  if (!invite) return null;
  delete pendingInvites[inviteId];
  return invite;
}

// Appends to the leader's existing party if they already have one (growing it toward the
// 5-member cap), otherwise creates a fresh 2-member party — same accept flow either way.
function acceptInvite(inviteId) {
  const invite = pendingInvites[inviteId];
  if (!invite) return null;
  delete pendingInvites[inviteId];

  const existing = getPartyByDiscordId(invite.guildId, invite.leaderId);
  if (existing) {
    existing.members.push({ discordId: invite.invitedId, username: invite.invitedUsername });
    save(invite.guildId);
    return existing;
  }

  const partyId = generateId('party');
  parties[partyId] = {
    partyId,
    leaderId: invite.leaderId,
    leaderUsername: invite.leaderUsername,
    members: [
      { discordId: invite.leaderId, username: invite.leaderUsername },
      { discordId: invite.invitedId, username: invite.invitedUsername },
    ],
    channelId: invite.channelId,
    guildId: invite.guildId,
    createdAt: new Date(),
  };
  save(invite.guildId);
  return parties[partyId];
}

function disbandParty(partyId) {
  const party = parties[partyId];
  if (!party) return null;
  delete parties[partyId];
  save(party.guildId);
  return party;
}

function disbandPartyByDiscordId(guildId, discordId) {
  const party = getPartyByDiscordId(guildId, discordId);
  if (!party) return null;
  return disbandParty(party.partyId);
}

module.exports = {
  MAX_PARTY_SIZE,
  isInParty,
  getPartyByDiscordId,
  getPartyMembers,
  getPartySize,
  canAddMember,
  hasPendingInvite,
  getPendingInviteByDiscordId,
  createInvite,
  getInvite,
  expireInvite,
  declineInvite,
  acceptInvite,
  disbandParty,
  disbandPartyByDiscordId,
};
