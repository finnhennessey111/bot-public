// Verifies the tier-comparison system (tier-comparison.js): now wired into every live scoring path
// (scraper.js's computeMatchScoreBreakdownWithEpic/WithTierComparison) — measures whether a
// player's real recent behavior (trend, consistency, window-average decayed PR) more closely
// resembles the PR band above them than their own band, gated so it can only ever produce a real
// result once BOTH the player's own band and the next band up have enough real, signal-contributing
// players (MIN_BAND_PLAYERS). Real registered player count is confirmed under 20 total right now, so
// in production this is expected to return hasSignal:false for everyone for a long time — that's
// the safe, correct default this suite specifically checks for, not something being worked around.
//
// PlayerModel/TierBandStatsModel are stubbed directly (same "stub the Model, not the module"
// precedent as test/elo-endpoint.test.js's stubPlayerFind / test/tournament-channel-visibility.test.js's
// DeletedTournamentChannelModel stub) — no real MongoDB connection needed. db.isConnected() is also
// stubbed true for the getTierComparisonModifier tests below: that check exists so a real,
// unconfigured/down connection fails fast instead of hanging on a real Mongoose query (this now runs
// on every live queue join / elo lookup, not just the once-daily batch job) — in this disconnected
// test environment it would otherwise short-circuit every stubbed-band test straight to
// hasSignal:false before ever reaching the stub, which is a real, separately-verified behavior of
// its own (see the dedicated "database not connected" test), not what most of these tests are about.
const test = require('node:test');
const assert = require('node:assert/strict');

const tierComparison = require('../tier-comparison');
const {
  MIN_EVENTS_FOR_TIER_SIGNAL, TIER_WINDOW_SIZE, BAND_WIDTH_PR, MIN_BAND_PLAYERS, MAX_TIER_MODIFIER,
  computeWindowStats, computeEfficiency, bandRangeForPR, computeBandStatsFromPlayers,
  runDailyTierBandComputation, getTierComparisonModifier,
} = tierComparison;

const PlayerModel = require('../models/Player');
const TierBandStatsModel = require('../models/TierBandStats');
const db = require('../db');

