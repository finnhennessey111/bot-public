// team-invite.js - Pre-queue team forming for the 6s/8s creative team queue, entirely inline in
// the 6s/8s channel itself (replaces the old standalone #form-party channel + party.js). A leader
// picks how many teammates they're bringing, invites exactly that many via a Discord User Select,
// and the group queues as one unit once ready (full or still open to backfill via
// creative-team-queue.js's existing partial-fill matching).
//
// In-memory only (not persisted) — same ephemeral precedent as the old party.js's pendingInvites
// and creative-team-queue.js's formingMatches: this is pre-queue transient state, gone on
// restart, same as an in-progress (but not yet accepted) invite always was.
//
// Shape, deliberately close to the old party.js's:
//   pendingTeams[`${guildId}:${leaderId}`] = {
//     guildId, leaderId, leaderUsername, category, mode, region, bringCount,
//     members: [{ discordId, username }], // leader is always members[0]
//     createdAt,
//   }
//   pendingInvites[inviteId] = { inviteId, guildId, leaderId, invitedId, invitedUsername, createdAt }
//
// Invite expiry (5 min, same value the old party.js used) is scheduled by the caller (index.js),
// not here — same division of responsibility the old party.js used: this module only mutates
// state; whoever calls it owns the setTimeout and any message cleanup that follows.

const pendingTeams = {};
const pendingInvites = {};

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function teamKey(guildId, leaderId) {
  return `${guildId}:${leaderId}`;
}

function getPendingTeam(guildId, leaderId) {
  return pendingTeams[teamKey(guildId, leaderId)] ?? null;
}

// Whether discordId is already an accepted member of some forming team in this guild (leader or
// invited-and-accepted) — guards against joining/being invited into two forming teams at once.
function getPendingTeamByMember(guildId, discordId) {
  for (const team of Object.values(pendingTeams)) {
    if (team.guildId !== guildId) continue;
    if (team.members.some(m => m.discordId === discordId)) return team;
  }
  return null;
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

// Invites currently out for this team, as an array of { inviteId, invitedId, invitedUsername }.
function pendingInvitesForTeam(team) {
  return Object.values(pendingInvites).filter(inv => inv.guildId === team.guildId && inv.leaderId === team.leaderId);
}

// Overwrites any previous forming attempt by this leader — callers should check
// getPendingTeam first and route to Edit Team instead if one's already in progress; this is the
// low-level "start fresh" primitive.
function startForming({ guildId, leaderId, leaderUsername, category, mode, region, bringCount }) {
  const team = {
    guildId,
    leaderId,
    leaderUsername,
    category,
    mode,
    region,
    bringCount,
    members: [{ discordId: leaderId, username: leaderUsername }],
    createdAt: new Date(),
  };
  pendingTeams[teamKey(guildId, leaderId)] = team;
  return team;
}

function createInvite({ guildId, leaderId, invitedId, invitedUsername }) {
  const inviteId = generateId('tinvite');
  pendingInvites[inviteId] = {
    inviteId, guildId, leaderId, invitedId, invitedUsername, createdAt: new Date(),
  };
  return inviteId;
}

// Sends one invite per user not already a member or already invited — returns the created invite
// records (for the caller to post messages for) and any users skipped (already on the team).
function inviteMembers(team, users) {
  const created = [];
  const skipped = [];

  for (const user of users) {
    if (team.members.some(m => m.discordId === user.discordId)) {
      skipped.push(user);
      continue;
    }
    if (pendingInvitesForTeam(team).some(inv => inv.invitedId === user.discordId)) {
      skipped.push(user);
      continue;
    }
    const inviteId = createInvite({
      guildId: team.guildId, leaderId: team.leaderId, invitedId: user.discordId, invitedUsername: user.username,
    });
    created.push(pendingInvites[inviteId]);
  }

  return { created, skipped };
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

// Returns null if the team this invite belonged to no longer exists (leader already queued or
// cancelled while the invite was outstanding) — caller should tell the accepter it's too late.
function acceptInvite(inviteId) {
  const invite = pendingInvites[inviteId];
  if (!invite) return null;
  delete pendingInvites[inviteId];

  const team = getPendingTeam(invite.guildId, invite.leaderId);
  if (!team) return null;

  team.members.push({ discordId: invite.invitedId, username: invite.invitedUsername });
  return { team, invite };
}

// Reconciles a team's target roster against a fresh exact-count User Select submission (the "Edit
// Team" flow): members no longer selected are dropped, pending invites no longer selected are
// cancelled, and newly-selected users (not already a member or already invited) get fresh
// invites. newTargetUsers is the full resolved user list from the select ({discordId, username}),
// always exactly team.bringCount long. Returns the diff so the caller can update messages.
function editTeam(team, newTargetUsers) {
  const newTargetIds = new Set(newTargetUsers.map(u => u.discordId));

  const removedMembers = team.members.filter(m => m.discordId !== team.leaderId && !newTargetIds.has(m.discordId));
  team.members = team.members.filter(m => m.discordId === team.leaderId || newTargetIds.has(m.discordId));

  const cancelledInvites = [];
  for (const invite of pendingInvitesForTeam(team)) {
    if (!newTargetIds.has(invite.invitedId)) {
      delete pendingInvites[invite.inviteId];
      cancelledInvites.push(invite);
    }
  }

  const alreadyOnTeamIds = new Set(team.members.map(m => m.discordId));
  const alreadyInvitedIds = new Set(pendingInvitesForTeam(team).map(inv => inv.invitedId));
  const usersToInvite = newTargetUsers.filter(u => !alreadyOnTeamIds.has(u.discordId) && !alreadyInvitedIds.has(u.discordId));
  const { created: newInvites } = inviteMembers(team, usersToInvite);

  return { removedMembers, cancelledInvites, newInvites };
}

// Locks in whoever has accepted so far (leader + accepted members) and tears down the forming
// record — cancels any invites still outstanding (they're moot once the team has queued) so the
// caller can mark those invite messages as expired/cancelled. Returns null if there was nothing
// to finalize (e.g. already finalized by a duplicate click).
function finalizeForming(guildId, leaderId) {
  const team = getPendingTeam(guildId, leaderId);
  if (!team) return null;

  const cancelledInvites = pendingInvitesForTeam(team);
  for (const invite of cancelledInvites) delete pendingInvites[invite.inviteId];

  delete pendingTeams[teamKey(guildId, leaderId)];
  return { team, cancelledInvites };
}

module.exports = {
  getPendingTeam,
  getPendingTeamByMember,
  getPendingInviteByDiscordId,
  hasPendingInvite,
  pendingInvitesForTeam,
  startForming,
  inviteMembers,
  getInvite,
  expireInvite,
  declineInvite,
  acceptInvite,
  editTeam,
  finalizeForming,
};
