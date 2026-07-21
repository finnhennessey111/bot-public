// creative-team-queue.js - Partial-fill matching engine for 6s (3v3) and 8s (4v4) creative queue
//
// Unlike creative-queue.js's pairwise 1v1/2v2 matcher (exactly 2 solo units, no party
// involved), this assembles a full lobby of 6 or 8 *individual players* out of solo/party
// units (1-5 people each, via party.js) over time — "partial fill". A unit joins an existing
// in-progress forming match if it's compatible and there's room, otherwise it starts a new one;
// the periodic sweep also tries to merge compatible forming matches together. A match is
// confirmed (and handed off for the lock/ready-check/vote-kick lifecycle) the moment its
// player count hits the mode's target size.
//
// Reuses creative-queue.js's logPR math and widening schedule (config.creativeWideningSchedule)
// — no separate PR-widening config for team queue. Compatibility for a candidate unit is judged
// against the *average* logPR of every player already assembled in the forming match, using the
// forming match's own age (not any individual player's wait) as the widening-tier clock, since a
// forming match can have several different join times once it has 2+ units in it.
//
// In-memory only (not persisted) — same ephemeral-state precedent as matching.js's
// pendingMatches and party.js's pendingInvites. A restart loses in-progress forming matches.

const { EventEmitter } = require('events');
const { REGIONS, toLogPR, getCreativeWideningTier } = require('./creative-queue');
const config = require('./config');

const MODES = {
  '6s': ['3v3 Realistics', '3v3 Zone Wars'],
  '8s': ['4v4 Realistics', '4v4 Zone Wars'],
};

const TARGET_SIZE = { '6s': 6, '8s': 8 };

const creativeTeamMatchEvents = new EventEmitter();

// formingMatches[mode][region] = array of { formingId, mode, region, units, createdAt }
// each unit = { unitId, players, joinedAt } (players = 1-5 already-scraped creative-player
// objects — a solo queuer or a full party, from party.js's getPartyMembers).
const formingMatches = {};

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function categoryForMode(mode) {
  return Object.keys(MODES).find(category => MODES[category].includes(mode));
}

function targetSizeForMode(mode) {
  return TARGET_SIZE[categoryForMode(mode)];
}

function getBucket(mode, region) {
  if (!formingMatches[mode]) formingMatches[mode] = {};
  if (!Array.isArray(formingMatches[mode][region])) formingMatches[mode][region] = [];
  return formingMatches[mode][region];
}

function groupPlayerCount(match) {
  return match.units.reduce((sum, u) => sum + u.players.length, 0);
}

function groupAvgLogPR(match) {
  const players = match.units.flatMap(u => u.players);
  return players.reduce((sum, p) => sum + toLogPR(p.totalPR), 0) / players.length;
}

function unitAvgLogPR(unit) {
  return unit.players.reduce((sum, p) => sum + toLogPR(p.totalPR), 0) / unit.players.length;
}

function groupPlatforms(match) {
  return new Set(match.units.flatMap(u => u.players.map(p => p.platform)));
}

function describeUnit(unit) {
  return unit.players.map(p => `${p.discordUsername} (${p.epicUsername})`).join(' + ');
}

// Single source of truth for both the join decision and its debug explanation — same pattern
// as creative-queue.js's evaluateMatch, computed once so the log can't drift from the logic.
function evaluateJoin(unit, match, now) {
  const targetSize = targetSizeForMode(match.mode);
  const room = targetSize - groupPlayerCount(match);
  if (unit.players.length > room) {
    return { fits: false, reason: `only ${room} slot(s) left, unit has ${unit.players.length}` };
  }

  const wait = (now - new Date(match.createdAt).getTime()) / 1000;
  const tier = getCreativeWideningTier(wait);

  if (tier.samePlatformOnly) {
    const combined = new Set([...groupPlatforms(match), ...unit.players.map(p => p.platform)]);
    if (combined.size > 1) {
      return {
        fits: false,
        reason: `platform mismatch (${[...combined].join('/')}) — same-platform-only until match has waited `
          + `${config.creativeWideningSchedule[1]?.afterSeconds ?? '?'}s (waited ${wait.toFixed(0)}s)`,
      };
    }
  }

  const diff = Math.abs(groupAvgLogPR(match) - unitAvgLogPR(unit));
  if (diff > tier.maxLogPRDiff) {
    return { fits: false, reason: `avg logPR diff ${diff.toFixed(1)} exceeds current cap ${tier.maxLogPRDiff} (waited ${wait.toFixed(0)}s)` };
  }

  return { fits: true, reason: null, diff };
}

