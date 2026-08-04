// Verifies tonight's flip of tournament calendar discovery from Fortnite Tracker to Epic
// (api-fortnite.com) as primary, with Fortnite Tracker as a genuine fallback only when Epic's call
// fails. Built against the real Epic payload shapes confirmed live this session (see
// test/epic-api.test.js's fixtures) — fetchJson/epicApi functions are stubbed throughout, no real
// network round trip anywhere in this file.
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

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}
function pastIso(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

// A window for each of this bot's 3 real region suffixes, plus a Brazil ("BR") one that must never
// surface (not a SUPPORTED_REGIONS entry) — same suffix convention confirmed real this session
// (eventWindowId's trailing token).
function windowsForAllRegions(prefix, hoursFromNow) {
  return ['EU', 'NAC', 'ME', 'BR'].map(suffix => ({
    eventWindowId: `${prefix}_${suffix}`,
    eventTemplateId: `EventTemplate_${prefix}`,
    beginTime: futureIso(hoursFromNow),
    endTime: futureIso(hoursFromNow + 3),
  }));
}

test('scrapeEpicCalendar: splits one Epic entry into one group per supported region, excludes the Brazil (BR) window entirely', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    { id: 'Season41_RankedCupDuosZB', name: 'Duos Ranked Cup (Zero Build)', eventWindows: windowsForAllRegions('S41_RankedCupDuosZB_Event7', 20) },
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    const regions = groups.map(g => g.region).sort();
    assert.deepEqual(regions, ['EU', 'ME', 'NAC']);
    assert.ok(groups.every(g => g.name === 'Duos Ranked Cup (Zero Build)'));
    assert.ok(groups.every(g => g.buildMode === 'zero_build'), 'title-word build-mode detection should already classify this correctly (same shared buildTournamentGroups logic)');
  });
});

test('scrapeEpicCalendar: synthetic eventId is stable and unique per tournament+region, prefixed "epic_"', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    { id: 'Season41_RankedCupDuosZB', name: 'Duos Ranked Cup (Zero Build)', eventWindows: windowsForAllRegions('S41_RankedCupDuosZB_Event7', 20) },
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    const eu = groups.find(g => g.region === 'EU');
    assert.equal(eu.eventId, 'epic_Season41_RankedCupDuosZB_EU');
  });
});

test('scrapeEpicCalendar: a window whose suffix matches no supported region (unrecognized code) is silently skipped, not crashed on', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    {
      id: 'Season41_SomeNewCup', name: 'Some New Cup',
      eventWindows: [{ eventWindowId: 'X_Event1_OCE', beginTime: futureIso(20), endTime: futureIso(23) }],
    },
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.equal(groups.length, 0);
  });
});

test('scrapeEpicCalendar: consoleOnly heuristic — a real "Console" cup name is detected true, a regular cup is false', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    { id: 'S41_ConsoleCC_DuosZB', name: 'Console Duos ZB Cash Cup', eventWindows: windowsForAllRegions('S41_ConsoleCC_Event1', 20) },
    { id: 'Season41_RankedCupDuos', name: 'Duos Ranked Cup (Battle Royale)', eventWindows: windowsForAllRegions('S41_RankedCupDuos_Event1', 20) },
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    const consoleCup = groups.find(g => g.name === 'Console Duos ZB Cash Cup');
    const rankedDuos = groups.find(g => g.name === 'Duos Ranked Cup (Battle Royale)');
    assert.equal(consoleCup.consoleOnly, true);
    assert.equal(rankedDuos.consoleOnly, false);
  });
});

test('scrapeEpicCalendar: CONSOLE_ONLY_OVERRIDES wins over the keyword heuristic in both directions', () => {
  const originalOverrides = { ...tournamentScraper.CONSOLE_ONLY_OVERRIDES };
  try {
    Object.assign(tournamentScraper.CONSOLE_ONLY_OVERRIDES, {
      'secretly console cup': true, // doesn't literally need to say "console"... wait it does here, use a name that DOESN'T
      'totally normal name': true,
    });
    // Override forces true even though "totally normal name" has no "console" substring at all.
    assert.equal(tournamentScraper.detectConsoleOnlyFromEpic('Totally Normal Name', 'S41_Whatever'), true);
    // Override forces false even though the name literally says "console".
    Object.assign(tournamentScraper.CONSOLE_ONLY_OVERRIDES, { 'console cup that is actually open': false });
    assert.equal(tournamentScraper.detectConsoleOnlyFromEpic('Console Cup That Is Actually Open', 'S41_X'), false);
  } finally {
    for (const key of Object.keys(tournamentScraper.CONSOLE_ONLY_OVERRIDES)) delete tournamentScraper.CONSOLE_ONLY_OVERRIDES[key];
    Object.assign(tournamentScraper.CONSOLE_ONLY_OVERRIDES, originalOverrides);
  }
});