// Independent cross-checks (not just asserting the module agrees with itself) for the two real
// statistics computeWindowStats derives — mirrors this codebase's established precedent
// (test/pr-native-score-formula.test.js's expectedVsBaselinePercent, etc.).
function expectedAverage(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function expectedSlope(valuesOldestFirst) {
  const n = valuesOldestFirst.length;
  const xs = valuesOldestFirst.map((_, i) => i);
  const sumX = expectedAverage(xs) * n;
  const sumY = expectedAverage(valuesOldestFirst) * n;
  const sumXY = xs.reduce((sum, x, i) => sum + x * valuesOldestFirst[i], 0);
  const sumXX = xs.reduce((sum, x) => sum + x * x, 0);
  return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
}

function eventWithPR(pr, date) {
  return { name: 'Some Cup', date, prPoints: pr, rosterSize: 2, placement: 10 };
}

// ── computeWindowStats ──────────────────────────────────────────────────────
test('computeWindowStats: fewer than MIN_EVENTS_FOR_TIER_SIGNAL qualifying events returns null, not a zeroed/partial object', () => {
  const events = Array.from({ length: MIN_EVENTS_FOR_TIER_SIGNAL - 1 }, (_, i) => eventWithPR(50, `2026-07-${20 - i}`));
  assert.equal(computeWindowStats(events), null);
});

test('computeWindowStats: events with prPoints of 0 or non-numeric are excluded from qualification entirely', () => {
  const events = [
    eventWithPR(50, '2026-07-30'), eventWithPR(0, '2026-07-29'), { ...eventWithPR(NaN, '2026-07-28') },
    eventWithPR(50, '2026-07-27'), eventWithPR(50, '2026-07-26'), eventWithPR(50, '2026-07-25'),
  ];
  // Only 4 real qualifying events (the 0/NaN ones excluded) — below MIN_EVENTS_FOR_TIER_SIGNAL (5).
  assert.equal(computeWindowStats(events), null);
});

test('computeWindowStats: exactly MIN_EVENTS_FOR_TIER_SIGNAL qualifying events produces a real result — the floor is inclusive', () => {
  // newest-first, real Tracker-decayed values, a clean +5-per-event upward trend once chronological.
  const events = [
    eventWithPR(50, '2026-07-30'), eventWithPR(45, '2026-07-29'), eventWithPR(40, '2026-07-28'),
    eventWithPR(35, '2026-07-27'), eventWithPR(30, '2026-07-26'),
  ];
  const result = computeWindowStats(events);
  assert.ok(result, 'exactly the floor of 5 qualifying events must still produce a real result');
  assert.equal(result.sampleSize, 5);

  const chronological = [30, 35, 40, 45, 50]; // oldest -> newest
  assert.equal(result.avgLevel, expectedAverage(chronological));
  assert.equal(result.trend, expectedSlope(chronological));
  assert.ok(result.trend > 0, 'a real upward trajectory (30->50 across the window) must show a positive slope');

  const expectedStdDev = Math.sqrt(expectedAverage(chronological.map(v => (v - expectedAverage(chronological)) ** 2)));
  assert.equal(result.consistency, expectedStdDev / expectedAverage(chronological));
});

test('computeWindowStats: caps at TIER_WINDOW_SIZE even when far more qualifying events exist — extra older events never influence the result', () => {
  // 15 events all at 100 PR, except the 11th-newest (index 10, OUTSIDE the 10-event window) at
  // 999999 — if the cap didn't work, this absurd outlier would blow out avgLevel/consistency.
  const events = Array.from({ length: 15 }, (_, i) => eventWithPR(i === 10 ? 999999 : 100, `2026-07-${30 - i}`));
  const result = computeWindowStats(events);
  assert.equal(result.sampleSize, TIER_WINDOW_SIZE);
  assert.equal(result.avgLevel, 100, 'the out-of-window outlier must have zero effect on the result');
  assert.equal(result.trend, 0, 'a genuinely flat in-window history must show zero trend');
});

test('computeWindowStats: a real declining trajectory shows a negative trend', () => {
  const events = [
    eventWithPR(10, '2026-07-30'), eventWithPR(20, '2026-07-29'), eventWithPR(30, '2026-07-28'),
    eventWithPR(40, '2026-07-27'), eventWithPR(50, '2026-07-26'),
  ];
  const result = computeWindowStats(events);
  assert.ok(result.trend < 0, 'newest events scoring LOWER than older ones must show a negative slope');
});

test('computeWindowStats: perfectly flat prPoints across the window gives zero trend and zero consistency (CV) — a genuinely maximally-consistent real case', () => {
  const events = Array.from({ length: 6 }, (_, i) => eventWithPR(75, `2026-07-${25 - i}`));
  const result = computeWindowStats(events);
  assert.equal(result.trend, 0);
  assert.equal(result.consistency, 0, 'zero variance across a flat window must show as zero CV, not null or NaN');
});

// ── computeEfficiency — the fourth factor ─────────────────────────────────────
test('computeEfficiency: a real positive totalPR/sessions pair returns the genuine PR-per-session ratio', () => {
  assert.equal(computeEfficiency(500, 100), 5);
  assert.equal(computeEfficiency(392, 392), 1);
});

test('computeEfficiency: null (never 0 or a fabricated ratio) whenever sessions is missing/zero or totalPR isn\'t a real positive number', () => {
  assert.equal(computeEfficiency(500, 0), null, 'zero sessions must not divide-by-zero into Infinity or silently become 0');
  assert.equal(computeEfficiency(500, null), null);
  assert.equal(computeEfficiency(500, undefined), null, 'a player scraped before Sessions existed (field genuinely absent) must not fabricate a ratio');
  assert.equal(computeEfficiency(0, 100), null);
  assert.equal(computeEfficiency(null, 100), null);
});

// ── bandRangeForPR ───────────────────────────────────────────────────────────
test('bandRangeForPR: assigns a PR value to the correct band, and the next band\'s bandMin is exactly this band\'s bandMax', () => {
  const mid = Math.floor(BAND_WIDTH_PR * 2.5); // comfortably inside the 3rd band (0-indexed 2nd)
  const { bandMin, bandMax } = bandRangeForPR(mid);
  assert.equal(bandMin, BAND_WIDTH_PR * 2);
  assert.equal(bandMax, BAND_WIDTH_PR * 3);

  const nextBand = bandRangeForPR(bandMax); // a PR value exactly at the boundary
  assert.equal(nextBand.bandMin, bandMax, 'the boundary PR value must belong to the NEXT band, not linger in the previous one');
});

test('bandRangeForPR: a null/undefined/zero PR resolves to the lowest band (0), never throws', () => {
  assert.deepEqual(bandRangeForPR(0), { bandMin: 0, bandMax: BAND_WIDTH_PR });
  assert.deepEqual(bandRangeForPR(null), { bandMin: 0, bandMax: BAND_WIDTH_PR });
  assert.deepEqual(bandRangeForPR(undefined), { bandMin: 0, bandMax: BAND_WIDTH_PR });
});

// ── computeBandStatsFromPlayers ───────────────────────────────────────────────
function playerWithFlatHistory(totalPR, pr, count = 6) {
  return { totalPR, recentEvents: Array.from({ length: count }, (_, i) => eventWithPR(pr, `2026-07-${25 - i}`)) };
}

test('computeBandStatsFromPlayers: groups real players into the correct bands and averages only signal-contributing ones', () => {
  const players = [
    playerWithFlatHistory(50, 40),   // band 0
    playerWithFlatHistory(150, 60),  // band 0
    playerWithFlatHistory(BAND_WIDTH_PR + 50, 80), // next band up
    { totalPR: 90, recentEvents: [eventWithPR(40, '2026-07-30')] }, // band 0, but too little history -> excluded
  ];
  const bands = computeBandStatsFromPlayers(players);

  const band0 = bands.find(b => b.bandMin === 0);
  assert.equal(band0.playerCount, 2, 'only the 2 real players with enough history count, not the 3rd who nominally falls in this PR range');
  assert.equal(band0.avgLevel, expectedAverage([40, 60]));

  const band1 = bands.find(b => b.bandMin === BAND_WIDTH_PR);
  assert.equal(band1.playerCount, 1);
  assert.equal(band1.avgLevel, 80);
});

test('computeBandStatsFromPlayers: an empty real player list produces zero bands, not a crash', () => {
  assert.deepEqual(computeBandStatsFromPlayers([]), []);
});

test('computeBandStatsFromPlayers: avgEfficiency is computed only from players with a real sessions count — same null-tolerant pattern as avgConsistency', () => {
  const players = [
    { ...playerWithFlatHistory(50, 40), sessions: 8 },   // efficiency 50/8 = 6.25
    { ...playerWithFlatHistory(50, 60), sessions: 20 },  // efficiency 50/20 = 2.5
    { ...playerWithFlatHistory(50, 50) },                // no sessions at all
  ];
  const bands = computeBandStatsFromPlayers(players);
  const band0 = bands.find(b => b.bandMin === 0);

  assert.equal(band0.playerCount, 3, 'all 3 still count toward playerCount/avgLevel — missing sessions only affects avgEfficiency specifically');
  assert.equal(band0.avgEfficiency, expectedAverage([6.25, 2.5]), 'only the 2 real efficiency values are averaged; the player missing sessions contributes nothing to this one factor');
});

test('computeBandStatsFromPlayers: a band where NO player has a real sessions count gets avgEfficiency: null, not NaN or a fabricated 0', () => {
  const players = [playerWithFlatHistory(50, 40), playerWithFlatHistory(50, 60)];
  const bands = computeBandStatsFromPlayers(players);
  assert.equal(bands.find(b => b.bandMin === 0).avgEfficiency, null);
});

// ── runDailyTierBandComputation: the daily batch job ─────────────────────────
function stubPlayerFind(players) {
  return () => ({ lean: async () => players });
}

test('runDailyTierBandComputation: reads real players via players.js\'s existing getAllScoredPlayers (no duplicated dedup logic) and replaces TierBandStats entirely', async () => {
  const originalFind = PlayerModel.find;
  const originalDeleteMany = TierBandStatsModel.deleteMany;
  const originalInsertMany = TierBandStatsModel.insertMany;

  const players = Array.from({ length: MIN_BAND_PLAYERS + 5 }, (_, i) => ({
    epicId: `acc-${i}`, totalPR: 40, recentEvents: Array.from({ length: 6 }, (_, j) => eventWithPR(50, `2026-07-${25 - j}`)),
  }));
  PlayerModel.find = stubPlayerFind(players);
  let deletedCall = false;
  let insertedDocs = null;
  TierBandStatsModel.deleteMany = async () => { deletedCall = true; };
  TierBandStatsModel.insertMany = async (docs) => { insertedDocs = docs; };

  try {
    const result = await runDailyTierBandComputation();
    assert.equal(result.totalPlayers, MIN_BAND_PLAYERS + 5);
    assert.equal(result.bandsComputed, 1);
    assert.ok(deletedCall, 'must clear the collection before writing fresh derived stats — this is a fully-derived collection, never incrementally patched');
    assert.equal(insertedDocs.length, 1);
    assert.equal(insertedDocs[0].playerCount, MIN_BAND_PLAYERS + 5);
  } finally {
    PlayerModel.find = originalFind;
    TierBandStatsModel.deleteMany = originalDeleteMany;
    TierBandStatsModel.insertMany = originalInsertMany;
  }
});

test('runDailyTierBandComputation: zero real bands with enough signal skips insertMany entirely (still clears stale data)', async () => {
  const originalFind = PlayerModel.find;
  const originalDeleteMany = TierBandStatsModel.deleteMany;
  const originalInsertMany = TierBandStatsModel.insertMany;

  PlayerModel.find = stubPlayerFind([]); // real current state: confirmed under 20 total players
  let deletedCall = false;
  let insertManyCalled = false;
  TierBandStatsModel.deleteMany = async () => { deletedCall = true; };
  TierBandStatsModel.insertMany = async () => { insertManyCalled = true; };

  try {
    const result = await runDailyTierBandComputation();
    assert.equal(result.bandsComputed, 0);
    assert.ok(deletedCall);
    assert.ok(!insertManyCalled, 'insertMany with an empty array is pointless — must be skipped, not called with []');
  } finally {
    PlayerModel.find = originalFind;
    TierBandStatsModel.deleteMany = originalDeleteMany;
    TierBandStatsModel.insertMany = originalInsertMany;
  }
});

// ── getTierComparisonModifier: the real per-player gated comparison ──────────
function stubBandLookup(bandsByMin) {
  const originalFindOne = TierBandStatsModel.findOne;
  const originalIsConnected = db.isConnected;
  TierBandStatsModel.findOne = ({ bandMin }) => ({ lean: async () => bandsByMin[bandMin] ?? null });
  // Every real caller of getTierComparisonModifier now goes through db.isConnected() first (fails
  // fast rather than hanging on a real Mongoose query against this disconnected test environment) —
  // stubbed true here so these tests actually exercise the stubbed TierBandStatsModel.findOne above,
  // not just the fail-fast path (that's covered separately, see the "database not connected" test).
  db.isConnected = () => true;
  return () => { TierBandStatsModel.findOne = originalFindOne; db.isConnected = originalIsConnected; };
}

test('getTierComparisonModifier: a player with too little real history gets hasSignal:false and modifier 0, never a DB lookup', async () => {
  const restore = stubBandLookup({}); // if this got called at all with an unexpected key, lean() would return null anyway — real point is the function must return before ever needing valid bands
  try {
    const result = await getTierComparisonModifier({ totalPR: 500, recentEvents: [] });
    assert.equal(result.hasSignal, false);
    assert.equal(result.modifier, 0);
  } finally {
    restore();
  }
});

test('getTierComparisonModifier: own band below MIN_BAND_PLAYERS -> zero modifier, plain PR-native fallback (the real-world default right now)', async () => {
  const player = playerWithFlatHistory(50, 60);
  const restore = stubBandLookup({
    0: { bandMin: 0, bandMax: BAND_WIDTH_PR, playerCount: MIN_BAND_PLAYERS - 1, avgLevel: 55, avgTrend: 0, avgConsistency: 0.1 },
    [BAND_WIDTH_PR]: { bandMin: BAND_WIDTH_PR, bandMax: BAND_WIDTH_PR * 2, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 90, avgTrend: 2, avgConsistency: 0.05 },
  });
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.hasSignal, false);
    assert.equal(result.modifier, 0);
    assert.match(result.reason, /own PR band/i);
  } finally {
    restore();
  }
});

