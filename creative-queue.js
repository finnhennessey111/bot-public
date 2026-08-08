// creative-queue.js - Matching engine for the Fortnite Creative queue (1v1/2v2 Realistics & Zone
// Wars). The queue pool is shared globally across every guild the bot is installed in
// (cross-server matchmaking) — it is NOT partitioned by guild. Every function below still accepts
// a `guildId` where it did before (so every existing call site keeps working unchanged), but it's
// no longer used to key the pool — only stamped onto the built player/unit for channel routing.
//
// Deliberately independent of queue.js's tournament matching: no Elo, no tournament placement
// data, no party system. A "unit" here is always exactly one solo player — even in 2v2 modes,
// each queuer represents their own team and is matched against one opponent queuer, never
// teamed up with another Discord member (see task spec: "no party system... not a teammate").
//
// Eligibility is gated purely by elapsed wait time off `joinedAt` (no stored timers, so it
// survives a restart), on its own schedule — deliberately independent of tournament.js's
// widening (config.creativeWideningSchedule, not config.matchWideningSchedule):
//   - PR is compared on a log scale (logPR = ln(totalPR + 1) * 100), not raw PR, so the
//     allowed gap means the same thing at low and high PR rather than being dominated by
//     players with huge totals.
//   - Platform restriction is tied to the same tiers as the logPR band: same-platform-only
//     while the band is tight, opening to any platform once it widens.
// Ranking among already-eligible candidates uses matchScore (scraper.js's calculateMatchScore,
// same formula tournaments use — see buildCreativePlayer), not logPR — logPR stays the
// eligibility gate, matchScore just decides which eligible candidate is the closest match.

const { EventEmitter } = require('events');
const { creativeQueues, saveQueues } = require('./store');
const config = require('./config');
const playerStore = require('./players');
const { computeMatchScoreBreakdownWithTierComparison } = require('./scraper');

const MODES = {
  '1v1': ['1v1 Realistics', '1v1 Zone Wars'],
  '2v2': ['2v2 Realistics', '2v2 Zone Wars'],
};

// Which recentEvents rosterSize buildCreativePlayer's form-modifier (scraper.js's
// computeMatchScoreBreakdown formRosterSize) should filter on for a given creative mode string —
// 1v1 wants genuine recent SOLO form, 2v2 wants genuine recent DUO form, each a general "how have
// they been doing in this format lately" signal, not tied to one specific tournament (same
// structural shape solo already used). Falls back to 1 (solo) for anything that isn't a real 1v1/2v2
// mode string (shouldn't happen for a real queue join, but matches computeMatchScoreBreakdown's own
// default rather than silently producing NaN/undefined).
function formRosterSizeForMode(mode) {
  if (MODES['2v2'].includes(mode)) return 2;
  return 1;
}

const REGIONS = ['EU', 'NAC'];

const creativeMatchEvents = new EventEmitter();

