// Verifies one real change to the score formula in scraper.js's computeMatchScoreBreakdown that
// predates (and survives unaffected by) tonight's PR-native restructure — see
// test/pr-native-score-formula.test.js for that:
//
//   #4 — regionPenalty removed entirely. Region-aware PR (#3) now happens upstream, in WHICH data
//   gets scraped (players.js's getStatsForContext resolves the right region BEFORE this function
//   ever runs) — there's no cross-region mismatch left for a formula-level penalty to punish, so
//   computeMatchScoreBreakdown no longer takes homeRegion/queueRegion arguments at all, and
//   config.js no longer has a regionPenalties table.
//
// The other two tests this file used to have (soloModifier being placement-only, and matching
// ownTournamentModifier's shape via getPlacementScore) asserted the OLD placement-bucket mechanism
// directly — getPlacementScore no longer exists at all (removed as part of the PR-native
// restructure, superseded by each event's own decayed prPoints), so those assertions are gone, not
// just updated; the underlying real-world claim they made ("kills have zero effect on soloModifier")
// is re-verified under the new mechanism in test/pr-native-score-formula.test.js instead.
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeMatchScoreBreakdown } = require('../scraper');
const config = require('../config');

test('config.js: regionPenalties table no longer exists', () => {
  assert.equal(config.regionPenalties, undefined);
});

test('computeMatchScoreBreakdown: no longer accepts (or is affected by) region arguments — same score regardless of what extra args are passed', () => {
  const playerData = {
    totalPR: 500,
    recentEvents: [{ name: 'Solo Cash Cup', placement: 100, prPoints: 40, rosterSize: 1, elims: 5 }],
  };

  const bare = computeMatchScoreBreakdown(playerData, 'Some Tournament');
  const withStaleRegionArgs = computeMatchScoreBreakdown(playerData, 'Some Tournament', 'ME', 'EU'); // ME->EU used to carry a real 0.25 penalty

  assert.deepEqual(bare, withStaleRegionArgs, 'extra region arguments (even a historically-penalized ME->EU pair) must have zero effect — they are simply ignored now');
});
