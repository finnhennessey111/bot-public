// Verifies epic-api.js's parsing/matching logic against the REAL response shapes pasted from live
// manual testing against prod.api-fortnite.com (not guessed) — see epic-api.js's doc comment for
// why Epic is an enrichment/cross-check on top of Fortnite Tracker's discovery, never a
// replacement of it. fetchJson is stubbed throughout (module.exports delegation, same precedent as
// scraper.js's scrapePlayer/scrapePlayerOnce — see test/scraper-retry.test.js) so every test here
// runs with no real network round trip and no FORTNITE_API_KEY required.
const test = require('node:test');
const assert = require('node:assert/strict');

const epicApi = require('../epic-api');
const { detectBuildModeFromEpicId } = require('../build-mode');
const { getPlacementScore } = require('../scraper');

function withStubbedFetchJson(responses, fn) {
  const original = epicApi.fetchJson;
  epicApi.fetchJson = async (path) => {
    if (!(path in responses)) throw new Error(`unexpected path in test stub: ${path}`);
    const value = responses[path];
    if (value instanceof Error) throw value;
    return value;
  };
  return fn().finally(() => { epicApi.fetchJson = original; });
}

// Real /api/v1/events/global list-view entries (reformatted from the user's live "id::code  name"
// paste into what's actually confirmed: an id-like field and a display name). The one entry with a
// full raw shape confirmed (Duos Ranked Cup Zero Build) gets its real eventWindows array attached;
// every other entry gets an empty eventWindows array — genuinely unconfirmed for those, and tests
// below don't rely on it being populated for anything but the one entry it's real for.
const REAL_RANKED_CUP_DUOS_ZB_WINDOW = {
  countdownBeginTime: '2026-07-31T19:00:00Z',
  beginTime: '2026-07-31T21:00:00Z',
  endTime: '2026-08-01T00:00:00Z',
  round: 2,
  eventWindowId: 'S41_RankedCupDuosZB_Event7_BR',
  eventTemplateId: 'EventTemplate_RankedCupDuosZB',
  scoreLocations: ['@{leaderboardDefId=Lead_Default; isMainWindowLeaderboard=True}'],
  metadata: { RoundType: 'Qualifiers', RankTrackTypeForMatchStatsPrefixes: 'ranked-br-combined' },
  link: { type: 'br:tournament', code: 'tournament_epicgames_s41_rankedcupduoszb_br' },
};

const REAL_GLOBAL_EVENTS = [
  { id: 'S41_PSTypicalGamer_ZB', name: 'PlayStation Typical Gamer Icon Cup', eventWindows: [] },
  { id: 'Season41_DiamondTestCup', name: 'BR Test Cup (Diamond)', eventWindows: [] },
  { id: 'S41_CashCup_DuosZB', name: 'Console Duos ZB Cash Cup', eventWindows: [] },
  { id: 'Season41_MobileSeriesOpenAll', name: 'Mobile Series', eventWindows: [] },
  { id: 'Season41_PerfEval', name: 'Fortnite Performance Evaluation', eventWindows: [] },
  { id: 'Season41_FNCSLastChanceMajor', name: 'FNCS Global Championship Last Chance', eventWindows: [] },
  { id: 'Season41_RankedCupDuosZB', name: 'Duos Ranked Cup (Zero Build)', eventWindows: [REAL_RANKED_CUP_DUOS_ZB_WINDOW] },
  { id: 'Season41_ReloadSoloVictoryCup', name: 'Solo Reload Victory Cup', eventWindows: [] },
  { id: 'Season41_RankedCupReloadDuos', name: 'Duos Ranked Cup (Reload)', eventWindows: [] },
  { id: 'S41_ConsoleVCC_SolosZB', name: 'Console Solo Victory Cup (ZB)', eventWindows: [] },
  { id: 'Season41_RankedCupDuos', name: 'Duos Ranked Cup (Battle Royale)', eventWindows: [] },
  { id: 'S41_ConsoleCC_DuosZB', name: 'Console Duos ZB Cash Cup', eventWindows: [] },
  { id: 'Season41_RankedCupSolo', name: 'Solo Ranked Cup (Battle Royale)', eventWindows: [] },
  { id: 'Season41_RankedCupSoloReload', name: 'Solo Ranked Cup (Reload)', eventWindows: [] },
];