function generateUnitId() {
  return `cunit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function getQueue(mode, region) {
  if (!creativeQueues[mode]) creativeQueues[mode] = {};
  if (!Array.isArray(creativeQueues[mode][region])) creativeQueues[mode][region] = [];
  return creativeQueues[mode][region];
}

function isInCreativeQueue(guildId, discordId) {
  return !!findCreativeUnitByDiscordId(guildId, discordId);
}

function findCreativeUnitByDiscordId(guildId, discordId) {
  for (const mode of Object.keys(creativeQueues)) {
    for (const region of Object.keys(creativeQueues[mode])) {
      const unit = getQueue(mode, region).find(u => u.members.some(p => p.discordId === discordId));
      if (unit) return { unit, mode, region };
    }
  }
  return null;
}

function removeFromCreativeQueueAnywhere(guildId, discordId) {
  const found = findCreativeUnitByDiscordId(guildId, discordId);
  if (!found) return false;
  const band = getQueue(found.mode, found.region);
  const index = band.findIndex(u => u.unitId === found.unit.unitId);
  if (index !== -1) {
    band.splice(index, 1);
    saveQueues();
    return true;
  }
  return false;
}

function getCreativeQueueCount(guildId, mode, region) {
  return getQueue(mode, region).length;
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

// Eligibility-gating distance — unchanged by the matchScore ranking switch below.
function logPRDistance(unitA, unitB) {
  return Math.abs(toLogPR(unitA.totalPR) - toLogPR(unitB.totalPR));
}

// Ranking-only distance, used to pick the closest among already-eligible candidates. No
// equivalent of queue.js's prDistancePenalties here — kept simple, just the raw diff.
function scoreDistance(unitA, unitB) {
  return Math.abs(unitA.matchScore - unitB.matchScore);
}

// Single source of truth for both the matching decision and its debug explanation, so the
// "why didn't this pair match" log can never drift out of sync with the actual eligibility
// logic (computed once per pair instead of twice).
function evaluateMatch(unitA, unitB, now) {
  const waitA = (now - new Date(unitA.joinedAt).getTime()) / 1000;
  const waitB = (now - new Date(unitB.joinedAt).getTime()) / 1000;
  const stricterWait = Math.min(waitA, waitB);
  const tier = getCreativeWideningTier(stricterWait);
  const logPRDiff = logPRDistance(unitA, unitB);

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

  return { eligible: true, logPRDiff, scoreDiff: scoreDistance(unitA, unitB), reason: null };
}

function describeUnit(unit) {
  const p = unit.members[0];
  return `${p.discordUsername} (${p.epicUsername})`;
}

// Greedy pairing, same approach as queue.js's attemptMatchingForQueue — fine at realistic
// creative-queue sizes, and runs fully synchronously so overlapping calls can't double-match.
//
// Deliberately reads ONLY unit.totalPR/unit.matchScore (snapshotted once at join time by
// buildCreativePlayer/joinCreativeQueue below) — investigated a real hypothesis that a long-stuck
// queued player (one real report: waited 96477s, ~26.8h, well past players.js's 24h stats cache
// TTL) might get silently re-scraped on every sweep tick once their cache goes stale, which would
// explain sustained scraping traffic with no obvious cause. Confirmed FALSE: this function (and
// queue.js's identical-shape equivalent) never calls playerStore.getPlayerStats or any scraping
// function at all — see test/creative-queue-sweep-no-rescrape.test.js, which proves the fetch
// count stays at exactly 1 across many sweep ticks over a simulated 26+ hour stale wait. The real
// separate bug behind that specific stuck player: config.js's creativeWideningSchedule has no
// unlimited final tier (unlike tournamentWideningSchedule's Infinity tier) — it permanently caps
// at maxLogPRDiff:60 after 25s, so a genuine PR outlier with nobody comparable ever simultaneously
// queued can wait forever with no eventual forced match. Flagged, not fixed here — whether creative
// should ever get an unlimited-widening tier the way tournaments do is a real product decision.
function attemptMatchingForQueue(mode, region) {
  const now = Date.now();
  const pool = getQueue(mode, region);

  if (pool.length === 0) return;

  console.log(`[creative-queue] sweep ${mode}/${region}: ${pool.length} in queue`);
  for (const unit of pool) {
    const wait = (now - new Date(unit.joinedAt).getTime()) / 1000;
    console.log(
      `[creative-queue]   waiting: ${describeUnit(unit)} totalPR=${unit.totalPR} `
      + `logPR=${toLogPR(unit.totalPR).toFixed(1)} matchScore=${unit.matchScore} platform=${unit.members[0].platform} waited=${wait.toFixed(0)}s`
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

        if (result.scoreDiff < bestDiff) {
          bestDiff = result.scoreDiff;
          bestJ = j;
        }
      }

      if (bestJ !== -1) {
        const unitA = pool[i];
        const unitB = pool[bestJ];
        console.log(`[creative-queue] MATCH: ${describeUnit(unitA)} <-> ${describeUnit(unitB)} (matchScore diff ${bestDiff.toFixed(1)}, logPR diff ${logPRDistance(unitA, unitB).toFixed(1)})`);
        pool.splice(Math.max(i, bestJ), 1);
        pool.splice(Math.min(i, bestJ), 1);
        saveQueues();
        creativeMatchEvents.emit('matchFound', { unitA, unitB, mode, region });
        matchedSomething = true;
        break; // pool mutated — restart the scan
      }
    }
  }
}

function sweepAllCreativeQueues() {
  for (const mode of Object.keys(creativeQueues)) {
    for (const region of Object.keys(creativeQueues[mode])) {
      if (getQueue(mode, region).length > 0) {
        attemptMatchingForQueue(mode, region);
      }
    }
  }
}

function startCreativeMatchSweep() {
  setInterval(sweepAllCreativeQueues, config.matchSweepIntervalSeconds * 1000);
}

async function buildCreativePlayer({ guildId, guildName, discordId, discordUsername, discordTag, epicUsername, epicId, mode, region }) {
  // homeRegion (the player's registered region) vs region (the region they're queueing this
  // creative match in) — same distinction queue.js's buildPlayer draws for tournaments, needed so
  // getStatsForContext knows whether this join's region genuinely differs from home (#3).
  const registered = await playerStore.getPlayer(guildId, discordId);
  const homeRegion = registered?.region ?? region;
  // Resolved from the player's own stored profile (#get-roles' select_platform — Player.platforms,
  // an additive 0-2 fact, never a forced PC/Console pick) rather than a caller-supplied argument —
  // this function already fetches `registered` for homeRegion just above, so there's no reason to
  // make every call site fetch it separately too (unlike queue.js's buildPlayer, whose caller
  // already fetches the player doc anyway for ingameRoles/languages, so THAT one still takes
  // platform as a resolved argument — see index.js). tournamentConsoleOnly is always false here,
  // same reasoning as getStatsForContext's call just below.
  const resolvedPlatform = playerStore.resolveQueuePlatform(registered?.platforms, false);

  // Creative queue has no console-exclusive-mode concept the way a tournament's consoleOnly flag
  // does (every mode here is open to any platform) — so tournamentConsoleOnly is always false;
  // only region (never platform segment) can put a Console player on a non-home context here.
  const { stats: playerData, prContext } = await playerStore.getStatsForContext(
    guildId, discordId, epicUsername, epicId,
    { homeRegion, queueRegion: region, platform: resolvedPlatform, tournamentConsoleOnly: false }
  );

  // mode is deliberately the creative mode string (e.g. "1v1 Realistics"), not a real scraped
  // tournament — no scraped event will ever have this name, so ownTournamentModifier correctly
  // comes out to 0 with no special-casing needed. The solo-cup performance modifier and season-PR
  // weighting still apply normally, since neither depends on the name passed here.
  // computeMatchScoreBreakdownWithTierComparison (not the plain sync computeMatchScoreBreakdown) —
  // layers tier-comparison.js's real-band modifier on top; safely inert (adds exactly 0) whenever
  // there isn't yet enough real player data for a valid comparison, per that module's own gating.
  //
  // formRosterSizeForMode(mode) is what actually splits 1v1 from 2v2 scoring — a 1v1 join still
  // gets the solo-form modifier exactly as before (rosterSize 1, the default), a 2v2 join gets the
  // duo-form modifier instead (rosterSize 2, same real-decayed-PR mechanism, just a different team
  // size filtered from the player's own recentEvents). soloModifier below is genuinely a duo-form
  // modifier for a 2v2 join despite the field's name — see computeMatchScoreBreakdown's own doc
  // comment on why that name is kept regardless of formRosterSize.
  const { matchScore, soloModifier } = await computeMatchScoreBreakdownWithTierComparison(playerData, mode, formRosterSizeForMode(mode));

  return {
    guildId,
    guildName,
    discordId,
    discordUsername,
    discordTag,
    epicUsername,
    epicId,
    mode,
    region,
    homeRegion,
    platform: resolvedPlatform,
    totalPR: playerData.totalPR,
    thisSeasonPR: playerData.thisSeasonPR,
    matchScore,
    // Snapshotted here (not just the final matchScore) so feedback.js can persist the exact
    // scoring inputs at match time without re-deriving them later — see scraper.js's
    // computeMatchScoreBreakdown doc comment.
    soloModifier,
    // The region/platform context totalPR/soloModifier/matchScore above were actually computed
    // from — see players.js's getStatsForContext doc comment.
    prContext,
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
    matchScore: player.matchScore,
    joinedAt: new Date(),
  };

  const pool = getQueue(mode, region);
  pool.push(unit);
  saveQueues();

  console.log(
    `[creative-queue] JOIN ${describeUnit(unit)} guild=${guildId} mode=${mode} region=${region} `
    + `totalPR=${player.totalPR} logPR=${toLogPR(player.totalPR).toFixed(1)} platform=${player.platform} `
    + `— ${pool.length} now in queue`
  );

  attemptMatchingForQueue(mode, region);

  return { unit };
}

function requeueCreativeUnit(unit) {
  getQueue(unit.mode, unit.region).push(unit);
  saveQueues();
  attemptMatchingForQueue(unit.mode, unit.region);
}

module.exports = {
  MODES,
  REGIONS,
  formRosterSizeForMode,
  buildCreativePlayer,
  joinCreativeQueue,
  requeueCreativeUnit,
  removeFromCreativeQueueAnywhere,
  findCreativeUnitByDiscordId,
  isInCreativeQueue,
  getCreativeQueueCount,
  sweepAllCreativeQueues,
  startCreativeMatchSweep,
  creativeMatchEvents,
  toLogPR,
  getCreativeWideningTier,
};
