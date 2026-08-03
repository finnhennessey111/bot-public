// Verifies two real changes to the score formula in scraper.js's computeMatchScoreBreakdown:
//
//   #4 — regionPenalty removed entirely. Region-aware PR (#3) now happens upstream, in WHICH data
//   gets scraped (players.js's getStatsForContext resolves the right region BEFORE this function
//   ever runs) — there's no cross-region mismatch left for a formula-level penalty to punish, so
//   computeMatchScoreBreakdown no longer takes homeRegion/queueRegion arguments at all, and
//   config.js no longer has a regionPenalties table.
//
//   #5 — soloModifier is placement-only now (kills dropped). It used to be
//   (placementQuality * 0.7) + (killsQuality * 0.3); confirmed live that ownTournamentModifier was
//   ALREADY placement-only before this change (getPlacementScore only, no kills term at all) — so
//   this change only ever touched soloModifier, never ownTournamentModifier.
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeMatchScoreBreakdown, getPlacementScore } = require('../scraper');
const config = require('../config');

test('config.js: regionPenalties table no longer exists', () => {
  assert.equal(config.regionPenalties, undefined);
});

test('computeMatchScoreBreakdown: no longer accepts (or is affected by) region arguments — same score regardless of what extra args are passed', () => {
  const playerData = {
    totalPR: 500, thisSeasonPR: 100,
    recentEvents: [{ name: 'Solo Cash Cup', placement: 100, rosterSize: 1, elims: 5 }],
  };

  const bare = computeMatchScoreBreakdown(playerData, 'Some Tournament');
  const withStaleRegionArgs = computeMatchScoreBreakdown(playerData, 'Some Tournament', 'ME', 'EU'); // ME->EU used to carry a real 0.25 penalty

  assert.deepEqual(bare, withStaleRegionArgs, 'extra region arguments (even a historically-penalized ME->EU pair) must have zero effect — they are simply ignored now');
});

test('computeMatchScoreBreakdown: soloModifier is placement-only — two players with identical placements but wildly different kills score identically', () => {
  const lowKillsData = {
    totalPR: 500, thisSeasonPR: 100,
    recentEvents: [
      { name: 'Solo Cash Cup A', placement: 250, rosterSize: 1, elims: 0 },
      { name: 'Solo Cash Cup B', placement: 250, rosterSize: 1, elims: 0 },
    ],
  };
  const highKillsData = {
    totalPR: 500, thisSeasonPR: 100,
    recentEvents: [
      { name: 'Solo Cash Cup A', placement: 250, rosterSize: 1, elims: 45 },
      { name: 'Solo Cash Cup B', placement: 250, rosterSize: 1, elims: 45 },
    ],
  };

  const lowKillsResult = computeMatchScoreBreakdown(lowKillsData, '__no_match__');
  const highKillsResult = computeMatchScoreBreakdown(highKillsData, '__no_match__');

  assert.equal(lowKillsResult.soloModifier, highKillsResult.soloModifier, 'kills must have zero effect on soloModifier now');
  assert.equal(lowKillsResult.matchScore, highKillsResult.matchScore);
});

test('computeMatchScoreBreakdown: soloModifier equals placementQuality * 0.35 exactly — the same shape ownTournamentModifier already used (confirms the two are now consistent)', () => {
  const playerData = {
    totalPR: 0, thisSeasonPR: 0, // base=0 isolates soloModifier's raw value in matchScore-independent terms
    recentEvents: [
      { name: 'Solo Cash Cup A', placement: 300, rosterSize: 1, elims: 99 }, // top band -> placementScore 100
      { name: 'Solo Cash Cup B', placement: 300, rosterSize: 1, elims: 0 },
    ],
  };

  const result = computeMatchScoreBreakdown(playerData, '__no_match__');
  const expectedPlacementQuality = (getPlacementScore(300) * 2 / 2) / 100; // both events place identically
  assert.equal(result.soloModifier, expectedPlacementQuality * 0.35);
});

test('computeMatchScoreBreakdown: ownTournamentModifier was already placement-only before this change — unaffected by kills either way', () => {
  const lowKills = {
    totalPR: 500, thisSeasonPR: 100,
    recentEvents: [{ name: 'FNCS Division 2', placement: 100, rosterSize: 3, elims: 0 }],
  };
  const highKills = {
    totalPR: 500, thisSeasonPR: 100,
    recentEvents: [{ name: 'FNCS Division 2', placement: 100, rosterSize: 3, elims: 40 }],
  };

  const lowResult = computeMatchScoreBreakdown(lowKills, 'FNCS Division 2');
  const highResult = computeMatchScoreBreakdown(highKills, 'FNCS Division 2');

  assert.equal(lowResult.ownTournamentModifier, highResult.ownTournamentModifier);
});
