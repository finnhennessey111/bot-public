// Verifies tonight's PR-native scoring restructure: Total = Current PR × (1 + soloModifier +
// ownTournamentModifier). No more (totalPR*10 + thisSeasonPR*5) blended base — thisSeasonPR is
// removed from the formula entirely (a deliberate design call, not an oversight), and
// soloModifier/ownTournamentModifier are now genuine percentage boosts on Current PR (each
// qualifying event's own already-decayed prPoints as a fraction of currentPR), not a 0-100
// placement-bucket score applied on top of a pre-scaled base.
//
// prPoints being already-decayed (not something needing a separate decay curve built on top) was
// confirmed via a real live scrape this session, not assumed: account mdemprcheck (EU), event
// "Solo Series Qualifiers" (Dec 21, 2025) — raw window.powerRankingData.points = 8.26 against a
// pointsNoDecay of 11.8 (an 11.8-8.26 = 3.54 point real recorded decay loss); "Solo Cash Cup" (Mar
// 14, 2025) — points = 4.86 against pointsNoDecay 16.2 (16.2-4.86 = 11.34 loss). Both real numbers
// used as fixtures below, not made up.
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeMatchScoreBreakdown, computeOwnTournamentModifier } = require('../scraper');
const epicApi = require('../epic-api');

function withStubbedFindEventEntryByName(stub, fn) {
  const original = epicApi.findEventEntryByName;
  epicApi.findEventEntryByName = stub;
  return fn().finally(() => { epicApi.findEventEntryByName = original; });
}
function withStubbedGetPlayerEventMatches(stub, fn) {
  const original = epicApi.getPlayerEventMatches;
  epicApi.getPlayerEventMatches = stub;
  return fn().finally(() => { epicApi.getPlayerEventMatches = original; });
}

test('computeMatchScoreBreakdown: a player with zero modifiers scores EXACTLY their raw Current PR — no hidden ×10 anywhere', () => {
  const result = computeMatchScoreBreakdown({ totalPR: 623, recentEvents: [] }, 'Some Cup');
  assert.equal(result.matchScore, 623);
  assert.equal(result.base, 623);
});

test('computeMatchScoreBreakdown: thisSeasonPR is completely absent from the formula — a huge value has zero effect', () => {
  const withoutSeasonPR = computeMatchScoreBreakdown({ totalPR: 500, recentEvents: [] }, 'Cup');
  const withHugeSeasonPR = computeMatchScoreBreakdown({ totalPR: 500, thisSeasonPR: 999999, recentEvents: [] }, 'Cup');
  assert.deepEqual(withoutSeasonPR, withHugeSeasonPR);
});

test('computeMatchScoreBreakdown: real decayed prPoints (mdemprcheck\'s Solo Series Qualifiers, Solo Cash Cup) are used directly, not re-decayed or double-counted', () => {
  const playerData = {
    totalPR: 557, // this account's real live totalPR at time of scraping
    recentEvents: [
      { name: 'Solo Series Qualifiers', date: '2025-12-21', placement: 4089, prPoints: 8.26, rosterSize: 1 },
      { name: 'Solo Cash Cup', date: '2025-03-14', placement: 2124, prPoints: 4.86, rosterSize: 1 },
    ],
  };

  const result = computeMatchScoreBreakdown(playerData, '__no_tournament_match__');
  const expectedAvgPrPoints = (8.26 + 4.86) / 2;
  const expectedSoloModifier = (expectedAvgPrPoints / 557) * 0.35;

  assert.equal(result.soloModifier, expectedSoloModifier, 'must use the real prPoints values directly (8.26, 4.86), not pointsNoDecay (11.8, 16.2) or a re-derived decay curve');
  assert.equal(result.matchScore, Math.round(557 * (1 + expectedSoloModifier)));
});

test('computeMatchScoreBreakdown: ownTournamentModifier is also expressed as a percentage of Current PR using real decayed prPoints', () => {
  const playerData = {
    totalPR: 800,
    recentEvents: [
      { name: 'FNCS Division 2', placement: 8, prPoints: 120, rosterSize: 3 },
      { name: 'FNCS Division 2', placement: 25, prPoints: 60, rosterSize: 3 },
    ],
  };
  const result = computeMatchScoreBreakdown(playerData, 'FNCS Division 2');
  const expectedModifier = ((120 + 60) / 2 / 800) * 0.30;
  assert.equal(result.ownTournamentModifier, expectedModifier);
});

test('computeMatchScoreBreakdown: no-history cases still fall back to base-only, zero modifier contribution — unchanged behavior under the new shape', () => {
  const playerData = { totalPR: 400, recentEvents: [{ name: 'Unrelated Cup', placement: 50, prPoints: 30, rosterSize: 2 }] };
  const result = computeMatchScoreBreakdown(playerData, 'A Tournament With No History');
  assert.equal(result.ownTournamentModifier, 0);
  assert.equal(result.soloModifier, 0, 'no rosterSize===1 events at all -> soloModifier stays 0 too');
  assert.equal(result.matchScore, 400, 'base-PR-only, never a penalty for having no history');
});