test('getTierComparisonModifier: next band up below MIN_BAND_PLAYERS -> zero modifier, even though the player\'s OWN band is valid', async () => {
  const player = playerWithFlatHistory(50, 60);
  const restore = stubBandLookup({
    0: { bandMin: 0, bandMax: BAND_WIDTH_PR, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 55, avgTrend: 0, avgConsistency: 0.1 },
    [BAND_WIDTH_PR]: { bandMin: BAND_WIDTH_PR, bandMax: BAND_WIDTH_PR * 2, playerCount: MIN_BAND_PLAYERS - 1, avgLevel: 90, avgTrend: 2, avgConsistency: 0.05 },
  });
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.hasSignal, false);
    assert.equal(result.modifier, 0);
    assert.match(result.reason, /next PR band/i);
  } finally {
    restore();
  }
});

test('getTierComparisonModifier: both bands missing entirely (no document at all) -> zero modifier, not a crash', async () => {
  const player = playerWithFlatHistory(50, 60);
  const restore = stubBandLookup({});
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.hasSignal, false);
    assert.equal(result.modifier, 0);
  } finally {
    restore();
  }
});

test('getTierComparisonModifier: a player whose real measured stats sit exactly AT their own band\'s average scores zero resemblance — genuinely typical for their tier, no bonus', async () => {
  // Flat 55-PR history across the window -> avgLevel 55, trend 0, consistency 0 — set to EXACTLY
  // match ownBand's own averages below.
  const player = playerWithFlatHistory(50, 55);
  const restore = stubBandLookup({
    0: { bandMin: 0, bandMax: BAND_WIDTH_PR, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 55, avgTrend: 0, avgConsistency: 0 },
    [BAND_WIDTH_PR]: { bandMin: BAND_WIDTH_PR, bandMax: BAND_WIDTH_PR * 2, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 90, avgTrend: 5, avgConsistency: 0.2 },
  });
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.hasSignal, true);
    assert.equal(result.resemblance, 0);
    assert.equal(result.modifier, 0);
  } finally {
    restore();
  }
});

