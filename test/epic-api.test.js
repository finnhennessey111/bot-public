// Verifies epic-api.js's parsing/matching logic against the REAL response shape confirmed live
// this session: a flat array of tournament objects, each with `regions` keyed by region CODE
// (EU/ME/NAE/NAC/NAW/BR), each holding a one-element array of a fully region-scoped entry with its
// own real eventId/beginTime/endTime/platforms/eventWindows. An earlier version of this file (and
// of epic-api.js itself) was built against an incomplete/incorrect guess at this shape — this
// rewrite replaces those fixtures with the real confirmed one. fetchJson is stubbed throughout
// (module.exports delegation, same precedent as scraper.js's scrapePlayer/scrapePlayerOnce — see
// test/scraper-retry.test.js) so every test here runs with no real network round trip and no
// FORTNITE_API_KEY required.
const test = require('node:test');
const assert = require('node:assert/strict');

const epicApi = require('../epic-api');

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

test.beforeEach(() => {
  epicApi.__resetCacheForTests();
});

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}
function pastIso(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

function eventWindow(id, hoursFromNow) {
  return {
    eventWindowId: id,
    eventTemplateId: 'EventTemplate_PSTypicalGamer_ZB',
    round: 1,
    beginTime: futureIso(hoursFromNow),
    endTime: futureIso(hoursFromNow + 3),
    link: { type: 'br:tournament', code: `tournament_epicgames_${id.toLowerCase()}` },
  };
}

// The real confirmed shape, pasted from live manual testing — regions keyed by code, NAE/NAC
// holding byte-identical duplicate content (confirmed real), a real eventId/platforms per region.
const REAL_PS_TYPICAL_GAMER_ENTRY = {
  id: 'S41_PSTypicalGamer_ZB::s41_ps_typical_zb',
  name: 'PlayStation Typical Gamer Icon Cup',
  regions: {
    EU: [{
      eventId: 'epicgames_S41_PSTypicalGamer_ZB_EU',
      beginTime: futureIso(20), endTime: futureIso(140),
      regions: ['EU'], platforms: ['PS4', 'PS5'],
      eventWindows: [eventWindow('S41_PSTypicalGamer_ZB_Qualifier_EU', 20), eventWindow('S41_PSTypicalGamer_ZB_Final_EU', 100)],
      link: { type: 'br:tournament', code: 'tournament_epicgames_s41_pstypicalgamer_zb_eu' },
    }],
    ME: [{
      eventId: 'epicgames_S41_PSTypicalGamer_ZB_ME',
      beginTime: futureIso(20), endTime: futureIso(140),
      regions: ['ME'], platforms: ['PS4', 'PS5'],
      eventWindows: [eventWindow('S41_PSTypicalGamer_ZB_Qualifier_ME', 20)],
      link: { type: 'br:tournament', code: 'tournament_epicgames_s41_pstypicalgamer_zb_me' },
    }],
    NAE: [{
      eventId: 'epicgames_S41_PSTypicalGamer_ZB_NAC',
      beginTime: futureIso(20), endTime: futureIso(140),
      regions: ['NAE', 'NAC'], platforms: ['PS4', 'PS5'],
      eventWindows: [eventWindow('S41_PSTypicalGamer_ZB_Qualifier_NAC', 20)],
      link: { type: 'br:tournament', code: 'tournament_epicgames_s41_pstypicalgamer_zb_nac' },
    }],
    NAC: [{ // byte-identical duplicate of NAE, confirmed live
      eventId: 'epicgames_S41_PSTypicalGamer_ZB_NAC',
      beginTime: futureIso(20), endTime: futureIso(140),
      regions: ['NAE', 'NAC'], platforms: ['PS4', 'PS5'],
      eventWindows: [eventWindow('S41_PSTypicalGamer_ZB_Qualifier_NAC', 20)],
      link: { type: 'br:tournament', code: 'tournament_epicgames_s41_pstypicalgamer_zb_nac' },
    }],
    NAW: [{
      eventId: 'epicgames_S41_PSTypicalGamer_ZB_NAW',
      beginTime: futureIso(20), endTime: futureIso(140),
      regions: ['NAW'], platforms: ['PS4', 'PS5'],
      eventWindows: [eventWindow('S41_PSTypicalGamer_ZB_Qualifier_NAW', 20)],
      link: { type: 'br:tournament', code: 'tournament_epicgames_s41_pstypicalgamer_zb_naw' },
    }],
    BR: [{ // Brazil — a real region, nothing to do with Battle Royale build mode
      eventId: 'epicgames_S41_PSTypicalGamer_ZB_BR',
      beginTime: futureIso(20), endTime: futureIso(140),
      regions: ['BR'], platforms: ['PS4', 'PS5'],
      eventWindows: [eventWindow('S41_PSTypicalGamer_ZB_Qualifier_BR', 20)],
      link: { type: 'br:tournament', code: 'tournament_epicgames_s41_pstypicalgamer_zb_br' },
    }],
  },
};

test('normalizeEventEntry: extracts id/name/regions from the real confirmed shape', () => {
  const entry = epicApi.normalizeEventEntry(REAL_PS_TYPICAL_GAMER_ENTRY);
  assert.equal(entry.id, 'S41_PSTypicalGamer_ZB::s41_ps_typical_zb');
  assert.equal(entry.name, 'PlayStation Typical Gamer Icon Cup');
  assert.ok(entry.regions.EU);
  assert.ok(entry.regions.NAC);
});

test('normalizeEventEntry: returns null for a non-object or an entry missing id/name', () => {
  assert.equal(epicApi.normalizeEventEntry(null), null);
  assert.equal(epicApi.normalizeEventEntry({ name: 'X' }), null); // no id
  assert.equal(epicApi.normalizeEventEntry({ id: 'X' }), null); // no name
});

test('getRegionEntry: direct key lookup returns the region-scoped entry with its own real eventId/platforms', () => {
  const entry = epicApi.normalizeEventEntry(REAL_PS_TYPICAL_GAMER_ENTRY);

  const eu = epicApi.getRegionEntry(entry, 'EU');
  assert.equal(eu.eventId, 'epicgames_S41_PSTypicalGamer_ZB_EU');
  assert.deepEqual(eu.platforms, ['PS4', 'PS5']);
  assert.equal(eu.eventWindows.length, 2);

  const nac = epicApi.getRegionEntry(entry, 'NAC');
  assert.equal(nac.eventId, 'epicgames_S41_PSTypicalGamer_ZB_NAC');
});

test('getRegionEntry: NAE and NAC hold byte-identical content — only NAC is ever read, NAE is simply never looked up', () => {
  const entry = epicApi.normalizeEventEntry(REAL_PS_TYPICAL_GAMER_ENTRY);
  const nac = epicApi.getRegionEntry(entry, 'NAC');
  const nae = epicApi.getRegionEntry(entry, 'NAE'); // this bot never actually calls this in production — proving it WOULD be identical if it did
  assert.deepEqual(nac, nae);
});

test('getRegionEntry: a region this tournament isn\'t offered in (or an unsupported one) returns null, not a crash', () => {
  const entry = epicApi.normalizeEventEntry(REAL_PS_TYPICAL_GAMER_ENTRY);
  assert.equal(epicApi.getRegionEntry(entry, 'OCE'), null);
  assert.equal(epicApi.getRegionEntry(entry, 'ASIA'), null);
  assert.equal(epicApi.getRegionEntry(null, 'EU'), null);
});

test('consoleOnlyFromPlatforms: the real confirmed PS4/PS5-only example resolves to console-only true', () => {
  assert.equal(epicApi.consoleOnlyFromPlatforms(['PS4', 'PS5']), true);
});

test('consoleOnlyFromPlatforms: presence of a PC-capable code means definitely not console-only', () => {
  assert.equal(epicApi.consoleOnlyFromPlatforms(['PC', 'PS4', 'PS5']), false);
  assert.equal(epicApi.consoleOnlyFromPlatforms(['KBM']), false);
});

test('consoleOnlyFromPlatforms: missing/empty/unrecognized platforms returns null (no confident answer), not a guess', () => {
  assert.equal(epicApi.consoleOnlyFromPlatforms(undefined), null);
  assert.equal(epicApi.consoleOnlyFromPlatforms([]), null);
  assert.equal(epicApi.consoleOnlyFromPlatforms(['SOME_FUTURE_PLATFORM_CODE']), null);
});

test('findEventEntryByName: matches an upcoming event by exact (case-insensitive) name, returns the real nested regions object', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/global': [REAL_PS_TYPICAL_GAMER_ENTRY],
    '/api/v1/events/global/history': [],
  }, async () => {
    const entry = await epicApi.findEventEntryByName('platstation typical gamer icon cup'.replace('platstation', 'playstation'));
    assert.ok(entry);
    assert.equal(entry.id, 'S41_PSTypicalGamer_ZB::s41_ps_typical_zb');
    assert.ok(epicApi.getRegionEntry(entry, 'EU'));
  });
});