function confirmMatch(bucket, match) {
  bucket.splice(bucket.indexOf(match), 1);
  const players = match.units.flatMap(u => u.players);
  console.log(`[creative-team-queue] MATCH FORMED ${match.mode}/${match.region}: ${players.map(p => p.discordUsername).join(', ')}`);
  // units (not just the flattened players) are passed through so the post-formation lifecycle
  // can keep each party together when splitting the match into two teams.
  creativeTeamMatchEvents.emit('matchFormed', { units: match.units, players, mode: match.mode, region: match.region });
}

function queueUnit(players, mode, region) {
  const now = Date.now();
  const targetSize = targetSizeForMode(mode);
  const bucket = getBucket(mode, region);
  const unit = { unitId: generateId('tunit'), players, joinedAt: new Date() };

  console.log(
    `[creative-team-queue] JOIN ${describeUnit(unit)} mode=${mode} region=${region} `
    + `size=${players.length} avgLogPR=${unitAvgLogPR(unit).toFixed(1)}`
  );

  let bestMatch = null;
  let bestDiff = Infinity;

  for (const match of bucket) {
    const result = evaluateJoin(unit, match, now);
    if (!result.fits) {
      console.log(`[creative-team-queue]   cannot join ${match.formingId} (${groupPlayerCount(match)}/${targetSize}): ${result.reason}`);
      continue;
    }
    if (result.diff < bestDiff) {
      bestDiff = result.diff;
      bestMatch = match;
    }
  }

  if (bestMatch) {
    bestMatch.units.push(unit);
    const filled = groupPlayerCount(bestMatch);
    console.log(`[creative-team-queue] ${describeUnit(unit)} joined ${bestMatch.formingId} — ${filled}/${targetSize}`);

    if (filled === targetSize) confirmMatch(bucket, bestMatch);
    return { unit, formingMatch: filled === targetSize ? null : bestMatch };
  }

  const newMatch = { formingId: generateId('tmatch'), mode, region, units: [unit], createdAt: new Date() };
  bucket.push(newMatch);
  console.log(`[creative-team-queue] ${describeUnit(unit)} started ${newMatch.formingId} — ${players.length}/${targetSize}`);
  return { unit, formingMatch: newMatch };
}

function findUnitByDiscordId(discordId) {
  for (const mode of Object.keys(formingMatches)) {
    for (const region of Object.keys(formingMatches[mode])) {
      for (const match of formingMatches[mode][region]) {
        const unit = match.units.find(u => u.players.some(p => p.discordId === discordId));
        if (unit) return { unit, match, mode, region };
      }
    }
  }
  return null;
}

function isInTeamQueue(discordId) {
  return !!findUnitByDiscordId(discordId);
}

// Removes the whole unit (the entire party that queued together), not just the one player —
// a party queued as one indivisible unit, consistent with how removeFromCreativeQueueAnywhere
// treats units in the pairwise queue.
function removeFromTeamQueueAnywhere(discordId) {
  const found = findUnitByDiscordId(discordId);
  if (!found) return false;

  const { unit, match, mode, region } = found;
  const bucket = getBucket(mode, region);
  match.units.splice(match.units.indexOf(unit), 1);
  if (match.units.length === 0) bucket.splice(bucket.indexOf(match), 1);
  return true;
}

function getTeamQueueWaitingCount(mode, region) {
  return getBucket(mode, region).reduce((sum, match) => sum + groupPlayerCount(match), 0);
}

