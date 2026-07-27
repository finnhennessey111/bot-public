// queue.js - In-memory (persisted) queue management for MatchMaker. The queue pool is shared
// globally across every guild the bot is installed in (cross-server matchmaking) — it is NOT
// partitioned by guild. Every function below still accepts a `guildId` where it did before (so
// every existing call site keeps working unchanged), but it's no longer used to key the pool —
// only to stamp onto the built player/unit for channel routing (which guild(s) a match's private
// channel(s) get created in). Every unit carries its own `guildId` (stamped at join time) so
// requeues/events downstream don't need a second guildId threaded through separately.
//
// Queue entries are "units" of 1 or 2 already-scraped players:
//   - duo / solo lf2 -> unit with 1 member
//   - lf1 (a pre-formed trios party) -> unit with 2 members, leader is members[0]
// A unit is matched and removed from the queue as a single entry. A unit's members are always
// from the same guild (parties are formed within one server), so `unit.guildId` covers every
// member.
//
// Matching has no hard PR bands. Eligibility is gated by a soft, time-widening logPR
// distance rule (getWideningTier, same Math.log(totalPR + 1) * 100 mechanism as
// creative-queue.js, against config.tournamentWideningSchedule), and among eligible candidates
// the closest Match Score wins, with a PR-distance penalty nudging the ranking
// (getPRDistancePenalty). The whole
// waiting pool for a tournament+region (across every guild) is reconciled together
// (attemptMatchingForQueue), triggered by joins, by reject/expire requeues, and by a periodic
// sweep — never by per-unit timers, so eligibility is always derivable from `joinedAt` alone
// and survives a bot restart with no extra state to reconstruct.

const { EventEmitter } = require('events');
const { computeMatchScoreBreakdown } = require('./scraper');
const { queues, save } = require('./store');
const config = require('./config');
const playerStore = require('./players');

const matchEvents = new EventEmitter();

function getQueue(tournamentName, region) {
  if (!queues[tournamentName]) queues[tournamentName] = {};
  if (!Array.isArray(queues[tournamentName][region])) {
    // Also covers the pre-rework banded shape ({bandKey: [...]}) left over in an old
    // data.json — treated as empty rather than crashing on the shape mismatch.
    queues[tournamentName][region] = [];
  }
  return queues[tournamentName][region];
}

