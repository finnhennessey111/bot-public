// matching.js - Handles pending match proposals and accept/reject logic for 2- or 3-player
// matches, scoped per guild.

const { requeueUnit } = require('./queue');

// Pending matches structure:
// pendingMatches[matchId] = {
//   matchId, guildId, unitA, unitB,
//   players: [...unitA.members, ...unitB.members],  // 2 for duo, 3 for trios (party + solo)
//   tournamentName, region, acceptedBy: Set, createdAt, requeueFn, kind,
// }
const pendingMatches = {};

function generateMatchId() {
  return `match_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// requeueFn lets non-tournament callers (e.g. the creative queue) plug in their own queue's
// requeue logic on reject/expiry instead of the tournament queue.js default. `kind` tags the
// match so the confirm-flow (private channel creation etc.) can branch on it later. guildId is
// derived from unitA (every unit carries its own guildId since queue.js/creative-queue.js's
// rework) rather than taken as a separate parameter.
function createMatch(unitA, unitB, tournamentName, region, {
  requeueFn = requeueUnit, kind = 'tournament', expiryMs = 5 * 60 * 1000,
} = {}) {
  const matchId = generateMatchId();

  pendingMatches[matchId] = {
    matchId,
    guildId: unitA.guildId,
    unitA,
    unitB,
    players: [...unitA.members, ...unitB.members],
    tournamentName,
    region,
    acceptedBy: new Set(),
    createdAt: new Date(),
    requeueFn,
    kind,
  };

  // Auto-expire match if no response within expiryMs
  setTimeout(() => expireMatch(matchId), expiryMs);

  return matchId;
}

function acceptMatch(matchId, discordId) {
  const match = pendingMatches[matchId];
  if (!match) return { status: 'not_found' };

  match.acceptedBy.add(discordId);

  const allAccepted = match.players.every(p => match.acceptedBy.has(p.discordId));

  if (allAccepted) {
    delete pendingMatches[matchId];
    return { status: 'confirmed', match };
  }

  return {
    status: 'waiting',
    acceptedCount: match.acceptedBy.size,
    totalCount: match.players.length,
  };
}

function rejectMatch(matchId, discordId) {
  const match = pendingMatches[matchId];
  if (!match) return { status: 'not_found' };

  const rejector = match.players.find(p => p.discordId === discordId);
  const others = match.players.filter(p => p.discordId !== discordId);

  delete pendingMatches[matchId];

  // Both units go back to their original queues, including the rejector's own unit —
  // rejecting a specific match doesn't mean leaving the queue.
  match.requeueFn(match.unitA);
  match.requeueFn(match.unitB);

  return { status: 'rejected', rejector, others, unitA: match.unitA, unitB: match.unitB };
}

function expireMatch(matchId) {
  const match = pendingMatches[matchId];
  if (match) {
    delete pendingMatches[matchId];
    match.requeueFn(match.unitA);
    match.requeueFn(match.unitB);
    console.log(`Match ${matchId} expired with no response — both units re-queued.`);
  }
}

function getMatch(matchId) {
  return pendingMatches[matchId] ?? null;
}

function getPendingMatchByDiscordId(guildId, discordId) {
  for (const match of Object.values(pendingMatches)) {
    if (match.guildId !== guildId) continue;
    if (match.players.some(p => p.discordId === discordId)) {
      return { matchId: match.matchId, match };
    }
  }
  return null;
}

// Count of matches still awaiting accept/reject from at least one player, scoped to this guild —
// used by /bot-status.
function getPendingMatchCount(guildId) {
  return Object.values(pendingMatches).filter(match => match.guildId === guildId).length;
}

module.exports = { createMatch, acceptMatch, rejectMatch, getMatch, getPendingMatchByDiscordId, getPendingMatchCount };
