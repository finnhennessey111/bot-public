// matching.js - Handles pending match proposals and accept/reject logic for 2- or 3-player
// matches. The queue pool is global (cross-server matchmaking), so a single match can now involve
// players from more than one guild — there's no one "owning" guildId for a match anymore.
//
// Pending matches are persisted (store.js's savePendingMatch/deletePendingMatch, same selective-
// save pattern store.js's other collections use) specifically because the accept/reject window is
// a real orphaned-channel risk otherwise: match-channels.js creates the private channel the moment
// a match is found, well before it, so a restart mid-accept/reject used to silently wipe this
// module's in-memory pendingMatches and leave that channel with no durable record anywhere at all
// — channel-lifecycle.js's matchChannels (and the auto-deletion safety net that comes with it)
// only ever learns about the channel once everyone accepts (see index.js's confirmMatchChannels).
// restorePendingMatches() (called once at startup) re-arms the expiry timer for whatever was still
// pending when the process last stopped, with the REMAINING time, not a fresh countdown — an
// already-overdue one is expired immediately instead. This is safe to restore in full (unlike
// team-match-lifecycle.js's much richer post-confirmation state — see that file's own comment):
// Discord button customIds are static strings baked into the already-sent message, so the
// Accept/Reject buttons a player clicks after a restart create a brand new interaction regardless
// of whether the interaction that originally posted them is long expired.

const { EventEmitter } = require('events');
const { requeueUnit } = require('./queue');
const { requeueCreativeUnit } = require('./creative-queue');
const store = require('./store');

// Emits 'expired' — accept/reject are both driven synchronously from a button click (the caller
// already has everything it needs in the return value), but expiry fires off a bare setTimeout
// with no caller to hand a result to, so index.js listens here instead to tear down the match's
// channel(s) across every guild involved.
const matchLifecycleEvents = new EventEmitter();

// Pending matches structure:
// pendingMatches[matchId] = {
//   matchId, unitA, unitB,
//   players: [...unitA.members, ...unitB.members],  // 2 for duo, 3 for trios (party + solo)
//   tournamentName, region, acceptedBy: Set, createdAt, expiryMs, requeueFn, kind,
//   channelsByGuildId: Map<guildId, {channelId, messageId}>,
// }
//
// requeueFn is a live callback, never persisted — reconstructed from `kind` at restore time (see
// requeueFnForKind) via the same 'tournament'/'creative' tag confirmMatchChannels already uses to
// distinguish them elsewhere. Only toPersistableRecord()'s plain output ever reaches store.js.
const pendingMatches = {};