const REAL_GLOBAL_HISTORY = [
  { id: 'Season41_FNCSDivisionalCup_Division1', name: 'FNCS Division 1', eventWindows: [] },
  { id: 'Season41_FNCSDivisionalCup_Division3', name: 'FNCS Division 3', eventWindows: [] },
  { id: 'Season41_FNCSDivisionalCup_Division4', name: 'FNCS Division 4', eventWindows: [] },
  { id: 'Season41_FNCSDivisionalCup_Division5', name: 'FNCS Division 5', eventWindows: [] },
  { id: 'Season41_FNCSDivisionalCup_Division2', name: 'FNCS Division 2', eventWindows: [] },
  { id: 'S41_FNCSCommunityCup', name: 'Champion Aphrodite FNCS Cup', eventWindows: [] },
  { id: 'Season41_FNCSMajor2', name: 'FNCS Global Championship Last Chance', eventWindows: [] },
];

// The real, full /api/v1/events/{eventId}/{eventWindowId}/player/{accountId}/matches response
// (trimmed to 2 of the real 8 match entries — enough to confirm the shape without bloating the
// test file; matches[] isn't read by any of the code under test, only rank/pointsEarned/found are).
const REAL_MATCHES_RESPONSE = {
  found: true,
  eventId: 'epicgames_S41_FNCSDivisionalCup_Division3_EU',
  eventWindowId: 'S41_FNCSDivisionalCup_Division3_Event8_2_EU',
  accountId: 'b87297a442684bbaa6f4cbf4e12efb2d',
  rank: 502,
  pointsEarned: 230,
  teamAccountIds: ['b87297a442684bbaa6f4cbf4e12efb2d', 'dfa61fc098ed477aa3a13cf2131bb1e6'],
  matchCount: 8,
  matches: [
    { sessionId: '893d69bb14014880925d2b5188c0fd21', endTime: '2026-07-19T15:10:20.833Z', trackedStats: { PLACEMENT_STAT_INDEX: 38, TIME_ALIVE_STAT: 410, TEAM_ELIMS_STAT_INDEX: 0, MATCH_PLAYED_STAT: 1, PLACEMENT_TIEBREAKER_STAT: 62, VICTORY_ROYALE_STAT: 0 } },
    { sessionId: '39f0f300cbf64ec398b234551cd0a1d2', endTime: '2026-07-19T15:33:16.718Z', trackedStats: { PLACEMENT_STAT_INDEX: 7, TIME_ALIVE_STAT: 1256, TEAM_ELIMS_STAT_INDEX: 3, MATCH_PLAYED_STAT: 1, PLACEMENT_TIEBREAKER_STAT: 93, VICTORY_ROYALE_STAT: 0 } },
  ],
};

// epic-api.js's calendar/matches cache is a shared module-level Map, long-TTL by design in
// production — cleared before every test here so each test's own fetchJson stub is what actually
// gets exercised, instead of a silently-reused result cached by an earlier test.
test.beforeEach(() => {
  epicApi.__resetCacheForTests();
});

test('findEventEntryByName: matches an upcoming event by exact (case-insensitive) name', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/global': REAL_GLOBAL_EVENTS,
    '/api/v1/events/global/history': REAL_GLOBAL_HISTORY,
  }, async () => {
    const entry = await epicApi.findEventEntryByName('duos ranked cup (zero build)');
    assert.ok(entry);
    assert.equal(entry.id, 'Season41_RankedCupDuosZB');
    assert.equal(entry.eventWindows.length, 1);
  });
});

test('findEventEntryByName: falls back to the history list when not found upcoming', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/global': REAL_GLOBAL_EVENTS,
    '/api/v1/events/global/history': REAL_GLOBAL_HISTORY,
  }, async () => {
    const entry = await epicApi.findEventEntryByName('FNCS Division 3');
    assert.ok(entry);
    assert.equal(entry.id, 'Season41_FNCSDivisionalCup_Division3');
  });
});

test('findEventEntryByName: returns null when no calendar entry matches either list', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/global': REAL_GLOBAL_EVENTS,
    '/api/v1/events/global/history': REAL_GLOBAL_HISTORY,
  }, async () => {
    const entry = await epicApi.findEventEntryByName('Some Tournament That Does Not Exist');
    assert.equal(entry, null);
  });
});

test('findEventEntryByName: a fetchJson failure (rate limit / network error) resolves to null, never throws', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/global': null, // fetchGlobalEvents' real behavior on a non-ok response/error
    '/api/v1/events/global/history': null,
  }, async () => {
    const entry = await epicApi.findEventEntryByName('Duos Ranked Cup (Zero Build)');
    assert.equal(entry, null);
  });
});