test('getTierComparisonModifier: a player whose real measured stats sit exactly AT the next band\'s average gets the FULL modifier — genuinely resembles the tier above, capped at MAX_TIER_MODIFIER', async () => {
  // Flat 90-PR history -> avgLevel 90, trend 0, consistency 0. Own band average is 55/0/0 (this
  // player is far above it); next band average is set to EXACTLY match this player's real numbers.
  const player = playerWithFlatHistory(50, 90);
  const restore = stubBandLookup({
    0: { bandMin: 0, bandMax: BAND_WIDTH_PR, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 55, avgTrend: -2, avgConsistency: 0.3 },
    [BAND_WIDTH_PR]: { bandMin: BAND_WIDTH_PR, bandMax: BAND_WIDTH_PR * 2, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 90, avgTrend: 0, avgConsistency: 0 },
  });
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.hasSignal, true);
    assert.equal(result.resemblance, 1, 'trend/consistency both land exactly at the next band\'s average too (0/0), and avgLevel resemblance alone would already be 1');
    assert.equal(result.modifier, MAX_TIER_MODIFIER);
  } finally {
    restore();
  }
});

test('getTierComparisonModifier: a player HALFWAY between their own band and the next gets a scaled modifier, not a binary jump', async () => {
  // avgLevel halfway between ownBand.avgLevel (40) and nextBand.avgLevel (80) is 60.
  const player = playerWithFlatHistory(50, 60);
  const restore = stubBandLookup({
    0: { bandMin: 0, bandMax: BAND_WIDTH_PR, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 40, avgTrend: 0, avgConsistency: 0 },
    [BAND_WIDTH_PR]: { bandMin: BAND_WIDTH_PR, bandMax: BAND_WIDTH_PR * 2, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 80, avgTrend: 0, avgConsistency: 0 },
  });
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.hasSignal, true);
    assert.equal(result.resemblance, 0.5, 'exactly halfway between the two real band averages must resolve to 0.5, not round to 0 or 1');
    assert.equal(result.modifier, MAX_TIER_MODIFIER * 0.5);
  } finally {
    restore();
  }
});