function generateMatchId() {
  return `match_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function requeueFnForKind(kind) {
  return kind === 'creative' ? requeueCreativeUnit : requeueUnit;
}

// The plain, JSON-safe snapshot of a match saved to store.js — acceptedBy (Set) and
// channelsByGuildId (Map) don't survive JSON.stringify as-is (a Set/Map serializes to `{}`, silently
// losing every entry), and requeueFn is a live function reference, so none of the three cross this
// boundary in their live in-memory shape.
function toPersistableRecord(match) {
  return {
    matchId: match.matchId,
    unitA: match.unitA,
    unitB: match.unitB,
    tournamentName: match.tournamentName,
    region: match.region,
    kind: match.kind,
    expiryMs: match.expiryMs,
    createdAt: match.createdAt.toISOString(),
    acceptedBy: [...match.acceptedBy],
    channelsByGuildId: [...match.channelsByGuildId],
  };
}

function persistMatch(matchId) {
  store.pendingMatches[matchId] = toPersistableRecord(pendingMatches[matchId]);
  store.savePendingMatch(matchId);
}

function unpersistMatch(matchId) {
  delete store.pendingMatches[matchId];
  store.deletePendingMatch(matchId);
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
    expiryMs,
    requeueFn,
    kind,
    // guildId -> { channelId, messageId } — one channel per guild involved (a same-server match
    // has exactly one entry, a cross-server match has one per side). Populated right after
    // creation by match-channels.js, once the channels themselves exist.
    channelsByGuildId: new Map(),
  };
  persistMatch(matchId);

  // Auto-expire match if no response within expiryMs
  setTimeout(() => expireMatch(matchId), expiryMs);

  return matchId;
}

// Called by match-channels.js once the per-guild channels are created, so accept/reject/expire
// can broadcast to every one of them instead of a single channel. Re-persisted here specifically
// because this is the moment the channel IDs — the whole reason this record exists — become known;
// a restart between createMatch and this call would otherwise restore a record with nothing to
// actually point a player back at.
function attachMatchChannels(matchId, channelsByGuildId) {
  const match = pendingMatches[matchId];
  if (match) {
    match.channelsByGuildId = channelsByGuildId;
    persistMatch(matchId);
  }
}

function acceptMatch(matchId, discordId) {
  const match = pendingMatches[matchId];
  if (!match) return { status: 'not_found' };

  match.acceptedBy.add(discordId);

  const allAccepted = match.players.every(p => match.acceptedBy.has(p.discordId));

  if (allAccepted) {
    delete pendingMatches[matchId];
    unpersistMatch(matchId);
    return { status: 'confirmed', match };
  }

  persistMatch(matchId);
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
  unpersistMatch(matchId);

  // Both units go back to their original queues, including the rejector's own unit —
  // rejecting a specific match doesn't mean leaving the queue.
  match.requeueFn(match.unitA);
  match.requeueFn(match.unitB);

  return {
    status: 'rejected', rejector, others, unitA: match.unitA, unitB: match.unitB,
    channelsByGuildId: match.channelsByGuildId,
    // kind/tournamentName/region: lets a caller distinguish a tournament reject from a creative
    // one (feedback.js's reject-reason capture is tournament-only — see index.js's reject_
    // handler) without needing to separately track the pending match's shape itself.
    kind: match.kind, tournamentName: match.tournamentName, region: match.region,
  };
}

function expireMatch(matchId) {
  const match = pendingMatches[matchId];
  if (match) {
    delete pendingMatches[matchId];
    unpersistMatch(matchId);
    match.requeueFn(match.unitA);
    match.requeueFn(match.unitB);
    console.log(`Match ${matchId} expired with no response — both units re-queued.`);
    matchLifecycleEvents.emit('expired', { matchId, channelsByGuildId: match.channelsByGuildId, kind: match.kind });
  }
}

// Called once at startup (after store.init() has hydrated store.pendingMatches from Mongo/JSON),
// before any new match can be created — reconstructs the live shape (Set/Map, a real requeueFn)
// from each persisted plain snapshot and re-arms its expiry timer with whatever time was actually
// left, not a fresh countdown. A record whose window already lapsed while the process was down
// (or during a slow restart) is expired immediately instead of arming a negative-delay timer —
// same "already overdue" handling channel-lifecycle.js's armTimers uses for scheduled deletions.
function restorePendingMatches() {
  const records = Object.values(store.pendingMatches);
  if (records.length === 0) return;

  let restoredCount = 0;
  let expiredImmediatelyCount = 0;

  for (const record of records) {
    const match = {
      matchId: record.matchId,
      unitA: record.unitA,
      unitB: record.unitB,
      players: [...record.unitA.members, ...record.unitB.members],
      tournamentName: record.tournamentName,
      region: record.region,
      acceptedBy: new Set(record.acceptedBy),
      createdAt: new Date(record.createdAt),
      expiryMs: record.expiryMs,
      requeueFn: requeueFnForKind(record.kind),
      kind: record.kind,
      channelsByGuildId: new Map(record.channelsByGuildId),
    };

    pendingMatches[match.matchId] = match;

    const remainingMs = match.expiryMs - (Date.now() - match.createdAt.getTime());
    if (remainingMs <= 0) {
      expireMatch(match.matchId);
      expiredImmediatelyCount++;
    } else {
      setTimeout(() => expireMatch(match.matchId), remainingMs);
      restoredCount++;
    }
  }

  console.log(
    `[matching] Restored ${restoredCount} pending match(es) from a prior run`
    + (expiredImmediatelyCount > 0 ? `, ${expiredImmediatelyCount} already past their accept/reject window and expired immediately` : '')
    + '.'
  );
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
  restorePendingMatches,
  matchLifecycleEvents,
};
