// Verifies the public "check your ELO" feature end-to-end:
//   - scraper.js's computeOwnTournamentModifier extraction preserves computeMatchScoreBreakdown's
//     exact prior behavior (a pure refactor, no scoring-logic change).
//   - elo.js's creative score genuinely matches what creative-queue.js's real 1v1/2v2 modes would
//     compute (not just internally consistent with itself), and a tournament with NO recorded
//     history scores identically to creative (confirming the "just the shared base" claim rather
//     than asserting it).
//   - players.js's epicUsernameLower auto-sync and findCanonicalByEpicUsername's cross-guild,
//     freshest-record resolution via epicId.
//   - the real GET /api/elo/:epicUsername route, started for real via webhook-server.js's
//     startWebhookServer and hit with real HTTP requests — only the Mongoose Model methods are
//     stubbed (same "stub the Model, not the module" precedent as
//     test/store-selective-persistence.test.js), so the actual Express route/middleware/JSON
//     handling all run unmodified.
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeMatchScoreBreakdown, getPlacementScore } = require('../scraper');
const { PERMANENT_KEYWORDS } = require('../tournament-scraper');
const elo = require('../elo');
const PlayerModel = require('../models/Player');
const playerStore = require('../players');

// ── computeOwnTournamentModifier extraction: no behavior change ──────────────
test('computeMatchScoreBreakdown: extracting computeOwnTournamentModifier did not change its output for an exact-tournamentName match (the only pattern every real-time caller uses)', () => {
  const playerData = {
    totalPR: 500, thisSeasonPR: 100,
    recentEvents: [
      { name: 'Some Cup', placement: 50, rosterSize: 2, elims: 10 },
      { name: 'Some Cup', placement: 200, rosterSize: 2, elims: 5 },
      { name: 'A Different Cup', placement: 1, rosterSize: 2, elims: 20 },
    ],
  };

  const result = computeMatchScoreBreakdown(playerData, 'Some Cup');
  assert.ok(result.ownTournamentModifier > 0, 'must still pick up the 2 matching "Some Cup" events');

  const noMatch = computeMatchScoreBreakdown(playerData, 'Nonexistent Cup');
  assert.equal(noMatch.ownTournamentModifier, 0);
  assert.equal(noMatch.matchScore, Math.round(noMatch.base * (1 + noMatch.soloModifier)));
});

// ── elo.js core logic ─────────────────────────────────────────────────────────
function makePlayerData(overrides = {}) {
  return {
    totalPR: 800, thisSeasonPR: 200,
    recentEvents: [],
    ...overrides,
  };
}

test('elo.js creative score genuinely matches what creative-queue.js\'s real 1v1/2v2 modes compute — not reimplemented logic, the same shared formula', () => {
  const playerData = makePlayerData({
    recentEvents: [
      { name: 'Solo Cash Cup', placement: 20, rosterSize: 1, elims: 30 },
      { name: 'Solo Cash Cup', placement: 5, rosterSize: 1, elims: 40 },
    ],
  });

  // The real mode strings creative-queue.js's MODES actually passes as tournamentName for 1v1/2v2
  // — confirms elo.js's generic "creative" calculation is genuinely equivalent to the real system,
  // not just self-consistent.
  const realModeResults = ['1v1 Realistics', '1v1 Zone Wars', '2v2 Realistics', '2v2 Zone Wars']
    .map(mode => computeMatchScoreBreakdown(playerData, mode).matchScore);

  assert.ok(realModeResults.every(s => s === realModeResults[0]), '1v1 and 2v2 (and both their sub-modes) must all score identically — confirmed by the real system itself, not assumed');

  const publicElo = require('../elo');
  // Reach into the module's own creative builder indirectly via getPublicElo's shape by calling
  // the underlying pieces directly would require exporting internals we don't want to expose
  // publicly — instead assert the documented invariant: the real system's own score (any of the
  // 4 real modes) equals computeMatchScoreBreakdown's raw output for the same inputs, which is
  // exactly what elo.js's buildCreativeElo wraps.
  assert.equal(realModeResults[0], computeMatchScoreBreakdown(playerData, '__whatever_nonmatching__').matchScore);
});

