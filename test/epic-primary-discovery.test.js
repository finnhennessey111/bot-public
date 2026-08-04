// Verifies tonight's flip of tournament calendar discovery from Fortnite Tracker to Epic
// (api-fortnite.com) as primary, with Fortnite Tracker as a genuine fallback only when Epic's call
// fails — rewritten against the REAL confirmed nested-region structure (see test/epic-api.test.js's
// fixtures/doc comment): `{ id, name, regions: { EU: [{eventId, platforms, eventWindows, ...}],
// NAC: [...], ME: [...], ... } }`. An earlier version of this file (and of epic-api.js/
// tournament-scraper.js's scrapeEpicCalendar) was built against an incomplete/incorrect guess at
// this shape (a flat top-level eventWindows array with a region-suffixed eventWindowId) — that
// silently produced zero results against real data. fetchJson/epicApi functions are stubbed
// throughout, no real network round trip anywhere in this file.
const test = require('node:test');
const assert = require('node:assert/strict');

const tournamentScraper = require('../tournament-scraper');
const epicApi = require('../epic-api');

function withStubbedFetchGlobalEvents(stub, fn) {
  const original = epicApi.fetchGlobalEvents;
  epicApi.fetchGlobalEvents = stub;
  return fn().finally(() => { epicApi.fetchGlobalEvents = original; });
}

function withStubbedScrapeTrackerCalendar(stub, fn) {
  const original = tournamentScraper.scrapeTrackerCalendar;
  tournamentScraper.scrapeTrackerCalendar = stub;
  return fn().finally(() => { tournamentScraper.scrapeTrackerCalendar = original; });
}

function withStubbedFindEventEntryByName(stub, fn) {
  const original = epicApi.findEventEntryByName;
  epicApi.findEventEntryByName = stub;
  return fn().finally(() => { epicApi.findEventEntryByName = original; });
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

function regionEntry(id, region, { hoursFromNow = 20, platforms = [], eventWindows } = {}) {
  return {
    eventId: `epicgames_${id}_${region}`,
    beginTime: futureIso(hoursFromNow),
    endTime: futureIso(hoursFromNow + 100),
    regions: [region],
    platforms,
    eventWindows: eventWindows ?? [{
      eventWindowId: `${id}_Qualifier_${region}`,
      eventTemplateId: `EventTemplate_${id}`,
      beginTime: futureIso(hoursFromNow),
      endTime: futureIso(hoursFromNow + 3),
    }],
    link: { type: 'br:tournament', code: `tournament_epicgames_${id.toLowerCase()}_${region.toLowerCase()}` },
  };
}

// Builds the real regions-keyed shape for this bot's 3 supported regions, plus BR (Brazil) by
// default to prove it's simply never read (not filtered by any special-case logic — the code just
// never looks up entry.regions.BR at all).
function realEntry(id, name, opts = {}) {
  const { includeBR = true, ...regionOpts } = opts;
  const regions = {
    EU: [regionEntry(id, 'EU', regionOpts)],
    NAC: [regionEntry(id, 'NAC', regionOpts)],
    ME: [regionEntry(id, 'ME', regionOpts)],
  };
  if (includeBR) regions.BR = [regionEntry(id, 'BR', regionOpts)];
  return { id, name, regions };
}

test('scrapeEpicCalendar: splits one Epic entry into one group per supported region, never reads the BR (Brazil) key at all', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    realEntry('S41_RankedCupDuosZB', 'Duos Ranked Cup (Zero Build)'),
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    const regions = groups.map(g => g.region).sort();
    assert.deepEqual(regions, ['EU', 'ME', 'NAC']);
    assert.ok(groups.every(g => g.name === 'Duos Ranked Cup (Zero Build)'));
    assert.ok(groups.every(g => g.buildMode === 'zero_build'), 'title-word build-mode detection should already classify this correctly (same shared buildTournamentGroups logic)');
  });
});