test('pickEventWindowsForRegion: matches EU via the eventWindowId trailing suffix, a BR-suffixed window never leaks into an NAC query', () => {
  const windows = [
    REAL_RANKED_CUP_DUOS_ZB_WINDOW, // real window, suffix "_BR" (Brazil)
    { ...REAL_RANKED_CUP_DUOS_ZB_WINDOW, eventWindowId: 'S41_RankedCupDuosZB_Event7_EU', endTime: '2026-08-01T00:00:00Z' },
  ];
  const euWindows = epicApi.pickEventWindowsForRegion(windows, 'EU');
  assert.equal(euWindows.length, 1);
  assert.equal(euWindows[0].eventWindowId, 'S41_RankedCupDuosZB_Event7_EU');

  // NAC's candidate set (['NAC', 'NAE']) never includes 'BR', so the Brazil-suffixed window is
  // correctly excluded from an NAC lookup — this is the real-world case that matters (Epic
  // enrichment for one region must never accidentally serve a different region's window).
  const nacWindows = epicApi.pickEventWindowsForRegion(windows, 'NAC');
  assert.equal(nacWindows.length, 0);
});

test('pickEventWindowsForRegion: onlyPast excludes a window whose endTime is still in the future, sorts most-recent-first', () => {
  const past1 = { eventWindowId: 'X_Event1_EU', endTime: '2020-01-01T00:00:00Z' };
  const past2 = { eventWindowId: 'X_Event2_EU', endTime: '2021-01-01T00:00:00Z' };
  const future = { eventWindowId: 'X_Event3_EU', endTime: new Date(Date.now() + 86400000).toISOString() };

  const windows = epicApi.pickEventWindowsForRegion([past1, future, past2], 'EU', { onlyPast: true });
  assert.deepEqual(windows.map(w => w.eventWindowId), ['X_Event2_EU', 'X_Event1_EU']);
});

test('pickEventWindowsForRegion: NAC also matches the older NAE code (unconfirmed live, included defensively)', () => {
  const windows = [{ eventWindowId: 'X_Event1_NAE', endTime: '2020-01-01T00:00:00Z' }];
  const nacWindows = epicApi.pickEventWindowsForRegion(windows, 'NAC');
  assert.equal(nacWindows.length, 1);
});

test('getPlayerEventMatches: parses the real v1 matches response and caches it (fetchJson only called once)', async () => {
  let callCount = 0;
  await withStubbedFetchJson({
    '/api/v1/events/epicgames_S41_FNCSDivisionalCup_Division3_EU/S41_FNCSDivisionalCup_Division3_Event8_2_EU/player/b87297a442684bbaa6f4cbf4e12efb2d/matches?rankHint=505': REAL_MATCHES_RESPONSE,
  }, async () => {
    const original = epicApi.fetchJson;
    epicApi.fetchJson = async (path) => { callCount++; return original(path); };

    const result1 = await epicApi.getPlayerEventMatches(
      'epicgames_S41_FNCSDivisionalCup_Division3_EU', 'S41_FNCSDivisionalCup_Division3_Event8_2_EU',
      'b87297a442684bbaa6f4cbf4e12efb2d', 505
    );
    assert.equal(result1.rank, 502);
    assert.equal(result1.pointsEarned, 230);
    assert.equal(result1.matchCount, 8);

    const result2 = await epicApi.getPlayerEventMatches(
      'epicgames_S41_FNCSDivisionalCup_Division3_EU', 'S41_FNCSDivisionalCup_Division3_Event8_2_EU',
      'b87297a442684bbaa6f4cbf4e12efb2d', 505
    );
    assert.deepEqual(result2, result1);
    assert.equal(callCount, 1, 'second call should be served from cache, not a second fetch');
  });
});

test('getPlayerEventMatches: uses the v1 scanning path, not v2 — confirmed live that v2 fails with "No standing found" on the same real data', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/eid/ewid/player/acc/matches': REAL_MATCHES_RESPONSE,
  }, async () => {
    const result = await epicApi.getPlayerEventMatches('eid', 'ewid', 'acc');
    assert.ok(result, 'v1 path (no rankHint) should resolve using the real confirmed URL shape');
  });
});

test('getPlayerEventMatches: found:false resolves to null, not the raw response', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/eid/ewid/player/acc/matches': { found: false },
  }, async () => {
    const result = await epicApi.getPlayerEventMatches('eid', 'ewid', 'acc');
    assert.equal(result, null);
  });
});

