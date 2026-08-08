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

test('computeMatchScoreBreakdown: no longer accepts (or is affected by) region arguments — a stale 4th+ positional arg has zero effect', () => {
  const playerData = {
    totalPR: 500,
    recentEvents: [{ name: 'Solo Cash Cup', placement: 100, prPoints: 40, rosterSize: 1, elims: 5 }],
  };

  // The 3rd positional argument is now formRosterSize (added for creative-queue.js's 1v1/2v2
  // split — see test/creative-1v1-2v2-score-split.test.js), so it's deliberately left at its
  // default (1) here rather than reused for this test's own point; only a 4th+ position (the old
  // queueRegion slot) is what this test needs to prove is dead/ignored.
  const bare = computeMatchScoreBreakdown(playerData, 'Some Tournament');
  const withStaleRegionArg = computeMatchScoreBreakdown(playerData, 'Some Tournament', undefined, 'EU'); // 'EU' used to be queueRegion, carrying a real cross-region penalty

  assert.deepEqual(bare, withStaleRegionArg, 'a stale 4th positional argument (even a historically-penalized region value) must have zero effect — it is simply ignored now');
});
