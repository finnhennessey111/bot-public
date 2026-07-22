// matching.js - Handles pending match proposals and accept/reject logic for 2- or 3-player
// matches. The queue pool is global (cross-server matchmaking), so a single match can now involve
// players from more than one guild — there's no one "owning" guildId for a match anymore.

const { EventEmitter } = require('events');
const { requeueUnit } = require('./queue');

// Emits 'expired' — accept/reject are both driven synchronously from a button click (the caller
// already has everything it needs in the return value), but expiry fires off a bare setTimeout
// with no caller to hand a result to, so index.js listens here instead to tear down the match's
// channel(s) across every guild involved.
const matchLifecycleEvents = new EventEmitter();

// Pending matches structure:
// pendingMatches[matchId] = {
//   matchId, unitA, unitB,
//   players: [...unitA.members, ...unitB.members],  // 2 for duo, 3 for trios (party + solo)
//   tournamentName, region, acceptedBy: Set, createdAt, requeueFn, kind,
//   channelsByGuildId: Map<guildId, {channelId, messageId}>,
// }
const pendingMatches = {};

function generateMatchId() {
  return `match_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// requeueFn lets non-tournament callers (e.g. the creative queue) plug in their own queue's
// requeue logic on reject/expiry instead of the tournament queue.js default. `kind` tags the
// match so the confirm-flow (private channel creation etc.) can branch on it later.
function createMatch(unitA, unitB, tournamentName, region, {
  requeueFn = requeueUnit, kind = 'tournament', expiryMs = 5 * 60 * 1000,
} = {}) {
  const matchId = generateMatchId();

  pendingMatches[matchId] = {
    matchId,
    unitA,
    unitB,
    players: [...unitA.members, ...unitB.members],
    tournamentName,
    region,
    acceptedBy: new Set(),
    createdAt: new Date(),
    requeueFn,
    kind,
    // guildId -> { channelId, messageId } — one channel per guild involved (a same-server match
    // has exactly one entry, a cross-server match has one per side). Populated right after
    // creation by match-channels.js, once the channels themselves exist.
    channelsByGuildId: new Map(),
  };

  // Auto-expire match if no response within expiryMs
  setTimeout(() => expireMatch(matchId), expiryMs);

  return matchId;
}

// Called by match-channels.js once the per-guild channels are created, so accept/reject/expire
// can broadcast to every one of them instead of a single channel.
function attachMatchChannels(matchId, channelsByGuildId) {
  const match = pendingMatches[matchId];
  if (match) match.channelsByGuildId = channelsByGuildId;
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

  return {
    status: 'rejected', rejector, others, unitA: match.unitA, unitB: match.unitB,
    channelsByGuildId: match.channelsByGuildId,
  };
}

function expireMatch(matchId) {
  const match = pendingMatches[matchId];
  if (match) {
    delete pendingMatches[matchId];
    match.requeueFn(match.unitA);
    match.requeueFn(match.unitB);
    console.log(`Match ${matchId} expired with no response — both units re-queued.`);
    matchLifecycleEvents.emit('expired', { matchId, channelsByGuildId: match.channelsByGuildId, kind: match.kind });
  }
}

function getMatch(matchId) {
  return pendingMatches[matchId] ?? null;
}

// guildId param kept for call-site compatibility but no longer used to scope the search — a
// Discord ID can only be in one pending match at a time regardless of which guild is asking
// (the queue pool is global now, so "this match belongs to guild X" isn't a meaningful filter).
function getPendingMatchByDiscordId(guildId, discordId) {
  for (const match of Object.values(pendingMatches)) {
    if (match.players.some(p => p.discordId === discordId)) {
      return { matchId: match.matchId, match };
    }
  }
  return null;
}

// Count of matches still awaiting accept/reject from at least one player, across every guild —
// used by /bot-status. guildId kept for call-site compatibility, unused (see getPendingMatchByDiscordId).
function getPendingMatchCount(guildId) {
  return Object.keys(pendingMatches).length;
}

module.exports = {
  createMatch, attachMatchChannels,
  acceptMatch, rejectMatch, getMatch, getPendingMatchByDiscordId, getPendingMatchCount,
  matchLifecycleEvents,
};