test('detectBuildModeFromEpicId: confirmed against every real id from live testing', () => {
  assert.equal(detectBuildModeFromEpicId('Season41_RankedCupDuosZB'), 'zero_build');
  assert.equal(detectBuildModeFromEpicId('Season41_RankedCupReloadDuos'), 'reload');
  assert.equal(detectBuildModeFromEpicId('Season41_RankedCupDuos'), null, 'no marker at all — not evidence of Battle Royale by itself');
  assert.equal(detectBuildModeFromEpicId('Season41_RankedCupSolo'), null);
  assert.equal(detectBuildModeFromEpicId('Season41_RankedCupSoloReload'), 'reload');
  assert.equal(detectBuildModeFromEpicId('S41_ConsoleVCC_SolosZB'), 'zero_build');
  assert.equal(detectBuildModeFromEpicId('S41_CashCup_DuosZB'), 'zero_build');
  assert.equal(detectBuildModeFromEpicId('EventTemplate_RankedCupDuosZB'), 'zero_build');
  assert.equal(detectBuildModeFromEpicId('Season41_ReloadSoloVictoryCup'), 'reload');
  // Real counter-example: two live calendar entries for "Champion Aphrodite FNCS Cup" shared the
  // identical top-level id "S41_FNCSCommunityCup" — the ZB/non-ZB distinction lived in a second,
  // unconfirmed-field-name token this function is never given. Must return null (no false signal),
  // not guess.
  assert.equal(detectBuildModeFromEpicId('S41_FNCSCommunityCup'), null);
});

test('detectBuildModeFromEpicId: checks multiple candidate strings, no false-positive word-boundary issue on glued markers', () => {
  // "DuosZB" has no separator between "Duos" and "ZB" — a \bzb\b regex would never match this.
  assert.equal(detectBuildModeFromEpicId(null, 'EventTemplate_RankedCupDuosZB'), 'zero_build');
  assert.equal(detectBuildModeFromEpicId(undefined, undefined), null);
});

test('getEpicOwnTournamentModifier: end-to-end against the real shapes — resolves eventWindow by region, computes the same formula shape as computeOwnTournamentModifier', async () => {
  const pastEndTime = new Date(Date.now() - 3 * 86400000).toISOString(); // 3 days ago — robust against whenever this test actually runs
  await withStubbedFetchJson({
    '/api/v1/events/global': [
      {
        id: 'Season41_RankedCupDuosZB',
        name: 'Duos Ranked Cup (Zero Build)',
        eventWindows: [
          { ...REAL_RANKED_CUP_DUOS_ZB_WINDOW, endTime: pastEndTime }, // BR — should be excluded for an EU tournament
          { ...REAL_RANKED_CUP_DUOS_ZB_WINDOW, eventWindowId: 'S41_RankedCupDuosZB_Event7_EU', endTime: pastEndTime },
        ],
      },
    ],
    '/api/v1/events/global/history': [],
    '/api/v1/events/epicgames_S41_RankedCupDuosZB_EU/S41_RankedCupDuosZB_Event7_EU/player/myaccount/matches': {
      found: true, eventWindowId: 'S41_RankedCupDuosZB_Event7_EU', rank: 250, pointsEarned: 400,
    },
  }, async () => {
    const tournament = { name: 'Duos Ranked Cup (Zero Build)', eventId: 'epicgames_S41_RankedCupDuosZB_EU', region: 'EU' };
    const result = await epicApi.getEpicOwnTournamentModifier(tournament, 'myaccount', { getPlacementScore });

    assert.ok(result);
    assert.equal(result.source, 'epic');
    assert.equal(result.matchedWindows.length, 1);
    assert.equal(result.matchedWindows[0].eventWindowId, 'S41_RankedCupDuosZB_Event7_EU');
    // rank 250 -> placementScores threshold 300 -> score 100 -> (100/100)*0.30 = 0.30
    assert.equal(result.modifier, getPlacementScore(250) / 100 * 0.30);
  });
});

test('getEpicOwnTournamentModifier: returns null (not a throw) when the tournament has no eventId', async () => {
  const result = await epicApi.getEpicOwnTournamentModifier({ name: 'X', region: 'EU' }, 'myaccount', { getPlacementScore });
  assert.equal(result, null);
});

test('getEpicOwnTournamentModifier: returns null when no calendar entry matches by name (Epic never called for matches)', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/global': [],
    '/api/v1/events/global/history': [],
  }, async () => {
    const tournament = { name: 'Totally Unknown Cup', eventId: 'epicgames_x_EU', region: 'EU' };
    const result = await epicApi.getEpicOwnTournamentModifier(tournament, 'myaccount', { getPlacementScore });
    assert.equal(result, null);
  });
});