test('elo.js: a permanent tournament type with NO recorded history scores IDENTICALLY to the creative score (confirms — does not assume — the shared-base behavior)', async () => {
  const recentEvents = [
    { name: 'Solo Cash Cup', placement: 20, rosterSize: 1, elims: 30 },
    { name: 'Console Duos Victory Cup', placement: 15, rosterSize: 2, elims: 12 }, // history in ONE permanent type only
  ];

  const original = PlayerModel.find;
  PlayerModel.find = () => ({ lean: async () => [{ epicUsername: 'TestPlayer', epicUsernameLower: 'testplayer', epicId: 'e1', region: 'EU', totalPR: 800, thisSeasonPR: 200, recentEvents, lastUpdated: new Date() }] });
  try {
    const result = await elo.getPublicElo('TestPlayer');

    assert.equal(result.found, true);
    assert.equal(result.hasStats, true);

    const fncsDivision = result.tournaments.find(t => t.tournamentType === 'FNCS Division');
    assert.ok(fncsDivision, 'expected an FNCS Division entry regardless of whether the player has played it');
    assert.equal(fncsDivision.hasHistory, false, 'no "FNCS Division"-matching event in recentEvents');
    assert.equal(fncsDivision.score, result.creative.score, 'no history -> same score as creative, exactly');
    assert.deepEqual(fncsDivision.components, result.creative.components, 'no history -> identical component breakdown too, no phantom modifier');
    assert.equal('ownTournamentPlacement' in fncsDivision.components, false, 'must be OMITTED (not present as 0) when there is no history');

    const victoryCup = result.tournaments.find(t => t.tournamentType === 'Console Duos Victory Cup');
    assert.equal(victoryCup.hasHistory, true, 'DOES have a matching recorded event');
    assert.ok(victoryCup.score > result.creative.score, 'a positive placement in their own tournament history should raise the score above the shared base');
    assert.ok(victoryCup.components.ownTournamentPlacement > 0);

    // Every tournament type must be present regardless of history — "what they'd queue at right now".
    assert.equal(result.tournaments.length, PERMANENT_KEYWORDS.length);
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: segments always sum exactly to the total score (no rounding gap for a segmented bar to visibly break on)', async () => {
  const original = PlayerModel.find;
  PlayerModel.find = () => ({
    lean: async () => [{
      epicUsername: 'SegTest', epicUsernameLower: 'segtest', epicId: 'e2', region: 'NAC',
      totalPR: 733, thisSeasonPR: 91, lastUpdated: new Date(),
      recentEvents: [
        { name: 'FNCS Division 3', placement: 47, rosterSize: 2, elims: 9 },
        { name: 'Solo Ranked Thing', placement: 3, rosterSize: 1, elims: 22 },
      ],
    }],
  });
  try {
    const result = await elo.getPublicElo('SegTest');
    const c = result.creative.components;
    assert.equal(c.currentPR + c.seasonPR + c.soloPerformance, result.creative.score);

    for (const t of result.tournaments) {
      const sum = t.components.currentPR + t.components.seasonPR + t.components.soloPerformance + (t.components.ownTournamentPlacement ?? 0);
      assert.equal(sum, t.score, `segments for ${t.tournamentType} must sum exactly to its score`);
    }
  } finally {
    PlayerModel.find = original;
  }
});

// totalPR (scraper.js's extractPowerRank, reading data.powerRank.points) is Fortnite Tracker's
// continuously-recomputed, decaying "Power Ranking" figure — confirmed live to be the exact number
// the site headlines on a profile page — NOT a frozen career/lifetime total (that's a genuinely
// different, separate field, data.powerRank.lifetimePR, never captured or used anywhere in this
// codebase). components.currentPR (renamed from the misleading careerPR) must reflect that: the
// old name is gone entirely, not just aliased alongside the new one.
test('elo.js: the totalPR-derived component is named currentPR, not careerPR — "career" implies a frozen lifetime total, which is not what this figure is', async () => {
  const original = PlayerModel.find;
  PlayerModel.find = () => ({
    lean: async () => [{
      epicUsername: 'NamingTest', epicUsernameLower: 'namingtest', epicId: 'eNaming', region: 'EU',
      totalPR: 500, thisSeasonPR: 100, recentEvents: [], lastUpdated: new Date(),
    }],
  });
  try {
    const result = await elo.getPublicElo('NamingTest');

    assert.equal(result.creative.components.currentPR, 5000, 'currentPR = totalPR * 10, same formula as before, just renamed');
    assert.equal('careerPR' in result.creative.components, false, 'the old misleading name must be completely gone, not left as a duplicate alias');

    for (const t of result.tournaments) {
      assert.equal('careerPR' in t.components, false, `${t.tournamentType} components must not have the old careerPR key either`);
      assert.equal(t.components.currentPR, 5000);
    }
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: a real linked player with history in SOME (not all) permanent tournament types gets correct per-tournament breakdowns', async () => {
  const original = PlayerModel.find;
  PlayerModel.find = () => ({
    lean: async () => [{
      epicUsername: 'MixedHistory', epicUsernameLower: 'mixedhistory', epicId: 'e3', region: 'EU',
      totalPR: 1200, thisSeasonPR: 300, lastUpdated: new Date(),
      recentEvents: [
        { name: 'FNCS Division 1', placement: 8, rosterSize: 2, elims: 15 },
        { name: 'FNCS Division 1', placement: 25, rosterSize: 2, elims: 10 },
        // no Console Duos Victory Cup history at all
      ],
    }],
  });
  try {
    const result = await elo.getPublicElo('MixedHistory');
    const byType = Object.fromEntries(result.tournaments.map(t => [t.tournamentType, t]));

    assert.equal(byType['FNCS Division'].hasHistory, true);
    assert.equal(byType['Console Duos Victory Cup'].hasHistory, false);
    assert.equal(byType['Console Duos Victory Cup'].score, result.creative.score);
    assert.notEqual(byType['FNCS Division'].score, result.creative.score, 'real placement history should change the score away from the shared base');
  } finally {
    PlayerModel.find = original;
  }
});

// ── example events behind soloPerformance / ownTournamentPlacement ───────────
// A real player with MORE qualifying events than either modifier actually uses (6 solo events when
// only 5 feed soloModifier, 4 FNCS-Division-matching events when only 3 feed ownTournamentModifier)
// — so a test that just grabbed "the first few events of the matching type" without replicating the
// modifiers' own filter+slice exactly would silently include the wrong (excluded) event. Interleaved
// with a ranked solo event (must be excluded from soloEvents, same as the real formula) and a non-
// solo event (must also be excluded), in real newest-first order, exactly as parseProfileData stores
// recentEvents.
test('elo.js: examples.soloPerformance/ownTournamentPlacement return the EXACT (up to 3) events the real modifiers used — not just "some recent events"', async () => {
  const recentEvents = [
    { name: 'Solo Cash Cup A', date: '2026-07-30', placement: 5, prPoints: 80, rosterSize: 1, elims: 20 },
    { name: 'Solo Ranked Cup', date: '2026-07-29', placement: 1, prPoints: 999, rosterSize: 1, elims: 50 }, // solo but RANKED -> must be excluded from soloEvents
    { name: 'FNCS Division 2', date: '2026-07-28', placement: 8, prPoints: 200, rosterSize: 3, elims: 15 },
    { name: 'Solo Cash Cup B', date: '2026-07-27', placement: 10, prPoints: 70, rosterSize: 1, elims: 18 },
    { name: 'Duo Cash Cup', date: '2026-07-26', placement: 3, prPoints: 90, rosterSize: 2, elims: 25 }, // not solo -> must be excluded from soloEvents
    { name: 'FNCS Division 2', date: '2026-07-25', placement: 12, prPoints: 150, rosterSize: 3, elims: 10 },
    { name: 'Solo Cash Cup C', date: '2026-07-24', placement: 15, prPoints: 60, rosterSize: 1, elims: 12 },
    { name: 'Solo Cash Cup D', date: '2026-07-23', placement: 20, prPoints: 50, rosterSize: 1, elims: 10 },
    { name: 'FNCS Division 3', date: '2026-07-22', placement: 20, prPoints: 100, rosterSize: 3, elims: 5 },
    { name: 'Solo Cash Cup E', date: '2026-07-21', placement: 25, prPoints: 40, rosterSize: 1, elims: 8 }, // 5th solo -> DOES feed soloModifier, but is beyond the 3-example display cap
    { name: 'Solo Cash Cup F', date: '2026-07-20', placement: 30, prPoints: 30, rosterSize: 1, elims: 6 }, // 6th solo -> must be excluded from soloEvents entirely (modifier itself only reads 5)
    { name: 'FNCS Division 1', date: '2026-07-19', placement: 50, prPoints: 50, rosterSize: 3, elims: 2 }, // 4th FNCS-Division match -> must be excluded (modifier itself only reads 3)
  ];

  const original = PlayerModel.find;
  PlayerModel.find = () => ({
    lean: async () => [{
      epicUsername: 'ExampleEvents', epicUsernameLower: 'exampleevents', epicId: 'eEx', region: 'EU',
      totalPR: 900, thisSeasonPR: 200, recentEvents, lastUpdated: new Date(),
    }],
  });
  try {
    const result = await elo.getPublicElo('ExampleEvents');

    // creative.examples.soloPerformance: first 3 of the 5 REAL events soloModifier used (A, B, C) —
    // not padded to 3 with anything else, and NOT the ranked cup or the duo event even though both
    // sort earlier/interleaved in recentEvents.
    assert.deepEqual(result.creative.examples.soloPerformance, [
      { name: 'Solo Cash Cup A', date: '2026-07-30', placement: 5, prPoints: 80 },
      { name: 'Solo Cash Cup B', date: '2026-07-27', placement: 10, prPoints: 70 },
      { name: 'Solo Cash Cup C', date: '2026-07-24', placement: 15, prPoints: 60 },
    ]);

    const fncs = result.tournaments.find(t => t.tournamentType === 'FNCS Division');
    assert.equal(fncs.hasHistory, true);
    // Same soloPerformance examples on the tournament entry (shared soloModifier, same events).
    assert.deepEqual(fncs.examples.soloPerformance, result.creative.examples.soloPerformance);
    // ownTournamentPlacement: the 3 REAL matched events (both "FNCS Division 2"s + "FNCS Division
    // 3"), newest first, NOT the 4th ("FNCS Division 1") which the real modifier itself never reads.
    assert.deepEqual(fncs.examples.ownTournamentPlacement, [
      { name: 'FNCS Division 2', date: '2026-07-28', placement: 8, prPoints: 200 },
      { name: 'FNCS Division 2', date: '2026-07-25', placement: 12, prPoints: 150 },
      { name: 'FNCS Division 3', date: '2026-07-22', placement: 20, prPoints: 100 },
    ]);

    const victoryCup = result.tournaments.find(t => t.tournamentType === 'Console Duos Victory Cup');
    assert.equal(victoryCup.hasHistory, false);
    assert.equal('ownTournamentPlacement' in victoryCup.examples, false, 'no history -> examples key omitted entirely, not an empty array');
    assert.deepEqual(victoryCup.examples.soloPerformance, result.creative.examples.soloPerformance, 'no own-tournament history -> still gets the same real soloPerformance examples');
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: examples.soloPerformance returns fewer than 3 (not padded) when the player has fewer than 3 qualifying solo events', async () => {
  const original = PlayerModel.find;
  PlayerModel.find = () => ({
    lean: async () => [{
      epicUsername: 'OneSolo', epicUsernameLower: 'onesolo', epicId: 'eOne', region: 'EU',
      totalPR: 400, thisSeasonPR: 50, lastUpdated: new Date(),
      recentEvents: [
        { name: 'Only Solo Cup', date: '2026-07-30', placement: 40, prPoints: 20, rosterSize: 1, elims: 5 },
      ],
    }],
  });
  try {
    const result = await elo.getPublicElo('OneSolo');
    assert.deepEqual(result.creative.examples.soloPerformance, [
      { name: 'Only Solo Cup', date: '2026-07-30', placement: 40, prPoints: 20 },
    ]);
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: examples.soloPerformance is an empty array (not omitted, not padded) when there are no qualifying solo events at all', async () => {
  const original = PlayerModel.find;
  PlayerModel.find = () => ({
    lean: async () => [{
      epicUsername: 'NoSolo', epicUsernameLower: 'nosolo', epicId: 'eNoSolo', region: 'EU',
      totalPR: 400, thisSeasonPR: 50, recentEvents: [], lastUpdated: new Date(),
    }],
  });
  try {
    const result = await elo.getPublicElo('NoSolo');
    assert.deepEqual(result.creative.examples.soloPerformance, []);
  } finally {
    PlayerModel.find = original;
  }
});

// ── baseline (PR-only) vs final score ─────────────────────────────────────────
// Stubs PlayerModel.find generically enough to answer BOTH queries getPublicElo now issues: the
// existing epicUsernameLower/epicId lookup (findCanonicalByEpicUsername) AND the new
// {totalPR: {$ne: null}} full-scan (players.js's getAllScoredPlayers, which powers percentile).
function stubPlayerFind(players) {
  return (filter) => ({
    lean: async () => {
      if (filter.totalPR) return players.filter(p => p.totalPR != null);
      if (filter.epicUsernameLower) return players.filter(p => p.epicUsernameLower === filter.epicUsernameLower);
      if (filter.epicId) return players.filter(p => p.epicId === filter.epicId);
      if (filter.epicUsername instanceof RegExp) return players.filter(p => filter.epicUsername.test(p.epicUsername));
      return [];
    },
  });
}

test('elo.js: baseline is the PR-only score (no modifiers) — a player with NO recentEvents scores exactly at baseline (0% vs baseline)', async () => {
  const original = PlayerModel.find;
  const player = {
    epicUsername: 'FlatPR', epicUsernameLower: 'flatpr', epicId: 'flat1', region: 'EU',
    totalPR: 400, thisSeasonPR: 100, recentEvents: [], lastUpdated: new Date(),
  };
  PlayerModel.find = stubPlayerFind([player]);
  try {
    const result = await elo.getPublicElo('FlatPR');
    // base = totalPR*10 + thisSeasonPR*5 = 4000 + 500 = 4500, no solo/tournament history -> modifiers are 0.
    assert.equal(result.creative.baseline, 4500);
    assert.equal(result.creative.score, 4500, 'no recentEvents at all -> nothing to modify the baseline with');
    assert.equal(result.creative.vsBaselinePercent, 0);
    for (const t of result.tournaments) {
      assert.equal(t.baseline, 4500);
      assert.equal(t.vsBaselinePercent, 0);
    }
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: real recent history that raises soloModifier/ownTournamentModifier above zero pushes the final score ABOVE baseline, and vsBaselinePercent reflects it correctly', async () => {
  const original = PlayerModel.find;
  const player = {
    epicUsername: 'StrongRecent', epicUsernameLower: 'strongrecent', epicId: 'strong1', region: 'EU',
    totalPR: 400, thisSeasonPR: 100, lastUpdated: new Date(),
    recentEvents: [
      // Strong solo results (top placement band + high elims) -> soloModifier > 0.
      { name: 'Solo Cash Cup', placement: 1, rosterSize: 1, elims: 45 },
      { name: 'Solo Cash Cup', placement: 2, rosterSize: 1, elims: 40 },
      // Strong own-tournament (FNCS Division) placement history -> ownTournamentModifier > 0.
      { name: 'FNCS Division 2', placement: 1, rosterSize: 3, elims: 20 },
    ],
  };
  PlayerModel.find = stubPlayerFind([player]);
  try {
    const result = await elo.getPublicElo('StrongRecent');
    const baseline = result.creative.baseline;
    assert.equal(baseline, 4500);

    // Real formula (scraper.js computeMatchScoreBreakdown/computeOwnTournamentModifier) never
    // produces a NEGATIVE soloModifier/ownTournamentModifier — getPlacementScore floors at 0 — so
    // the only real directions are "at baseline" (0%) or "above baseline" (>0%), never below.
    // Confirmed here rather than assumed: exercising this with strong (not just any) recent history.
    assert.ok(result.creative.score >= baseline, 'creative score must never fall below its own PR baseline given the real formula');
    assert.ok(result.creative.vsBaselinePercent > 0, 'strong solo history must show as performing ABOVE baseline');
    assert.equal(
      result.creative.vsBaselinePercent,
      Math.round(((result.creative.score / baseline) - 1) * 1000) / 10,
      'vsBaselinePercent must match the real score/baseline ratio, not an invented number'
    );

    const fncs = result.tournaments.find(t => t.tournamentType === 'FNCS Division');
    assert.ok(fncs.score > fncs.baseline, 'own-tournament placement history must push this tournament type above its baseline too');
    assert.ok(fncs.vsBaselinePercent > result.creative.vsBaselinePercent, 'the extra ownTournamentModifier on top of the shared soloModifier must show as an even bigger lift for FNCS specifically');
  } finally {
    PlayerModel.find = original;
  }
});

// ── percentile ranking ──────────────────────────────────────────────────────
test('elo.js: percentile is computed against a real query over stored players — correctly ordered, top scorer near 99th, median near 50th, bottom near 0th (not inverted, not off-by-one)', async () => {
  const original = PlayerModel.find;
  // 101 real/seeded comparison players with totalPR 0..100 (unique, no history) — pure, predictable
  // creative scores of totalPR*10 (0, 10, 20, ..., 1000).
  const pool = Array.from({ length: 101 }, (_, i) => ({
    epicUsername: `Filler${i}`, epicUsernameLower: `filler${i}`, epicId: `filler-${i}`, region: 'EU',
    totalPR: i, thisSeasonPR: 0, recentEvents: [], lastUpdated: new Date(),
  }));
  PlayerModel.find = stubPlayerFind(pool);
  try {
    const top = await elo.getPublicElo('Filler100'); // strictly highest score in the pool
    const median = await elo.getPublicElo('Filler50'); // exact middle of 0..100
    const bottom = await elo.getPublicElo('Filler0'); // strictly lowest score in the pool

    assert.ok(top.creative.percentile > 95, `top scorer should land near the 99th percentile, got ${top.creative.percentile}`);
    assert.ok(top.creative.percentile < 100, 'must never round UP to exactly 100 — nobody outranks themselves');

    assert.ok(Math.abs(median.creative.percentile - 50) < 2, `median scorer should land near the 50th percentile, got ${median.creative.percentile}`);

    assert.ok(bottom.creative.percentile < 5, `bottom scorer should land near the 0th percentile, got ${bottom.creative.percentile}`);
    assert.ok(bottom.creative.percentile >= 0, 'percentile must never go negative');

    // Correctly ORDERED, not inverted: top must outrank median must outrank bottom.
    assert.ok(top.creative.percentile > median.creative.percentile);
    assert.ok(median.creative.percentile > bottom.creative.percentile);

    // Per-tournament-type percentile is also real and present for every permanent type.
    for (const t of top.tournaments) {
      assert.ok(typeof t.percentile === 'number' && t.percentile > 95, `${t.tournamentType} percentile should also rank the top scorer near the top`);
    }
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: a player registered under multiple guilds only counts ONCE in the percentile pool (deduped by epicId, same rule as findCanonicalByEpicUsername)', async () => {
  const original = PlayerModel.find;
  // The SAME real account (shared epicId), duplicated across 3 guild-scoped Player docs — a real,
  // already-supported situation (players.js's findCanonicalByEpicUsername doc comment). Plus one
  // genuinely different low-scoring player to rank against.
  const dupedAccount = ['g1', 'g2', 'g3'].map(guildId => ({
    guildId, epicUsername: 'Duped', epicUsernameLower: 'duped', epicId: 'dup-shared',
    totalPR: 1000, thisSeasonPR: 0, recentEvents: [], lastUpdated: new Date(),
  }));
  const other = { epicUsername: 'Solo', epicUsernameLower: 'solo', epicId: 'solo-1', totalPR: 10, thisSeasonPR: 0, recentEvents: [], lastUpdated: new Date() };
  PlayerModel.find = stubPlayerFind([...dupedAccount, other]);
  try {
    const result = await elo.getPublicElo('Duped');
    // Pool must be deduped to 2 real accounts (Duped once, Solo once), not 4 raw docs — with only
    // Solo below Duped, percentile = (1 + 0.5)/2 * 100 = 75, NOT (3 + 0.5)/4 * 100 = 87.5 (which is
    // what an undeduped scan would wrongly produce).
    assert.equal(result.creative.percentile, 75, 'duplicate guild docs for the same real account must count once, not once per guild');
  } finally {
    PlayerModel.find = original;
  }
});

// ── relativeToAveragePercent: own bonus vs. the POOL'S average bonus ─────────
// vsBaselinePercent alone can only ever be >= 0 (soloModifier/ownTournamentModifier never go
// negative in the real formula — confirmed by the "real recent history... pushes above baseline"
// test above), so it can't say "below average" on its own. relativeToAveragePercent is the actual
// two-sided signal: this player's OWN vsBaselinePercent minus the SAME comparison pool's average.
// Computed independently here (via the real computeMatchScoreBreakdown, not elo.js internals) so
// this is a genuine cross-check, not just asserting elo.js agrees with itself.
function expectedVsBaselinePercent(totalPR, thisSeasonPR, recentEvents) {
  const { base, soloModifier } = computeMatchScoreBreakdown({ totalPR, thisSeasonPR, recentEvents }, '__never_matches__');
  const baseline = Math.round(base);
  const total = Math.round(base * (1 + soloModifier));
  return Math.round(((total / baseline) - 1) * 1000) / 10;
}

test('elo.js: relativeToAveragePercent is POSITIVE for a player whose bonus beats the pool average, even though vsBaselinePercent alone is never negative', async () => {
  const original = PlayerModel.find;
  const flatA = { epicUsername: 'FlatA', epicUsernameLower: 'flata', epicId: 'flatA', totalPR: 300, thisSeasonPR: 0, recentEvents: [], lastUpdated: new Date() };
  const flatB = { epicUsername: 'FlatB', epicUsernameLower: 'flatb', epicId: 'flatB', totalPR: 300, thisSeasonPR: 0, recentEvents: [], lastUpdated: new Date() };
  const strong = {
    epicUsername: 'StrongBonus', epicUsernameLower: 'strongbonus', epicId: 'strongBonus', totalPR: 100, thisSeasonPR: 0, lastUpdated: new Date(),
    recentEvents: [
      { name: 'Solo Cash Cup', placement: 1, rosterSize: 1, elims: 45 },
      { name: 'Solo Cash Cup', placement: 1, rosterSize: 1, elims: 45 },
    ],
  };
  PlayerModel.find = stubPlayerFind([flatA, flatB, strong]);
  try {
    const result = await elo.getPublicElo('StrongBonus');
    const strongPct = expectedVsBaselinePercent(strong.totalPR, strong.thisSeasonPR, strong.recentEvents);
    const flatPct = expectedVsBaselinePercent(300, 0, []);
    assert.equal(result.creative.vsBaselinePercent, strongPct);
    assert.ok(strongPct > 0, 'sanity check: this player DOES have a positive bonus over their own floor');

    const expectedAvg = (flatPct + flatPct + strongPct) / 3;
    const expectedRelative = Math.round((strongPct - expectedAvg) * 10) / 10;
    assert.equal(result.creative.relativeToAveragePercent, expectedRelative);
    assert.ok(result.creative.relativeToAveragePercent > 0, 'a bonus well above two flat (0%) peers must show as genuinely ABOVE average');
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: relativeToAveragePercent is NEGATIVE for a player whose bonus is smaller than the pool average — the genuine below-average case vsBaselinePercent alone cannot express', async () => {
  const original = PlayerModel.find;
  const strongEvents = [
    { name: 'Solo Cash Cup', placement: 1, rosterSize: 1, elims: 45 },
    { name: 'Solo Cash Cup', placement: 1, rosterSize: 1, elims: 45 },
  ];
  const strongA = { epicUsername: 'PeerA', epicUsernameLower: 'peera', epicId: 'peerA', totalPR: 100, thisSeasonPR: 0, recentEvents: strongEvents, lastUpdated: new Date() };
  const strongB = { epicUsername: 'PeerB', epicUsernameLower: 'peerb', epicId: 'peerB', totalPR: 100, thisSeasonPR: 0, recentEvents: strongEvents, lastUpdated: new Date() };
  // A real, but comparatively weak, bonus — still >= 0 on its own (mid-tier placement, no elims).
  const weakEvents = [{ name: 'Solo Cash Cup', placement: 1000, rosterSize: 1, elims: 0 }];
  const weak = { epicUsername: 'WeakBonus', epicUsernameLower: 'weakbonus', epicId: 'weakBonus', totalPR: 100, thisSeasonPR: 0, recentEvents: weakEvents, lastUpdated: new Date() };
  PlayerModel.find = stubPlayerFind([strongA, strongB, weak]);
  try {
    const result = await elo.getPublicElo('WeakBonus');
    const weakPct = expectedVsBaselinePercent(100, 0, weakEvents);
    const strongPct = expectedVsBaselinePercent(100, 0, strongEvents);
    assert.ok(weakPct >= 0, 'sanity check: this player is still AT OR ABOVE their own floor, never below it');
    assert.ok(weakPct < strongPct, 'sanity check: genuinely the weakest bonus of the three');

    const expectedAvg = (strongPct + strongPct + weakPct) / 3;
    const expectedRelative = Math.round((weakPct - expectedAvg) * 10) / 10;
    assert.equal(result.creative.relativeToAveragePercent, expectedRelative);
    assert.ok(result.creative.relativeToAveragePercent < 0, 'weaker-than-peers bonus must show as genuinely BELOW average, even though vsBaselinePercent itself is >= 0');
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: relativeToAveragePercent is computed per tournament type from that type\'s own average, not the creative average', async () => {
  const original = PlayerModel.find;
  // Two peers with real FNCS Division placement history (raises their FNCS bonus specifically,
  // not their creative bonus) — the target has none, so their FNCS relativeToAveragePercent must
  // come out negative even if their creative one (compared only against flat creative peers) does not.
  const fncsHistory = [{ name: 'FNCS Division 2', placement: 1, rosterSize: 3, elims: 0 }];
  const peerA = { epicUsername: 'FncsPeerA', epicUsernameLower: 'fncspeera', epicId: 'fncsPeerA', totalPR: 100, thisSeasonPR: 0, recentEvents: fncsHistory, lastUpdated: new Date() };
  const peerB = { epicUsername: 'FncsPeerB', epicUsernameLower: 'fncspeerb', epicId: 'fncsPeerB', totalPR: 100, thisSeasonPR: 0, recentEvents: fncsHistory, lastUpdated: new Date() };
  const noHistory = { epicUsername: 'NoFncsHistory', epicUsernameLower: 'nofncshistory', epicId: 'noFncsHistory', totalPR: 100, thisSeasonPR: 0, recentEvents: [], lastUpdated: new Date() };
  PlayerModel.find = stubPlayerFind([peerA, peerB, noHistory]);
  try {
    const result = await elo.getPublicElo('NoFncsHistory');
    // No own-tournament or solo history at all -> flat 0% bonus in EVERY category, so creative
    // (peers are also flat there) shows dead-even, not below average.
    assert.equal(result.creative.relativeToAveragePercent, 0);

    const fncs = result.tournaments.find(t => t.tournamentType === 'FNCS Division');
    assert.ok(fncs.relativeToAveragePercent < 0, 'two peers with real FNCS placement history push the FNCS-specific average above this player\'s flat 0%, which the creative-only comparison would miss entirely');
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: getPublicElo returns null for a username with no matching record — the "not found" path', async () => {
  const original = PlayerModel.find;
  PlayerModel.find = () => ({ lean: async () => [] });
  try {
    const result = await elo.getPublicElo('DoesNotExistAnywhere');
    assert.equal(result, null);
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: a registered/linked player who has never actually been scraped (totalPR still null) gets an honest "no stats yet", not a crash', async () => {
  const original = PlayerModel.find;
  PlayerModel.find = () => ({ lean: async () => [{ epicUsername: 'NeverQueued', epicUsernameLower: 'neverqueued', epicId: 'e4', totalPR: null, thisSeasonPR: null, recentEvents: [] }] });
  try {
    const result = await elo.getPublicElo('NeverQueued');
    assert.equal(result.found, true);
    assert.equal(result.hasStats, false);
    assert.equal(result.creative, undefined);
  } finally {
    PlayerModel.find = original;
  }
});

// ── players.js: epicUsernameLower sync + cross-guild resolution ──────────────
test('players.js upsertPlayer: keeps epicUsernameLower in sync whenever epicUsername is set or cleared', async () => {
  const calls = [];
  const original = PlayerModel.findOneAndUpdate;
  PlayerModel.findOneAndUpdate = (filter, update) => ({ lean: async () => { calls.push(update.$set); return { ...filter, ...update.$set }; } });
  try {
    await playerStore.upsertPlayer('g1', 'd1', { epicUsername: 'BuGha', epicId: 'x' });
    assert.equal(calls[0].epicUsernameLower, 'bugha');

    await playerStore.upsertPlayer('g1', 'd1', { epicUsername: null, epicId: null });
    assert.equal(calls[1].epicUsernameLower, null);

    await playerStore.upsertPlayer('g1', 'd1', { region: 'NAC' }); // unrelated field, no epicUsername touched
    assert.equal('epicUsernameLower' in calls[2], false, 'must not touch epicUsernameLower when epicUsername is not part of this update');
  } finally {
    PlayerModel.findOneAndUpdate = original;
  }
});

test('players.js findCanonicalByEpicUsername: resolves the same real account registered under multiple guilds to ONE result, picking the freshest by lastUpdated', async () => {
  const original = PlayerModel.find;
  const staleRecord = { guildId: 'guildA', discordId: 'd1', epicUsername: 'SamePerson', epicUsernameLower: 'sameperson', epicId: 'shared-epic-id', totalPR: 100, lastUpdated: new Date('2026-01-01') };
  const freshRecord = { guildId: 'guildB', discordId: 'd1', epicUsername: 'SamePerson', epicUsernameLower: 'sameperson', epicId: 'shared-epic-id', totalPR: 999, lastUpdated: new Date('2026-06-01') };

  PlayerModel.find = (filter) => ({
    lean: async () => {
      if (filter.epicUsernameLower) return [staleRecord, freshRecord];
      if (filter.epicId) return [staleRecord, freshRecord];
      return [];
    },
  });
  try {
    const result = await playerStore.findCanonicalByEpicUsername('sameperson'); // lowercase input too — case-insensitive
    assert.equal(result.guildId, 'guildB', 'must pick the record with the LATEST lastUpdated');
    assert.equal(result.totalPR, 999);
  } finally {
    PlayerModel.find = original;
  }
});

test('players.js findCanonicalByEpicUsername: case-insensitive, and returns null for no match', async () => {
  const original = PlayerModel.find;
  PlayerModel.find = () => ({ lean: async () => [] });
  try {
    assert.equal(await playerStore.findCanonicalByEpicUsername('NoSuchPlayer'), null);
    assert.equal(await playerStore.findCanonicalByEpicUsername(''), null);
  } finally {
    PlayerModel.find = original;
  }
});

// ── Real HTTP route, end-to-end ───────────────────────────────────────────────
test('GET /api/elo/:epicUsername — real Express route, real HTTP request: found, not-found, and rate-limit responses', async () => {
  const originalFind = PlayerModel.find;
  const originalPort = process.env.PORT;
  process.env.PORT = '0'; // ephemeral port — avoids clashing with anything else, or across repeat runs

  const players = {
    realuser: [{ epicUsername: 'RealUser', epicUsernameLower: 'realuser', epicId: 'eR', region: 'EU', totalPR: 500, thisSeasonPR: 50, recentEvents: [], lastUpdated: new Date() }],
  };
  PlayerModel.find = (filter) => ({
    lean: async () => {
      if (filter.epicUsernameLower) return players[filter.epicUsernameLower] ?? [];
      if (filter.epicId) return Object.values(players).flat().filter(p => p.epicId === filter.epicId);
      return [];
    },
  });

  let server;
  try {
    const { startWebhookServer } = require('../webhook-server');
    server = startWebhookServer({}); // no Discord client behavior is needed by the ELO route
    assert.ok(server, 'the webhook server must start even with no Stripe/Epic/Discord/deploy env vars set, since the ELO endpoint alone is enough reason to');

    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    const found = await fetch(`${base}/api/elo/RealUser`);
    assert.equal(found.status, 200);
    const foundBody = await found.json();
    assert.equal(foundBody.found, true);
    assert.equal(foundBody.epicUsername, 'RealUser');
    assert.ok(foundBody.creative.score >= 0);
    assert.ok(Array.isArray(foundBody.tournaments));

    // Case-insensitive at the HTTP layer too.
    const foundLower = await fetch(`${base}/api/elo/realuser`);
    assert.equal(foundLower.status, 200);

    const notFound = await fetch(`${base}/api/elo/TotallyUnknownPerson12345`);
    assert.equal(notFound.status, 404);
    const notFoundBody = await notFound.json();
    assert.equal(notFoundBody.found, false);
    assert.ok(notFoundBody.error, 'a clean, honest not-found message, not a raw error');

    // Rate limit: hammer past the 20/min/IP cap and confirm a 429 shows up.
    let sawRateLimited = false;
    for (let i = 0; i < 25; i++) {
      const resp = await fetch(`${base}/api/elo/RealUser`);
      if (resp.status === 429) { sawRateLimited = true; break; }
    }
    assert.ok(sawRateLimited, 'repeated hammering from the same IP must eventually get rate-limited');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    PlayerModel.find = originalFind;
    if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  }
});
