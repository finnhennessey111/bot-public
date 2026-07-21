// creative-queue.js - Matching engine for the Fortnite Creative queue (1v1/2v2 Realistics & Zone
// Wars), scoped per guild.
//
// Deliberately independent of queue.js's tournament matching: no Elo, no tournament placement
// data, no party system. A "unit" here is always exactly one solo player — even in 2v2 modes,
// each queuer represents their own team and is matched against one opponent queuer, never
// teamed up with another Discord member (see task spec: "no party system... not a teammate").
// Every unit carries its own `guildId` (stamped at join time) so requeues/events downstream
// don't need a second guildId threaded through separately.
//
// Eligibility is gated purely by elapsed wait time off `joinedAt` (no stored timers, so it
// survives a restart), on its own schedule — deliberately independent of tournament.js's
// widening (config.creativeWideningSchedule, not config.matchWideningSchedule):
//   - PR is compared on a log scale (logPR = ln(totalPR + 1) * 100), not raw PR, so the
//     allowed gap means the same thing at low and high PR rather than being dominated by
//     players with huge totals.
//   - Platform restriction is tied to the same tiers as the logPR band: same-platform-only
//     while the band is tight, opening to any platform once it widens.
// Ranking among eligible candidates is just closest logPR — no match-score weighting.

const { EventEmitter } = require('events');
const playerStore = require('./players');
const { creativeQueues, save } = require('./store');
const config = require('./config');

const MODES = {
  '1v1': ['1v1 Realistics', '1v1 Zone Wars'],
  '2v2': ['2v2 Realistics', '2v2 Zone Wars'],
};

const REGIONS = ['EU', 'NAC'];

const creativeMatchEvents = new EventEmitter();