test('getTierComparisonModifier: a player BELOW their own band\'s average is clamped to zero resemblance, never negative', async () => {
  const player = playerWithFlatHistory(50, 20); // well below ownBand's avgLevel of 55
  const restore = stubBandLookup({
    0: { bandMin: 0, bandMax: BAND_WIDTH_PR, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 55, avgTrend: 0, avgConsistency: 0 },
    [BAND_WIDTH_PR]: { bandMin: BAND_WIDTH_PR, bandMax: BAND_WIDTH_PR * 2, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 90, avgTrend: 0, avgConsistency: 0 },
  });
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.resemblance, 0);
    assert.equal(result.modifier, 0);
  } finally {
    restore();
  }
});

test('getTierComparisonModifier: a player far PAST the next band\'s average is capped at 1.0 resemblance, never extrapolated beyond', async () => {
  const player = playerWithFlatHistory(50, 500); // way past nextBand's avgLevel of 90
  const restore = stubBandLookup({
    0: { bandMin: 0, bandMax: BAND_WIDTH_PR, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 55, avgTrend: 0, avgConsistency: 0 },
    [BAND_WIDTH_PR]: { bandMin: BAND_WIDTH_PR, bandMax: BAND_WIDTH_PR * 2, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 90, avgTrend: 0, avgConsistency: 0 },
  });
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.resemblance, 1);
    assert.equal(result.modifier, MAX_TIER_MODIFIER);
  } finally {
    restore();
  }
});