test('scrapeEpicCalendar: uses the real per-region eventId from regions[region][0].eventId, not a synthetic value', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    realEntry('S41_RankedCupDuosZB', 'Duos Ranked Cup (Zero Build)'),
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    const eu = groups.find(g => g.region === 'EU');
    assert.equal(eu.eventId, 'epicgames_S41_RankedCupDuosZB_EU');
  });
});

test('scrapeEpicCalendar: a tournament with no EU/NAC/ME region key at all (e.g. OCE-only) produces zero groups, not a crash', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    { id: 'Season41_SomeNewCup', name: 'Some New Cup', regions: { OCE: [regionEntry('Season41_SomeNewCup', 'OCE')] } },
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.equal(groups.length, 0);
  });
});

test('scrapeEpicCalendar: consoleOnly via the real platforms field — catches a PS-only cup whose NAME never says "console"', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    realEntry('S41_PSTypicalGamer_ZB', 'PlayStation Typical Gamer Icon Cup', { platforms: ['PS4', 'PS5'] }),
    realEntry('S41_RankedCupDuos', 'Duos Ranked Cup (Battle Royale)', { platforms: ['PC', 'PS4', 'PS5', 'XSX', 'XB1'] }),
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    const psCup = groups.find(g => g.name === 'PlayStation Typical Gamer Icon Cup');
    const rankedDuos = groups.find(g => g.name === 'Duos Ranked Cup (Battle Royale)');
    assert.equal(psCup.consoleOnly, true, 'the real platforms signal must catch this even with no "console" text anywhere in the name');
    assert.equal(rankedDuos.consoleOnly, false, 'PC is present in platforms, so definitely not console-only');
  });
});

test('scrapeEpicCalendar: consoleOnly falls back to the name/id keyword heuristic when platforms is absent/unrecognized', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    realEntry('S41_ConsoleCC_DuosZB', 'Console Duos ZB Cash Cup', { platforms: [] }), // no usable platforms signal
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.ok(groups.every(g => g.consoleOnly === true), 'falls back to the "console" keyword heuristic when platforms gives no confident answer');
  });
});

test('detectConsoleOnlyFromEpic: CONSOLE_ONLY_OVERRIDES wins over both the platforms signal and the keyword heuristic', () => {
  const originalOverrides = { ...tournamentScraper.CONSOLE_ONLY_OVERRIDES };
  try {
    Object.assign(tournamentScraper.CONSOLE_ONLY_OVERRIDES, { 'totally normal name': true });
    // Override forces true even with PC clearly present in platforms (which would otherwise say false).
    assert.equal(tournamentScraper.detectConsoleOnlyFromEpic('Totally Normal Name', 'S41_Whatever', ['PC', 'PS4']), true);

    Object.assign(tournamentScraper.CONSOLE_ONLY_OVERRIDES, { 'console cup that is actually open': false });
    // Override forces false even though the name literally says "console" and platforms is PS-only.
    assert.equal(tournamentScraper.detectConsoleOnlyFromEpic('Console Cup That Is Actually Open', 'S41_X', ['PS4', 'PS5']), false);
  } finally {
    for (const key of Object.keys(tournamentScraper.CONSOLE_ONLY_OVERRIDES)) delete tournamentScraper.CONSOLE_ONLY_OVERRIDES[key];
    Object.assign(tournamentScraper.CONSOLE_ONLY_OVERRIDES, originalOverrides);
  }
});

test('scrapeEpicCalendar: FNCS Finals is excluded (same blocked-keyword logic buildTournamentGroups already applies to Fortnite Tracker sessions)', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    realEntry('S41_FNCSMajor2Finals', 'FNCS Major 2 Finals'),
    realEntry('S41_FNCSLastChance', 'FNCS Global Championship Last Chance'),
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.ok(!groups.some(g => g.name === 'FNCS Major 2 Finals'), 'FNCS Finals must still be excluded');
    assert.ok(groups.some(g => g.name === 'FNCS Global Championship Last Chance'), '"Last Chance" (fncs, no finals/heats) must still survive — same real distinction the codebase already relies on');
  });
});

