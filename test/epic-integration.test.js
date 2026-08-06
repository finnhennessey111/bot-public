// Verifies the RESILIENCE requirement of the Epic API integration: scraper.js's
// computeMatchScoreBreakdownWithEpic and tournament-scraper.js's enrichWithEpicBuildMode must never
// let an Epic API problem (rate limit, unexpected error, the service being down) become a queue-join
// or channel-creation failure — every gap falls back to the existing Fortnite Tracker-derived
// behavior. epicApi's own functions are stubbed directly (module.exports delegation), not fetchJson,
// since these tests are about the FALLBACK WIRING in scraper.js/tournament-scraper.js, not epic-api.js's
// own parsing (see test/epic-api.test.js for that).
const test = require('node:test');
const assert = require('node:assert/strict');

const scraperModule = require('../scraper');
const tournamentScraperModule = require('../tournament-scraper');
const epicApi = require('../epic-api');
const { computeMatchScoreBreakdown } = scraperModule;

function withStubbedEpicOwnTournamentModifier(stub, fn) {
  const original = epicApi.getEpicOwnTournamentModifier;
  epicApi.getEpicOwnTournamentModifier = stub;
  return fn().finally(() => { epicApi.getEpicOwnTournamentModifier = original; });
}

function withStubbedFindEventEntryByName(stub, fn) {
  const original = epicApi.findEventEntryByName;
  epicApi.findEventEntryByName = stub;
  return fn().finally(() => { epicApi.findEventEntryByName = original; });
}

// computeMatchScoreBreakdownWithEpic now ALSO always runs applyTierComparisonModifier (tier-
// comparison.js) at the end, on every path — this test file never stubs db.isConnected (real DB
// connectivity check tier-comparison.js's getTierComparisonModifier fails fast on), so it's always
// false in this test environment, meaning every real result here carries these two extra fields
// with these exact values. Wrapping the plain FT-only breakdown with them is what makes these
// fallback tests a genuine "identical to the plain result" comparison again, rather than each
// needing its own ad-hoc partial-match assertion.
function expectedWithNoTierSignal(plainBreakdown) {
  return { ...plainBreakdown, tierModifier: 0, tierComparisonHasSignal: false };
}

const PLAYER_DATA = {
  totalPR: 500, thisSeasonPR: 100,
  recentEvents: [{ name: 'Duos Ranked Cup (Zero Build)', placement: 800, rosterSize: 2 }],
};

// tournament.eventId is NOT required anymore — epicApi.getEpicOwnTournamentModifier resolves
// Epic's own real per-region eventId itself now (see epic-api.js's doc comment on why trusting a
// caller-supplied eventId was dropped). Only name/region/accountId gate whether Epic is attempted.
test('computeMatchScoreBreakdownWithEpic: no tournament.region — Epic is never even attempted, result is identical to the plain FT breakdown', async () => {
  const tournament = { name: 'Duos Ranked Cup (Zero Build)' }; // no region
  const result = await scraperModule.computeMatchScoreBreakdownWithEpic(PLAYER_DATA, tournament, 'myaccount');
  const plain = computeMatchScoreBreakdown(PLAYER_DATA, tournament.name);
  assert.deepEqual(result, expectedWithNoTierSignal(plain));
});

test('computeMatchScoreBreakdownWithEpic: eventId absent is NOT a reason to skip Epic anymore — it\'s still attempted (and succeeds) using just name+region', async () => {
  const tournament = { name: 'Duos Ranked Cup (Zero Build)', region: 'EU' }; // no eventId at all
  const epicModifier = 0.30;

  await withStubbedEpicOwnTournamentModifier(async (t) => {
    assert.equal(t.eventId, undefined, 'the caller never even needs to supply an eventId');
    return { modifier: epicModifier, hasHistory: true, source: 'epic', matchedWindows: [] };
  }, async () => {
    const result = await scraperModule.computeMatchScoreBreakdownWithEpic(PLAYER_DATA, tournament, 'myaccount');
    assert.equal(result.ownTournamentSource, 'epic');
  });
});

test('computeMatchScoreBreakdownWithEpic: no accountId — Epic is never even attempted', async () => {
  const tournament = { name: 'Duos Ranked Cup (Zero Build)', eventId: 'epicgames_x_EU', region: 'EU' };
  const result = await scraperModule.computeMatchScoreBreakdownWithEpic(PLAYER_DATA, tournament, null);
  const plain = computeMatchScoreBreakdown(PLAYER_DATA, tournament.name);
  assert.deepEqual(result, expectedWithNoTierSignal(plain));
});

test('computeMatchScoreBreakdownWithEpic: Epic lookup throws — falls back to the FT-derived breakdown, never rejects', async () => {
  const tournament = { name: 'Duos Ranked Cup (Zero Build)', eventId: 'epicgames_x_EU', region: 'EU' };

  await withStubbedEpicOwnTournamentModifier(async () => {
    throw new Error('simulated rate limit (429)');
  }, async () => {
    const result = await scraperModule.computeMatchScoreBreakdownWithEpic(PLAYER_DATA, tournament, 'myaccount');
    const plain = computeMatchScoreBreakdown(PLAYER_DATA, tournament.name);
    assert.deepEqual(result, expectedWithNoTierSignal(plain), 'a thrown Epic error must resolve to the exact same result a plain FT-only call would produce');
  });
});