test('getTierComparisonModifier: db.isConnected() false fails fast to hasSignal:false — never touches TierBandStatsModel at all', async () => {
  const player = playerWithFlatHistory(50, 60); // enough real history to pass the window-stats check
  const originalIsConnected = db.isConnected;
  const originalFindOne = TierBandStatsModel.findOne;
  db.isConnected = () => false;
  // If getTierComparisonModifier called this despite isConnected() being false, the test must fail
  // loudly (a real, unstubbed disconnected Mongoose query would otherwise just hang/timeout here
  // instead) — same "assert the call never happens" precedent as
  // test/matchmaker-setup-partial-failure.test.js's assertNoDelete.
  TierBandStatsModel.findOne = () => { throw new Error('must not query TierBandStatsModel when the DB is not connected'); };
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.hasSignal, false);
    assert.equal(result.modifier, 0);
    assert.match(result.reason, /not connected/i);
  } finally {
    db.isConnected = originalIsConnected;
    TierBandStatsModel.findOne = originalFindOne;
  }
});

// ── getTierComparisonModifier: efficiency as a genuine fourth factor ─────────
test('getTierComparisonModifier: efficiency (PR/session) is genuinely blended in as a real 4th factor — a player matching all 3 window factors at their OWN band but matching efficiency at the NEXT band gets a real partial modifier, not zero', async () => {
  // level/trend/consistency all set to EXACTLY match ownBand's own averages (resemblance 0 each,
  // same setup as the "sits exactly at own band" test above) — efficiency is the only factor that
  // diverges, set to match nextBand exactly (resemblance 1).
  const player = { ...playerWithFlatHistory(50, 55), sessions: 10 }; // totalPR 50, sessions 10 -> efficiency 5
  const restore = stubBandLookup({
    0: { bandMin: 0, bandMax: BAND_WIDTH_PR, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 55, avgTrend: 0, avgConsistency: 0, avgEfficiency: 1 },
    [BAND_WIDTH_PR]: { bandMin: BAND_WIDTH_PR, bandMax: BAND_WIDTH_PR * 2, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 90, avgTrend: 5, avgConsistency: 0.2, avgEfficiency: 5 },
  });
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.hasSignal, true);
    assert.equal(result.factorsUsed, 4, 'level, trend, consistency, AND efficiency must all be real, comparable factors here');
    assert.equal(
      result.resemblance, 0.25,
      'level/trend/consistency resemble ONLY the own band (0 each); efficiency resembles the NEXT band exactly (1) — average of [0,0,0,1] is 0.25, proving efficiency genuinely contributes its own independent factor rather than being ignored'
    );
    assert.equal(result.modifier, MAX_TIER_MODIFIER * 0.25);
  } finally {
    restore();
  }
});