test('findEventEntryByName: falls back to the history list when not found upcoming', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/global': [],
    '/api/v1/events/global/history': [REAL_PS_TYPICAL_GAMER_ENTRY],
  }, async () => {
    const entry = await epicApi.findEventEntryByName('PlayStation Typical Gamer Icon Cup');
    assert.ok(entry);
  });
});

test('findEventEntryByName: returns null when no calendar entry matches either list', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/global': [REAL_PS_TYPICAL_GAMER_ENTRY],
    '/api/v1/events/global/history': [],
  }, async () => {
    const entry = await epicApi.findEventEntryByName('Some Tournament That Does Not Exist');
    assert.equal(entry, null);
  });
});

test('findEventEntryByName: a fetchJson failure (rate limit / network error) resolves to null, never throws', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/global': null,
    '/api/v1/events/global/history': null,
  }, async () => {
    const entry = await epicApi.findEventEntryByName('PlayStation Typical Gamer Icon Cup');
    assert.equal(entry, null);
  });
});

test('getPlayerEventMatches: parses the real v1 matches response and caches it (fetchJson only called once)', async () => {
  const REAL_MATCHES_RESPONSE = {
    found: true,
    eventId: 'epicgames_S41_FNCSDivisionalCup_Division3_EU',
    eventWindowId: 'S41_FNCSDivisionalCup_Division3_Event8_2_EU',
    accountId: 'b87297a442684bbaa6f4cbf4e12efb2d',
    rank: 502, pointsEarned: 230, matchCount: 8,
    teamAccountIds: ['b87297a442684bbaa6f4cbf4e12efb2d', 'dfa61fc098ed477aa3a13cf2131bb1e6'],
    matches: [],
  };
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

    const result2 = await epicApi.getPlayerEventMatches(
      'epicgames_S41_FNCSDivisionalCup_Division3_EU', 'S41_FNCSDivisionalCup_Division3_Event8_2_EU',
      'b87297a442684bbaa6f4cbf4e12efb2d', 505
    );
    assert.deepEqual(result2, result1);
    assert.equal(callCount, 1, 'second call should be served from cache, not a second fetch');
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

test('getEpicOwnTournamentModifier: end-to-end against the real shape — resolves the real per-region eventId itself, no dependency on tournament.eventId at all', async () => {
  // Real eventWindow beginTimes in the fixture above are all in the FUTURE (futureIso), so they
  // won't pass the "past window" filter — rebuild one past window inline so this test can exercise
  // the real matches-lookup path deterministically.
  const entryWithPastWindow = JSON.parse(JSON.stringify(REAL_PS_TYPICAL_GAMER_ENTRY));
  entryWithPastWindow.regions.EU[0].eventWindows = [{ eventWindowId: 'S41_PSTypicalGamer_ZB_Qualifier_EU', beginTime: pastIso(50), endTime: pastIso(47) }];

  await withStubbedFetchJson({
    '/api/v1/events/global': [entryWithPastWindow],
    '/api/v1/events/global/history': [],
    '/api/v1/events/epicgames_S41_PSTypicalGamer_ZB_EU/S41_PSTypicalGamer_ZB_Qualifier_EU/player/myaccount/matches': {
      found: true, eventWindowId: 'S41_PSTypicalGamer_ZB_Qualifier_EU', rank: 250, pointsEarned: 400,
    },
  }, async () => {
    // tournament deliberately has NO eventId — proves the real eventId comes from Epic's own
    // freshly-resolved regionEntry, not from anything the caller supplied.
    const tournament = { name: 'PlayStation Typical Gamer Icon Cup', region: 'EU' };
    const result = await epicApi.getEpicOwnTournamentModifier(tournament, 'myaccount', 500);

    assert.ok(result);
    assert.equal(result.source, 'epic');
    assert.equal(result.matchedWindows[0].eventWindowId, 'S41_PSTypicalGamer_ZB_Qualifier_EU');
    // PR-native: pointsEarned (400) as a fraction of currentPR (500), not a placement-bucket score.
    assert.equal(result.modifier, (400 / 500) * 0.30);
  });
});

test('getEpicOwnTournamentModifier: returns null (not a throw) when name, region, or currentPR is missing/zero', async () => {
  assert.equal(await epicApi.getEpicOwnTournamentModifier({ name: 'X' }, 'acc', 500), null);
  assert.equal(await epicApi.getEpicOwnTournamentModifier({ region: 'EU' }, 'acc', 500), null);
  assert.equal(await epicApi.getEpicOwnTournamentModifier({ name: 'X', region: 'EU' }, 'acc', 0), null);
});

test('getEpicOwnTournamentModifier: returns null when no calendar entry matches by name', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/global': [],
    '/api/v1/events/global/history': [],
  }, async () => {
    const tournament = { name: 'Totally Unknown Cup', region: 'EU' };
    const result = await epicApi.getEpicOwnTournamentModifier(tournament, 'myaccount', 500);
    assert.equal(result, null);
  });
});

test('getEpicOwnTournamentModifier: returns null when the tournament isn\'t offered in the requested region', async () => {
  await withStubbedFetchJson({
    '/api/v1/events/global': [REAL_PS_TYPICAL_GAMER_ENTRY],
    '/api/v1/events/global/history': [],
  }, async () => {
    const tournament = { name: 'PlayStation Typical Gamer Icon Cup', region: 'OCE' };
    const result = await epicApi.getEpicOwnTournamentModifier(tournament, 'myaccount', 500);
    assert.equal(result, null);
  });
});