test('scrapeEpicCalendar: FNCS Division is still marked permanent (PERMANENT_KEYWORDS unaffected by source)', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    realEntry('S41_FNCSDivisionalCup_Division3', 'FNCS Division 3'),
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.ok(groups.length > 0);
    assert.ok(groups.every(g => g.isPermanent === true), 'FNCS Division must still get the permanent-channel treatment when discovered via Epic');
    assert.ok(groups.every(g => g.isMultiSession === true), '"fncs" keyword still marks it multi-session too');
  });
});

test('scrapeEpicCalendar: blocked keywords (mobile) still filter out entirely', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    realEntry('S41_MobileSeriesOpenAll', 'Mobile Series'),
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.equal(groups.length, 0);
  });
});

test('scrapeEpicCalendar: a window whose beginTime has already passed is filtered out (same past-time rule, source-agnostic)', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    realEntry('S41_RankedCupDuos', 'Duos Ranked Cup (Battle Royale)', {
      eventWindows: [{ eventWindowId: 'X_Event1', eventTemplateId: 'EventTemplate_X', beginTime: pastIso(5), endTime: pastIso(2) }],
    }),
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.equal(groups.length, 0);
  });
});

test('scrapeEpicCalendar: returns null (not []) when Epic\'s fetch fails outright — distinguishes "try the fallback" from "a real but empty result"', async () => {
  await withStubbedFetchGlobalEvents(async () => null, async () => {
    const result = await tournamentScraper.scrapeEpicCalendar();
    assert.equal(result, null);
  });
});

test('scrapeEpicCalendar: roster size cross-check via Epic\'s id — "RankedCupDuosZB" resolves to Duos even though buildTournamentGroups\' own title-based check already agrees', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    realEntry('S41_RankedCupDuosZB', 'Duos Ranked Cup (Zero Build)'),
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.ok(groups.every(g => g.rosterSize === 2 && g.isTrios === false));
  });
});

// ── scrapeUpcomingTournaments: primary/fallback wiring ──────────────────────────────────────────

test('scrapeUpcomingTournaments: Epic succeeds — Fortnite Tracker calendar scrape is never even attempted', async () => {
  let ftCalled = false;
  await withStubbedFetchGlobalEvents(async () => [
    realEntry('S41_RankedCupDuos', 'Duos Ranked Cup (Battle Royale)'),
  ], async () => {
    await withStubbedScrapeTrackerCalendar(async () => { ftCalled = true; return []; }, async () => {
      const groups = await tournamentScraper.scrapeUpcomingTournaments();
      assert.ok(groups.length > 0);
      assert.equal(ftCalled, false, 'Fortnite Tracker\'s calendar scrape must not run when Epic already served a real result — that\'s the whole point of the flip');
    });
  });
});

test('scrapeUpcomingTournaments: Epic\'s fetch fails (returns null) — Fortnite Tracker fallback genuinely fires', async () => {
  let ftCalled = false;
  await withStubbedFetchGlobalEvents(async () => null, async () => {
    await withStubbedScrapeTrackerCalendar(async () => { ftCalled = true; return [{ name: 'FT Fallback Result', region: 'EU' }]; }, async () => {
      const groups = await tournamentScraper.scrapeUpcomingTournaments();
      assert.equal(ftCalled, true, 'Fortnite Tracker must be tried when Epic genuinely has nothing');
      assert.deepEqual(groups, [{ name: 'FT Fallback Result', region: 'EU' }]);
    });
  });
});

test('scrapeUpcomingTournaments: Epic throws (not just returns null) — still falls back to Fortnite Tracker, never rejects', async () => {
  let ftCalled = false;
  const original = tournamentScraper.scrapeEpicCalendar;
  tournamentScraper.scrapeEpicCalendar = async () => { throw new Error('simulated Epic 500'); };
  try {
    await withStubbedScrapeTrackerCalendar(async () => { ftCalled = true; return []; }, async () => {
      await assert.doesNotReject(() => tournamentScraper.scrapeUpcomingTournaments());
      assert.equal(ftCalled, true);
    });
  } finally {
    tournamentScraper.scrapeEpicCalendar = original;
  }
});