test('getTierComparisonModifier: a player with no scraped Sessions count still gets a real signal from the other 3 factors — efficiency missing means one fewer factor, never a failure', async () => {
  const player = playerWithFlatHistory(50, 90); // no `sessions` field at all — same player as the "capped at 1.0" test
  const restore = stubBandLookup({
    0: { bandMin: 0, bandMax: BAND_WIDTH_PR, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 55, avgTrend: -2, avgConsistency: 0.3, avgEfficiency: 2 },
    [BAND_WIDTH_PR]: { bandMin: BAND_WIDTH_PR, bandMax: BAND_WIDTH_PR * 2, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 90, avgTrend: 0, avgConsistency: 0, avgEfficiency: 6 },
  });
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.hasSignal, true);
    assert.equal(result.factorsUsed, 3, 'efficiency must be excluded (no real sessions data) — never averaged in as a fabricated mismatch');
    assert.equal(result.resemblance, 1, 'the 3 real window factors alone already fully resemble the next band — efficiency\'s absence must not water that down');
  } finally {
    restore();
  }
});

test('getTierComparisonModifier: efficiency data — even a perfect match — never bypasses the MIN_BAND_PLAYERS gate, same threshold discipline as the other three factors', async () => {
  const player = { ...playerWithFlatHistory(50, 55), sessions: 10 }; // efficiency 5, would perfectly discriminate the two bands below
  const restore = stubBandLookup({
    // own band deliberately UNDER MIN_BAND_PLAYERS
    0: { bandMin: 0, bandMax: BAND_WIDTH_PR, playerCount: MIN_BAND_PLAYERS - 1, avgLevel: 55, avgTrend: 0, avgConsistency: 0, avgEfficiency: 1 },
    [BAND_WIDTH_PR]: { bandMin: BAND_WIDTH_PR, bandMax: BAND_WIDTH_PR * 2, playerCount: MIN_BAND_PLAYERS + 5, avgLevel: 90, avgTrend: 5, avgConsistency: 0.2, avgEfficiency: 5 },
  });
  try {
    const result = await getTierComparisonModifier(player);
    assert.equal(result.hasSignal, false, 'own band below MIN_BAND_PLAYERS must gate off the WHOLE result — a strong efficiency signal must never punch through this threshold on its own');
    assert.equal(result.modifier, 0);
    assert.match(result.reason, /own PR band/i);
  } finally {
    restore();
  }
});