test('computeOwnTournamentModifier: no-history returns hasHistory:false and modifier 0, not a crash, when currentPR is provided', () => {
  const result = computeOwnTournamentModifier([{ name: 'Other Cup', prPoints: 50 }], e => e.name === 'Nonexistent', 600);
  assert.equal(result.hasHistory, false);
  assert.equal(result.modifier, 0);
});

test('computeMatchScoreBreakdown: currentPR of 0 (brand new/unlinked account) never divides by zero — modifiers stay 0, no NaN/Infinity', () => {
  const playerData = {
    totalPR: 0,
    recentEvents: [
      { name: 'Solo Cash Cup', placement: 100, prPoints: 40, rosterSize: 1 },
      { name: 'My Tournament', placement: 5, prPoints: 90, rosterSize: 2 },
    ],
  };
  const result = computeMatchScoreBreakdown(playerData, 'My Tournament');
  assert.equal(result.soloModifier, 0);
  assert.equal(result.ownTournamentModifier, 0);
  assert.equal(result.matchScore, 0);
  assert.ok(Number.isFinite(result.matchScore));
});

test('computeMatchScoreBreakdown: kills/elims still have zero effect on soloModifier — confirmed under the new prPoints-based mechanism, not just the old placement-bucket one', () => {
  const base = { totalPR: 500, recentEvents: [{ name: 'Solo Cash Cup', placement: 250, prPoints: 40, rosterSize: 1, elims: 0 }] };
  const highKills = { totalPR: 500, recentEvents: [{ name: 'Solo Cash Cup', placement: 250, prPoints: 40, rosterSize: 1, elims: 45 }] };
  const lowResult = computeMatchScoreBreakdown(base, '__no_match__');
  const highResult = computeMatchScoreBreakdown(highKills, '__no_match__');
  assert.equal(lowResult.soloModifier, highResult.soloModifier);
  assert.equal(lowResult.matchScore, highResult.matchScore);
});

// ── Epic ownTournamentModifier enrichment: also PR-native now ──────────────────────────────────

test('epic-api.js getEpicOwnTournamentModifier: uses pointsEarned (Epic\'s own real per-window PR points) as a fraction of currentPR — no placement-bucket conversion', async () => {
  await withStubbedFindEventEntryByName(async () => ({
    id: 'Season41_RankedCupDuosZB', name: 'Duos Ranked Cup (Zero Build)',
    regions: { EU: [{ eventId: 'epicgames_x_EU', eventWindows: [{ eventWindowId: 'w1', endTime: new Date(Date.now() - 86400000).toISOString() }] }] },
  }), async () => {
    await withStubbedGetPlayerEventMatches(async () => ({ found: true, eventWindowId: 'w1', rank: 250, pointsEarned: 90 }), async () => {
      const tournament = { name: 'Duos Ranked Cup (Zero Build)', region: 'EU' };
      const result = await epicApi.getEpicOwnTournamentModifier(tournament, 'myaccount', 600);
      assert.equal(result.modifier, (90 / 600) * 0.30);
      assert.equal(result.source, 'epic');
    });
  });
});

test('epic-api.js getEpicOwnTournamentModifier: currentPR <= 0 returns null rather than dividing by zero', async () => {
  const result = await epicApi.getEpicOwnTournamentModifier({ name: 'X', region: 'EU' }, 'acc', 0);
  assert.equal(result, null);
});

test('scraper.js computeMatchScoreBreakdownWithEpic: Epic\'s PR-native modifier flows into the SAME PR-native matchScore formula as the plain FT path', async () => {
  const { computeMatchScoreBreakdownWithEpic } = require('../scraper');
  const playerData = { totalPR: 500, recentEvents: [] };
  const tournament = { name: 'Duos Ranked Cup (Zero Build)', region: 'EU' };

  const original = epicApi.getEpicOwnTournamentModifier;
  epicApi.getEpicOwnTournamentModifier = async (t, acc, currentPR) => {
    assert.equal(currentPR, 500, 'currentPR (base) must be threaded through from the FT breakdown, not re-derived');
    return { modifier: 0.18, hasHistory: true, source: 'epic', matchedWindows: [] };
  };
  try {
    const result = await computeMatchScoreBreakdownWithEpic(playerData, tournament, 'myaccount');
    assert.equal(result.matchScore, Math.round(500 * (1 + 0 + 0.18)), 'must be genuinely PR-native — no ×-scaled base hiding in the Epic path either');
    assert.equal(result.ownTournamentSource, 'epic');
  } finally {
    epicApi.getEpicOwnTournamentModifier = original;
  }
});