test('scrapeEpicCalendar: FNCS Finals is excluded (same blocked-keyword logic buildTournamentGroups already applies to Fortnite Tracker sessions)', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    { id: 'Season41_FNCSMajor2Finals', name: 'FNCS Major 2 Finals', eventWindows: windowsForAllRegions('S41_FNCSMajor2Finals_Event1', 20) },
    { id: 'Season41_FNCSLastChanceMajor', name: 'FNCS Global Championship Last Chance', eventWindows: windowsForAllRegions('S41_FNCSLastChance_Event1', 20) },
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.ok(!groups.some(g => g.name === 'FNCS Major 2 Finals'), 'FNCS Finals must still be excluded');
    assert.ok(groups.some(g => g.name === 'FNCS Global Championship Last Chance'), '"Last Chance" (fncs, no finals/heats) must still survive — same real distinction the codebase already relies on');
  });
});

test('scrapeEpicCalendar: FNCS Division is still marked permanent (PERMANENT_KEYWORDS unaffected by source)', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    { id: 'Season41_FNCSDivisionalCup_Division3', name: 'FNCS Division 3', eventWindows: windowsForAllRegions('S41_FNCSDivisionalCup_Division3_Event8', 20) },
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.ok(groups.length > 0);
    assert.ok(groups.every(g => g.isPermanent === true), 'FNCS Division must still get the permanent-channel treatment when discovered via Epic');
    assert.ok(groups.every(g => g.isMultiSession === true), '"fncs" keyword still marks it multi-session too');
  });
});

test('scrapeEpicCalendar: blocked keywords (mobile) still filter out entirely', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    { id: 'Season41_MobileSeriesOpenAll', name: 'Mobile Series', eventWindows: windowsForAllRegions('S41_Mobile_Event1', 20) },
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.equal(groups.length, 0);
  });
});

test('scrapeEpicCalendar: a window whose beginTime has already passed is filtered out (same past-time rule, source-agnostic)', async () => {
  await withStubbedFetchGlobalEvents(async () => [
    {
      id: 'Season41_RankedCupSolo', name: 'Solo Ranked Cup (Battle Royale)',
      eventWindows: [{ eventWindowId: 'X_Event1_EU', beginTime: pastIso(5), endTime: pastIso(2) }],
    },
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
    { id: 'Season41_RankedCupDuosZB', name: 'Duos Ranked Cup (Zero Build)', eventWindows: windowsForAllRegions('S41_RankedCupDuosZB_Event7', 20) },
  ], async () => {
    const groups = await tournamentScraper.scrapeEpicCalendar();
    assert.ok(groups.every(g => g.rosterSize === 2 && g.isTrios === false));
  });
});

// ── scrapeUpcomingTournaments: primary/fallback wiring ──────────────────────────────────────────

test('scrapeUpcomingTournaments: Epic succeeds — Fortnite Tracker calendar scrape is never even attempted', async () => {
  let ftCalled = false;
  await withStubbedFetchGlobalEvents(async () => [
    { id: 'Season41_RankedCupDuos', name: 'Duos Ranked Cup (Battle Royale)', eventWindows: windowsForAllRegions('X_Event1', 20) },
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

// ── enrichWithDescriptionRosterSize: must skip synthetic Epic eventIds ──────────────────────────

test('enrichWithDescriptionRosterSize: skips a synthetic "epic_..." eventId entirely (would always 404 against Fortnite Tracker, wastes a full Puppeteer launch)', async () => {
  let fetchCalled = false;
  const original = tournamentScraper.fetchEventDescriptionRosterSize;
  tournamentScraper.fetchEventDescriptionRosterSize = async () => { fetchCalled = true; return 3; };
  try {
    const groups = [{ name: 'Champion Aphrodite FNCS Cup', region: 'EU', rosterSize: null, eventId: 'epic_S41_FNCSCommunityCup_EU' }];
    await tournamentScraper.enrichWithDescriptionRosterSize(groups);
    assert.equal(fetchCalled, false);
    assert.equal(groups[0].rosterSize, null, 'stays unclassified — no Fortnite Tracker fallback available for a synthetic eventId');
  } finally {
    tournamentScraper.fetchEventDescriptionRosterSize = original;
  }
});

test('enrichWithDescriptionRosterSize: a real Fortnite-Tracker-shaped eventId still triggers the description fetch as before', async () => {
  let fetchCalled = false;
  const original = tournamentScraper.fetchEventDescriptionRosterSize;
  tournamentScraper.fetchEventDescriptionRosterSize = async () => { fetchCalled = true; return 2; };
  try {
    const groups = [{ name: 'Champion Aphrodite FNCS Cup', region: 'EU', rosterSize: null, eventId: 'epicgames_S41_FNCSCommunityCup_EU' }];
    await tournamentScraper.enrichWithDescriptionRosterSize(groups);
    assert.equal(fetchCalled, true);
    assert.equal(groups[0].rosterSize, 2);
  } finally {
    tournamentScraper.fetchEventDescriptionRosterSize = original;
  }
});

// ── enrichWithEpicRosterSize ─────────────────────────────────────────────────────────────────

test('enrichWithEpicRosterSize: overrides when Epic\'s id has an explicit marker, leaves unclassified groups alone when it doesn\'t', async () => {
  await withStubbedFindEventEntryByName(async (name) => {
    if (name === 'Duos Ranked Cup (Zero Build)') return { id: 'Season41_RankedCupDuosZB', name, eventWindows: [] };
    if (name === 'FNCS Division 3') return { id: 'Season41_FNCSDivisionalCup_Division3', name, eventWindows: [] }; // no team-size marker
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