function generateUnitId() {
  return `unit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function isInQueue(guildId, discordId, tournamentName, region) {
  if (!queues[tournamentName]?.[region]) return false;
  const band = getQueue(tournamentName, region);
  return band.some(unit => unit.members.some(p => p.discordId === discordId));
}

function removeFromQueue(guildId, discordId, tournamentName, region) {
  if (!queues[tournamentName]?.[region]) return false;
  const band = getQueue(tournamentName, region);
  const index = band.findIndex(unit => unit.members.some(p => p.discordId === discordId));
  if (index !== -1) {
    band.splice(index, 1);
    save(guildId);
    return true;
  }
  return false;
}

function findUnitByDiscordId(guildId, discordId) {
  for (const tournamentName of Object.keys(queues)) {
    for (const region of Object.keys(queues[tournamentName])) {
      const band = getQueue(tournamentName, region);
      const unit = band.find(u => u.members.some(p => p.discordId === discordId));
      if (unit) return { unit, tournamentName, region };
    }
  }
  return null;
}

function removeFromQueueAnywhere(guildId, discordId) {
  const found = findUnitByDiscordId(guildId, discordId);
  if (!found) return false;
  const band = getQueue(found.tournamentName, found.region);
  const index = band.findIndex(u => u.unitId === found.unit.unitId);
  if (index !== -1) {
    band.splice(index, 1);
    save(guildId);
    return true;
  }
  return false;
}

function getQueueCount(guildId, tournamentName, region) {
  if (!queues[tournamentName]?.[region]) return 0;
  const band = getQueue(tournamentName, region);
  let count = 0;
  for (const unit of band) count += unit.members.length;
  return count;
}

function isCompatibleQueueType(typeA, typeB) {
  if (typeA === 'duo' && typeB === 'duo') return true;
  // Trios: a 2-person party (lf1) completes with a solo player (lf2). Two lf1s (4 people) or
  // two lf2s (2 people) never produce a valid trio in a single match, so they're incompatible.
  if (typeA === 'lf1' && typeB === 'lf2') return true;
  if (typeA === 'lf2' && typeB === 'lf1') return true;
  return false;
}

function isCompatiblePlatform(unitA, unitB) {
  const members = [...unitA.members, ...unitB.members];
  const anyConsoleOnly = members.some(p => p.consoleOnly);
  // Console-only tournaments — every member across both units must be console
  if (anyConsoleOnly) {
    return members.every(p => p.platform === 'Console');
  }
  // Mixed tournaments — PC and Console can match together, Mobile matches with anyone
  return true;
}

function toLogPR(totalPR) {
  return Math.log(totalPR + 1) * 100;
}

// Widening tier for a unit right now, based purely on elapsed wait time — no stored timer
// state, so this is always correct even immediately after a restart. Gates on logPR distance
// (Math.log(totalPR + 1) * 100), not raw PR — same mechanism as creative-queue.js's
// getCreativeWideningTier, just against config.tournamentWideningSchedule instead of
// config.creativeWideningSchedule.
function getWideningTier(waitSeconds) {
  let tier = config.tournamentWideningSchedule[0];
  for (const step of config.tournamentWideningSchedule) {
    if (waitSeconds >= step.afterSeconds) tier = step;
  }
  return tier;
}

function getPRDistancePenalty(prDiff) {
  for (const tier of config.prDistancePenalties) {
    if (prDiff <= tier.maxDiff) return tier.scorePenalty;
  }
  return config.prDistancePenalties[config.prDistancePenalties.length - 1].scorePenalty;
}

// Same-platform-only gate for the tier's early band — generalized from creative-queue.js's
// single-member check (unitA.members[0].platform !== unitB.members[0].platform) to tournament
// units, which can carry 2 members (an lf1 party).
function isSamePlatform(unitA, unitB) {
  const platforms = new Set([...unitA.members, ...unitB.members].map(p => p.platform));
  return platforms.size === 1;
}

function canMatch(unitA, unitB, now) {
  if (!isCompatibleQueueType(unitA.queueType, unitB.queueType)) return false;
  if (!isCompatiblePlatform(unitA, unitB)) return false;

  const waitA = (now - new Date(unitA.joinedAt).getTime()) / 1000;
  const waitB = (now - new Date(unitB.joinedAt).getTime()) / 1000;
  // Tiers widen monotonically with wait time, so the tier keyed off the *smaller* of the two
  // waits is always the more restrictive one — same principle creative-queue.js's evaluateMatch
  // relies on, so a freshly-joined unit can't be dragged into a wide-open gap just because the
  // other side has been waiting long enough to be fully open.
  const tier = getWideningTier(Math.min(waitA, waitB));

  if (tier.samePlatformOnly && !isSamePlatform(unitA, unitB)) return false;

  const logPRDiff = Math.abs(toLogPR(unitA.totalPR) - toLogPR(unitB.totalPR));
  return logPRDiff <= tier.maxLogPRDiff;
}

function rankingDiff(unitA, unitB) {
  const prDiff = Math.abs(unitA.totalPR - unitB.totalPR);
  const scoreDiff = Math.abs(unitA.matchScore - unitB.matchScore);
  return scoreDiff * (1 + getPRDistancePenalty(prDiff));
}

// Greedily pairs up everyone currently eligible in this tournament+region's global queue (every
// guild pooled together). Not a globally-optimal matching — deliberately simple, since realistic
// queue sizes here are dozens of people, not thousands. Runs fully synchronously up through each
// splice+save, so two overlapping calls (e.g. a sweep firing mid-join) can't double-match the
// same unit.
function attemptMatchingForQueue(tournamentName, region) {
  const now = Date.now();
  const pool = getQueue(tournamentName, region);

  let matchedSomething = true;
  while (matchedSomething) {
    matchedSomething = false;

    for (let i = 0; i < pool.length; i++) {
      let bestJ = -1;
      let bestDiff = Infinity;

      for (let j = 0; j < pool.length; j++) {
        if (i === j) continue;
        if (!canMatch(pool[i], pool[j], now)) continue;

        const diff = rankingDiff(pool[i], pool[j]);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestJ = j;
        }
      }

      if (bestJ !== -1) {
        const unitA = pool[i];
        const unitB = pool[bestJ];
        pool.splice(Math.max(i, bestJ), 1);
        pool.splice(Math.min(i, bestJ), 1);
        save(unitA.guildId);
        matchEvents.emit('matchFound', { unitA, unitB, tournamentName, region });
        matchedSomething = true;
        break; // pool mutated — restart the scan
      }
    }
  }
}

function sweepAllQueues() {
  for (const tournamentName of Object.keys(queues)) {
    for (const region of Object.keys(queues[tournamentName])) {
      if (getQueue(tournamentName, region).length > 0) {
        attemptMatchingForQueue(tournamentName, region);
      }
    }
  }
}

function startMatchSweep() {
  setInterval(sweepAllQueues, config.matchSweepIntervalSeconds * 1000);
}

async function buildPlayer({
  guildId,
  guildName,
  discordId,
  discordUsername,
  discordTag,
  epicUsername,
  epicId,
  tournamentName,
  homeRegion,
  queueRegion,
  queueType,
  platform,
  consoleOnly,
  ingameRoles,
  languages,
  ageBracket,
  bio,
}) {
  const playerData = await playerStore.getPlayerStats(guildId, discordId, epicUsername, epicId, homeRegion);
  const { matchScore, soloModifier } = computeMatchScoreBreakdown(playerData, tournamentName, homeRegion, queueRegion);

  return {
    guildId,
    guildName,
    discordId,
    discordUsername,
    discordTag,
    epicUsername,
    epicId,
    tournamentName,
    homeRegion,
    queueRegion,
    queueType,
    platform: platform ?? 'PC',
    consoleOnly: consoleOnly ?? false,
    ingameRoles: ingameRoles ?? [],
    languages: languages ?? [],
    ageBracket: ageBracket ?? null,
    bio: bio ?? null,
    totalPR: playerData.totalPR,
    thisSeasonPR: playerData.thisSeasonPR,
    matchScore,
    // Snapshotted here (not just the final matchScore) so feedback.js can persist the exact
    // scoring inputs at match time without re-deriving them later — see scraper.js's
    // computeMatchScoreBreakdown doc comment.
    soloModifier,
    recentEvents: playerData.recentEvents,
    joinedAt: new Date(),
  };
}

function average(players, field) {
  return players.reduce((sum, p) => sum + p[field], 0) / players.length;
}

async function joinQueue({ guildId, players, tournamentName, region, queueType, partyId = null }) {
  const unit = {
    unitId: generateUnitId(),
    guildId,
    queueType,
    members: players,
    partyId,
    totalPR: average(players, 'totalPR'),
    matchScore: average(players, 'matchScore'),
    tournamentName,
    region,
    joinedAt: new Date(),
  };

  getQueue(tournamentName, region).push(unit);
  save(guildId);

  attemptMatchingForQueue(tournamentName, region);

  return { unit };
}

function requeueUnit(unit) {
  getQueue(unit.tournamentName, unit.region).push(unit);
  save(unit.guildId);
  attemptMatchingForQueue(unit.tournamentName, unit.region);
}

module.exports = {
  buildPlayer,
  joinQueue,
  requeueUnit,
  removeFromQueue,
  removeFromQueueAnywhere,
  findUnitByDiscordId,
  isInQueue,
  getQueueCount,
  isCompatibleQueueType,
  isCompatiblePlatform,
  getWideningTier,
  startMatchSweep,
  matchEvents,
};