// ── enrichWithDescriptionRosterSize: real Epic eventIds now work fine, the defensive guard is a no-op ──

test('enrichWithDescriptionRosterSize: a real Epic-sourced eventId (epicgames_..._EU) is treated the same as a Fortnite-Tracker-sourced one — triggers the description fetch normally', async () => {
  let fetchCalled = false;
  const original = tournamentScraper.fetchEventDescriptionRosterSize;
  tournamentScraper.fetchEventDescriptionRosterSize = async () => { fetchCalled = true; return 2; };
  try {
    const groups = [{ name: 'Champion Aphrodite FNCS Cup', region: 'EU', rosterSize: null, eventId: 'epicgames_S41_FNCSCommunityCup_EU' }];
    await tournamentScraper.enrichWithDescriptionRosterSize(groups);
    assert.equal(fetchCalled, true, 'a real epicgames_..._EU-shaped id (whichever scraper produced it) should resolve correctly against Fortnite Tracker\'s own event pages');
    assert.equal(groups[0].rosterSize, 2);
  } finally {
    tournamentScraper.fetchEventDescriptionRosterSize = original;
  }
});

test('enrichWithDescriptionRosterSize: the defensive "epic_..." synthetic-id guard still skips that specific (now-unused-in-practice) shape', async () => {
  let fetchCalled = false;
  const original = tournamentScraper.fetchEventDescriptionRosterSize;
  tournamentScraper.fetchEventDescriptionRosterSize = async () => { fetchCalled = true; return 3; };
  try {
    const groups = [{ name: 'Champion Aphrodite FNCS Cup', region: 'EU', rosterSize: null, eventId: 'epic_S41_FNCSCommunityCup_EU' }];
    await tournamentScraper.enrichWithDescriptionRosterSize(groups);
    assert.equal(fetchCalled, false);
  } finally {
    tournamentScraper.fetchEventDescriptionRosterSize = original;
  }
});

// ── enrichWithEpicRosterSize / enrichWithEpicBuildMode: region-aware eventWindows access ────────

test('enrichWithEpicRosterSize: overrides when Epic\'s id has an explicit marker, leaves unclassified groups alone when it doesn\'t', async () => {
  await withStubbedFindEventEntryByName(async (name) => {
    if (name === 'Duos Ranked Cup (Zero Build)') return realEntry('Season41_RankedCupDuosZB', name);
    if (name === 'FNCS Division 3') return realEntry('Season41_FNCSDivisionalCup_Division3', name); // no team-size marker anywhere
    return null;
  }, async () => {
    const groups = [
      { name: 'Duos Ranked Cup (Zero Build)', region: 'EU', rosterSize: null, isTrios: false },
      { name: 'FNCS Division 3', region: 'EU', rosterSize: null, isTrios: false },
    ];
    await tournamentScraper.enrichWithEpicRosterSize(groups);
    assert.equal(groups[0].rosterSize, 2, 'Epic\'s "Duos" marker should resolve this to 2');
    assert.equal(groups[1].rosterSize, null, 'FNCSDivisionalCup has no marker in Epic\'s id either — must stay unclassified, not guessed');
  });
});

test('enrichWithEpicBuildMode: reads eventTemplateId from the correct region bucket (group.region), not a top-level field that no longer exists', async () => {
  await withStubbedFindEventEntryByName(async (name) => realEntry('Season41_RankedCupDuosZB', name), async () => {
    const groups = [{ name: 'Duos Ranked Cup (Zero Build)', region: 'ME', buildMode: 'battle_royale' }];
    await tournamentScraper.enrichWithEpicBuildMode(groups);
    assert.equal(groups[0].buildMode, 'zero_build');
  });
});