function generateUnitId() {
  return `cunit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function getQueue(guildId, mode, region) {
  if (!creativeQueues[guildId]) creativeQueues[guildId] = {};
  if (!creativeQueues[guildId][mode]) creativeQueues[guildId][mode] = {};
  if (!Array.isArray(creativeQueues[guildId][mode][region])) creativeQueues[guildId][mode][region] = [];
  return creativeQueues[guildId][mode][region];
}

function isInCreativeQueue(guildId, discordId) {
  return !!findCreativeUnitByDiscordId(guildId, discordId);
}

function findCreativeUnitByDiscordId(guildId, discordId) {
  if (!creativeQueues[guildId]) return null;
  for (const mode of Object.keys(creativeQueues[guildId])) {
    for (const region of Object.keys(creativeQueues[guildId][mode])) {
      const unit = getQueue(guildId, mode, region).find(u => u.members.some(p => p.discordId === discordId));
      if (unit) return { unit, mode, region };
    }
  }
  return null;
}

function removeFromCreativeQueueAnywhere(guildId, discordId) {
  const found = findCreativeUnitByDiscordId(guildId, discordId);
  if (!found) return false;
  const band = getQueue(guildId, found.mode, found.region);
  const index = band.findIndex(u => u.unitId === found.unit.unitId);
  if (index !== -1) {
    band.splice(index, 1);
    save(guildId);
    return true;
  }
  return false;
}

function getCreativeQueueCount(guildId, mode, region) {
  return getQueue(guildId, mode, region).length;
}

function toLogPR(totalPR) {
  return Math.log(totalPR + 1) * 100;
}

// Schedule tiers widen monotonically with wait time, so the tier keyed off the *smaller* of
// the two waits is always the more restrictive one — same principle as tournament.js pairing
// the stricter (less-waited) side, just collapsed into one lookup since logPR band and
// platform restriction move together here.
function getCreativeWideningTier(waitSeconds) {
  let tier = config.creativeWideningSchedule[0];
  for (const step of config.creativeWideningSchedule) {
    if (waitSeconds >= step.afterSeconds) tier = step;
  }
  return tier;
}

function rankingDiff(unitA, unitB) {
  return Math.abs(toLogPR(unitA.totalPR) - toLogPR(unitB.totalPR));
}

// Single source of truth for both the matching decision and its debug explanation, so the
// "why didn't this pair match" log can never drift out of sync with the actual eligibility
// logic (computed once per pair instead of twice).
function evaluateMatch(unitA, unitB, now) {
  const waitA = (now - new Date(unitA.joinedAt).getTime()) / 1000;
  const waitB = (now - new Date(unitB.joinedAt).getTime()) / 1000;
  const stricterWait = Math.min(waitA, waitB);
  const tier = getCreativeWideningTier(stricterWait);
  const logPRDiff = rankingDiff(unitA, unitB);

  if (tier.samePlatformOnly && unitA.members[0].platform !== unitB.members[0].platform) {
    return {
      eligible: false,
      logPRDiff,
      reason: `platform mismatch (${unitA.members[0].platform} vs ${unitB.members[0].platform}) — `
        + `same-platform-only until stricter side has waited ${config.creativeWideningSchedule[1]?.afterSeconds ?? '?'}s `
        + `(waited ${stricterWait.toFixed(0)}s)`,
    };
  }

  if (logPRDiff > tier.maxLogPRDiff) {
    return {
      eligible: false,
      logPRDiff,
      reason: `logPR diff ${logPRDiff.toFixed(1)} exceeds current cap ${tier.maxLogPRDiff} (waited ${stricterWait.toFixed(0)}s)`,
    };
  }

  return { eligible: true, logPRDiff, reason: null };
}

function describeUnit(unit) {
  const p = unit.members[0];
  return `${p.discordUsername} (${p.epicUsername})`;
}

// Greedy pairing, same approach as queue.js's attemptMatchingForQueue — fine at realistic
// creative-queue sizes, and runs fully synchronously so overlapping calls can't double-match.
function attemptMatchingForQueue(guildId, mode, region) {
  const now = Date.now();
  const pool = getQueue(guildId, mode, region);

  if (pool.length === 0) return;

  console.log(`[creative-queue] sweep ${guildId}/${mode}/${region}: ${pool.length} in queue`);
  for (const unit of pool) {
    const wait = (now - new Date(unit.joinedAt).getTime()) / 1000;
    console.log(
      `[creative-queue]   waiting: ${describeUnit(unit)} totalPR=${unit.totalPR} `
      + `logPR=${toLogPR(unit.totalPR).toFixed(1)} platform=${unit.members[0].platform} waited=${wait.toFixed(0)}s`
    );
  }

  let matchedSomething = true;
  while (matchedSomething) {
    matchedSomething = false;

    for (let i = 0; i < pool.length; i++) {
      let bestJ = -1;
      let bestDiff = Infinity;

      for (let j = 0; j < pool.length; j++) {
        if (i === j) continue;

        const result = evaluateMatch(pool[i], pool[j], now);

        if (!result.eligible) {
          if (j > i) { // symmetric — log each pair once
            console.log(`[creative-queue]   ${describeUnit(pool[i])} <-> ${describeUnit(pool[j])}: NOT eligible — ${result.reason}`);
          }
          continue;
        }

        if (result.logPRDiff < bestDiff) {
          bestDiff = result.logPRDiff;
          bestJ = j;
        }
      }

      if (bestJ !== -1) {
        const unitA = pool[i];
        const unitB = pool[bestJ];
        console.log(`[creative-queue] MATCH: ${describeUnit(unitA)} <-> ${describeUnit(unitB)} (logPR diff ${bestDiff.toFixed(1)})`);
        pool.splice(Math.max(i, bestJ), 1);
        pool.splice(Math.min(i, bestJ), 1);
        save(guildId);
        creativeMatchEvents.emit('matchFound', { unitA, unitB, mode, region, guildId });
        matchedSomething = true;
        break; // pool mutated — restart the scan
      }
    }
  }
}

function sweepAllCreativeQueues() {
  for (const guildId of Object.keys(creativeQueues)) {
    for (const mode of Object.keys(creativeQueues[guildId])) {
      for (const region of Object.keys(creativeQueues[guildId][mode])) {
        if (getQueue(guildId, mode, region).length > 0) {
          attemptMatchingForQueue(guildId, mode, region);
        }
      }
    }
  }
}

function startCreativeMatchSweep() {
  setInterval(sweepAllCreativeQueues, config.matchSweepIntervalSeconds * 1000);
}

async function buildCreativePlayer({ guildId, discordId, discordUsername, epicUsername, epicId, mode, region, platform }) {
  const { totalPR } = await playerStore.getPlayerStats(guildId, discordId, epicUsername, epicId, region);

  return {
    discordId,
    discordUsername,
    epicUsername,
    epicId,
    mode,
    region,
    platform: platform ?? 'PC',
    totalPR,
    joinedAt: new Date(),
  };
}

function joinCreativeQueue({ guildId, player, mode, region }) {
  const unit = {
    unitId: generateUnitId(),
    guildId,
    members: [player],
    mode,
    region,
    totalPR: player.totalPR,
    joinedAt: new Date(),
  };

  const pool = getQueue(guildId, mode, region);
  pool.push(unit);
  save(guildId);

  console.log(
    `[creative-queue] JOIN ${describeUnit(unit)} guild=${guildId} mode=${mode} region=${region} `
    + `totalPR=${player.totalPR} logPR=${toLogPR(player.totalPR).toFixed(1)} platform=${player.platform} `
    + `— ${pool.length} now in queue`
  );

  attemptMatchingForQueue(guildId, mode, region);

  return { unit };
}

function requeueCreativeUnit(unit) {
  getQueue(unit.guildId, unit.mode, unit.region).push(unit);
  save(unit.guildId);
  attemptMatchingForQueue(unit.guildId, unit.mode, unit.region);
}

module.exports = {
  MODES,
  REGIONS,
  buildCreativePlayer,
  joinCreativeQueue,
  requeueCreativeUnit,
  removeFromCreativeQueueAnywhere,
  findCreativeUnitByDiscordId,
  isInCreativeQueue,
  getCreativeQueueCount,
  startCreativeMatchSweep,
  creativeMatchEvents,
  toLogPR,
  getCreativeWideningTier,
};