test('computeMatchScoreBreakdownWithEpic: Epic lookup resolves null (no match/no history) — falls back to the FT-derived breakdown', async () => {
  const tournament = { name: 'Duos Ranked Cup (Zero Build)', eventId: 'epicgames_x_EU', region: 'EU' };

  await withStubbedEpicOwnTournamentModifier(async () => null, async () => {
    const result = await scraperModule.computeMatchScoreBreakdownWithEpic(PLAYER_DATA, tournament, 'myaccount');
    const plain = computeMatchScoreBreakdown(PLAYER_DATA, tournament.name);
    assert.deepEqual(result, expectedWithNoTierSignal(plain));
  });
});

test('computeMatchScoreBreakdownWithEpic: Epic lookup succeeds — its modifier replaces ownTournamentModifier, base/soloModifier stay Fortnite-Tracker-derived (both explicitly kept on FT)', async () => {
  const tournament = { name: 'Duos Ranked Cup (Zero Build)', eventId: 'epicgames_x_EU', region: 'EU' };
  const epicModifier = 0.30; // a real placement-score-derived modifier value

  await withStubbedEpicOwnTournamentModifier(async () => ({
    modifier: epicModifier, hasHistory: true, source: 'epic', matchedWindows: [{ eventWindowId: 'w1', rank: 250, pointsEarned: 400 }],
  }), async () => {
    const result = await scraperModule.computeMatchScoreBreakdownWithEpic(PLAYER_DATA, tournament, 'myaccount');
    const plain = computeMatchScoreBreakdown(PLAYER_DATA, tournament.name);

    assert.equal(result.ownTournamentModifier, epicModifier);
    assert.equal(result.ownTournamentSource, 'epic');
    assert.equal(result.base, plain.base, 'base (PR-only baseline) must stay Fortnite-Tracker-derived, unchanged by Epic');
    assert.equal(result.soloModifier, plain.soloModifier, 'soloModifier must stay Fortnite-Tracker-derived, unchanged by Epic');
    assert.equal(result.matchScore, Math.round(plain.base * (1 + plain.soloModifier + epicModifier)));
  });
});

test('computeMatchScoreBreakdown (plain, sync): its own signature/behavior is unaffected by computeMatchScoreBreakdownWithEpic\'s changes', () => {
  // Regression guard: computeMatchScoreBreakdownWithEpic must be purely additive (built ON TOP of
  // this function, never mutating it). Note: creative-queue.js and elo.js no longer call this plain
  // sync function directly — both now go through the async computeMatchScoreBreakdownWithTierComparison
  // wrapper (scraper.js) so they also pick up tier-comparison.js's real modifier — but that wrapper
  // itself calls this exact function first, so this function's own behavior still has to stay solid.
  const result = computeMatchScoreBreakdown(PLAYER_DATA, 'Duos Ranked Cup (Zero Build)');
  assert.equal(typeof result.matchScore, 'number');
  assert.equal(result.ownTournamentSource, undefined, 'the plain sync path never stamps an Epic source');
  assert.equal('tierModifier' in result, false, 'the plain sync function itself must never gain the async wrapper\'s fields');
});

// ── enrichWithEpicBuildMode (tournament-scraper.js) ─────────────────────────────────────────────

function baseGroup(overrides = {}) {
  return { name: 'Duos Ranked Cup (Zero Build)', region: 'EU', buildMode: 'battle_royale', ...overrides };
}

test('enrichWithEpicBuildMode: no matching Epic calendar entry — group.buildMode is left exactly as the title-based detector set it', async () => {
  await withStubbedFindEventEntryByName(async () => null, async () => {
    const groups = [baseGroup()];
    await tournamentScraperModule.enrichWithEpicBuildMode(groups);
    assert.equal(groups[0].buildMode, 'battle_royale');
  });
});

test('enrichWithEpicBuildMode: Epic lookup throws — group.buildMode is left untouched, never propagates the error', async () => {
  await withStubbedFindEventEntryByName(async () => { throw new Error('simulated API failure'); }, async () => {
    const groups = [baseGroup()];
    await assert.doesNotReject(() => tournamentScraperModule.enrichWithEpicBuildMode(groups));
    assert.equal(groups[0].buildMode, 'battle_royale');
  });
});

test('enrichWithEpicBuildMode: Epic\'s id disagrees with the title-based default — Epic wins', async () => {
  await withStubbedFindEventEntryByName(async (name) => {
    assert.equal(name, 'Duos Ranked Cup (Zero Build)');
    return { id: 'Season41_RankedCupDuosZB', name, regions: { EU: [{ eventWindows: [] }] } };
  }, async () => {
    // Title-based detection wrongly said battle_royale (e.g. a title-text edge case) — Epic's id
    // clearly says zero_build, so the override should win.
    const groups = [baseGroup({ buildMode: 'battle_royale' })];
    await tournamentScraperModule.enrichWithEpicBuildMode(groups);
    assert.equal(groups[0].buildMode, 'zero_build');
  });
});

test('enrichWithEpicBuildMode: Epic\'s id has no explicit marker (real counter-example: shared id across build-mode variants) — leaves the title-based default alone', async () => {
  await withStubbedFindEventEntryByName(async () => ({ id: 'S41_FNCSCommunityCup', name: 'Champion Aphrodite FNCS Cup', regions: { EU: [{ eventWindows: [] }] } }), async () => {
    const groups = [baseGroup({ name: 'Champion Aphrodite FNCS Cup', buildMode: 'battle_royale' })];
    await tournamentScraperModule.enrichWithEpicBuildMode(groups);
    assert.equal(groups[0].buildMode, 'battle_royale', 'no Epic signal at all means the existing title-based value must survive unchanged');
  });
});