// Tries to merge compatible forming matches together — lets two groups that started separately
// (e.g. two 3-player parties for 6s) combine once they've both waited long enough to pass the
// same compatibility check, without needing a fresh join to trigger it.
function attemptMergeForBucket(mode, region) {
  const bucket = getBucket(mode, region);
  const now = Date.now();
  const targetSize = targetSizeForMode(mode);

  let merged = true;
  while (merged) {
    merged = false;

    outer: for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];

        if (groupPlayerCount(a) + groupPlayerCount(b) > targetSize) continue;

        // Use the older (stricter) of the two matches' ages for the tier lookup.
        const olderCreatedAt = Math.min(new Date(a.createdAt).getTime(), new Date(b.createdAt).getTime());
        const wait = (now - olderCreatedAt) / 1000;
        const tier = getCreativeWideningTier(wait);

        if (tier.samePlatformOnly) {
          const combined = new Set([...groupPlatforms(a), ...groupPlatforms(b)]);
          if (combined.size > 1) continue;
        }

        if (Math.abs(groupAvgLogPR(a) - groupAvgLogPR(b)) > tier.maxLogPRDiff) continue;

        a.units.push(...b.units);
        bucket.splice(j, 1);
        console.log(`[creative-team-queue] MERGE ${mode}/${region}: ${a.formingId} + ${b.formingId} -> ${groupPlayerCount(a)}/${targetSize}`);

        if (groupPlayerCount(a) === targetSize) confirmMatch(bucket, a);

        merged = true;
        break outer; // buckets mutated — restart the scan
      }
    }
  }
}

// Pulls compatible units directly out of the forming-match pool to backfill an already-confirmed
// match's vacant slots (ready-check timeout or vote-kick removal). Reuses the same
// platform/logPR compatibility check as normal queueing, judged against the confirmed group's
// current average logPR/platform set — the caller (team-match-lifecycle.js) supplies those plus
// the tier (looked up from its own match's age) since a confirmed match isn't a forming match.
function pullReplacementUnits(mode, region, vacantCount, groupAvg, groupPlats, tier, excludeIds = null) {
  const bucket = getBucket(mode, region);
  const pulled = [];
  let pulledCount = 0;

  for (const match of [...bucket]) {
    for (const unit of [...match.units]) {
      if (pulledCount + unit.players.length > vacantCount) continue;

      // Never backfill a unit containing someone just removed from *this* match (vote-kicked,
      // or a ready-check no-show) — otherwise, whenever they're the only unit waiting for this
      // mode/region, they'd be immediately pulled right back into the match they just left.
      if (excludeIds && unit.players.some(p => excludeIds.has(p.discordId))) continue;

      if (tier.samePlatformOnly) {
        const combined = new Set([...groupPlats, ...unit.players.map(p => p.platform)]);
        if (combined.size > 1) continue;
      }

      if (Math.abs(groupAvg - unitAvgLogPR(unit)) > tier.maxLogPRDiff) continue;

      match.units.splice(match.units.indexOf(unit), 1);
      if (match.units.length === 0) bucket.splice(bucket.indexOf(match), 1);
      pulled.push(unit);
      pulledCount += unit.players.length;

      if (pulledCount === vacantCount) return pulled;
    }
  }

  return pulled;
}

function sweepAllTeamQueues() {
  for (const mode of Object.keys(formingMatches)) {
    for (const region of Object.keys(formingMatches[mode])) {
      if (getBucket(mode, region).length > 1) {
        attemptMergeForBucket(mode, region);
      }
    }
  }
}

function startCreativeTeamMatchSweep() {
  setInterval(sweepAllTeamQueues, config.matchSweepIntervalSeconds * 1000);
}

module.exports = {
  MODES,
  REGIONS,
  TARGET_SIZE,
  categoryForMode,
  targetSizeForMode,
  queueUnit,
  isInTeamQueue,
  findUnitByDiscordId,
  removeFromTeamQueueAnywhere,
  getTeamQueueWaitingCount,
  pullReplacementUnits,
  startCreativeTeamMatchSweep,
  creativeTeamMatchEvents,
};
