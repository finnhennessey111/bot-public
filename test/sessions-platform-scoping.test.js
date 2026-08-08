// Verifies Sessions (Fortnite Tracker's own scraped lifetime session count — scraper.js's
// parseProfileData, same page load thisSeasonPR's DOM read already uses) is platform-scoped the
// same way PR already is: a player's HOME/PC-context sessions and their Console (gamepad-segment)
// context sessions are cached, read, and returned completely independently — never mixed up or
// falling back to the wrong one — via the exact same statsByContext mechanism players.js already
// uses for totalPR/thisSeasonPR/recentEvents.
//
// Same "stub the Model + scraperModule.scrapePlayerOnce" precedent as
// test/players-contextual-pr.test.js — no real Puppeteer/MongoDB round trip.
const test = require('node:test');
const assert = require('node:assert/strict');

const PlayerModel = require('../models/Player');
const scraperModule = require('../scraper');
const playerStore = require('../players');

function withStubs({ findOneResult = null, scrapeImpl } = {}, fn) {
  const originalFindOne = PlayerModel.findOne;
  const originalUpdateOne = PlayerModel.updateOne;
  const originalFindOneAndUpdate = PlayerModel.findOneAndUpdate;
  const originalScrapeOnce = scraperModule.scrapePlayerOnce;

  const updateOneCalls = [];
  const findOneAndUpdateCalls = [];
  const scrapeCalls = [];

  PlayerModel.findOne = async () => findOneResult;
  PlayerModel.updateOne = async (filter, update) => {
    updateOneCalls.push({ filter, update });
    return { acknowledged: true };
  };
  PlayerModel.findOneAndUpdate = (filter, update) => {
    findOneAndUpdateCalls.push({ filter, update });
    return { lean: async () => ({}) };
  };
  scraperModule.scrapePlayerOnce = async (epicUsername, region, epicId, platformSegment) => {
    scrapeCalls.push({ epicUsername, region, epicId, platformSegment });
    return scrapeImpl
      ? scrapeImpl(region, platformSegment)
      : { totalPR: 111, thisSeasonPR: 11, prBand: null, recentEvents: [], sessions: 42 };
  };

  return Promise.resolve(fn({ updateOneCalls, findOneAndUpdateCalls, scrapeCalls })).finally(() => {
    PlayerModel.findOne = originalFindOne;
    PlayerModel.updateOne = originalUpdateOne;
    PlayerModel.findOneAndUpdate = originalFindOneAndUpdate;
    scraperModule.scrapePlayerOnce = originalScrapeOnce;
  });
}

// ── getPlayerStats (home context) ─────────────────────────────────────────────
test('getPlayerStats: cache MISS scrapes fresh sessions and persists it via upsertPlayer', async () => {
  await withStubs(
    { findOneResult: null, scrapeImpl: () => ({ totalPR: 500, thisSeasonPR: 10, prBand: null, recentEvents: [], sessions: 392 }) },
    async ({ findOneAndUpdateCalls }) => {
      const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
      assert.equal(stats.sessions, 392);

      const persisted = findOneAndUpdateCalls[0].update.$set;
      assert.equal(persisted.sessions, 392, 'sessions must be part of what upsertPlayer actually writes to Mongo');
    }
  );
});

test('getPlayerStats: cache HIT returns sessions from the already-cached document, no re-scrape', async () => {
  const existing = {
    totalPR: 500, thisSeasonPR: 0, prBand: null, recentEvents: [], sessions: 250,
    lastUpdated: new Date(),
  };
  await withStubs({ findOneResult: existing }, async ({ scrapeCalls }) => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
    assert.equal(scrapeCalls.length, 0);
    assert.equal(stats.sessions, 250);
  });
});

test('getPlayerStats: a player scraped before Sessions existed (no field at all) returns null, not a crash or a fabricated 0', async () => {
  const existing = {
    totalPR: 500, thisSeasonPR: 0, prBand: null, recentEvents: [],
    lastUpdated: new Date(), // sessions field genuinely absent on this doc
  };
  await withStubs({ findOneResult: existing }, async () => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
    assert.equal(stats.sessions, null);
  });
});

// ── getContextualPlayerStats (per region|platformSegment) ────────────────────
test('getContextualPlayerStats: a Console (gamepad) context scrape persists ITS OWN sessions count under that context key', async () => {
  await withStubs(
    { findOneResult: null, scrapeImpl: () => ({ totalPR: 900, thisSeasonPR: 0, prBand: null, recentEvents: [], sessions: 77 }) },
    async ({ updateOneCalls }) => {
      const stats = await playerStore.getContextualPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU', 'gamepad');
      assert.equal(stats.sessions, 77);

      const persisted = updateOneCalls[0].update.$set['statsByContext.EU|gamepad'];
      assert.equal(persisted.sessions, 77);
    }
  );
});

// ── The real "platform-scoping resolves correctly for both contexts" claim ───
test('getStatsForContext: a Console player queueing a console-only tournament gets their GAMEPAD-context sessions; the same player queueing a non-console tournament gets a completely different (kbm-context) sessions count — never mixed up', async () => {
  const scrapedByPlatformSegment = {
    gamepad: { totalPR: 900, thisSeasonPR: 0, prBand: null, recentEvents: [], sessions: 150 },
    kbm: { totalPR: 600, thisSeasonPR: 0, prBand: null, recentEvents: [], sessions: 60 },
  };

  await withStubs(
    { findOneResult: null, scrapeImpl: (region, platformSegment) => scrapedByPlatformSegment[platformSegment] },
    async ({ scrapeCalls }) => {
      const consoleOnlyJoin = await playerStore.getStatsForContext('g1', 'd1', 'Player1', 'e1', {
        homeRegion: 'EU', queueRegion: 'EU', platform: 'Console', tournamentConsoleOnly: true,
      });
      const regularJoin = await playerStore.getStatsForContext('g1', 'd1', 'Player1', 'e1', {
        homeRegion: 'EU', queueRegion: 'EU', platform: 'Console', tournamentConsoleOnly: false,
      });

      assert.equal(consoleOnlyJoin.stats.sessions, 150, 'console-only tournament must use the gamepad-context sessions');
      assert.equal(regularJoin.stats.sessions, 60, 'a non-console-only tournament (still a Console player) must use the kbm-context sessions, never the gamepad one');
      assert.notEqual(consoleOnlyJoin.stats.sessions, regularJoin.stats.sessions, 'the two contexts must genuinely be independent, not coincidentally equal');

      assert.deepEqual(scrapeCalls.map(c => c.platformSegment).sort(), ['gamepad', 'kbm']);
    }
  );
});

test('getStatsForContext: a PC player stays on the home/"all" context regardless of tournament type — sessions never diverges by consoleOnly', async () => {
  await withStubs(
    { findOneResult: null, scrapeImpl: () => ({ totalPR: 400, thisSeasonPR: 0, prBand: null, recentEvents: [], sessions: 33 }) },
    async ({ scrapeCalls }) => {
      const a = await playerStore.getStatsForContext('g1', 'd1', 'Player1', 'e1', {
        homeRegion: 'EU', queueRegion: 'EU', platform: 'PC', tournamentConsoleOnly: true,
      });
      const b = await playerStore.getStatsForContext('g1', 'd1', 'Player1', 'e1', {
        homeRegion: 'EU', queueRegion: 'EU', platform: 'PC', tournamentConsoleOnly: false,
      });
      assert.equal(a.stats.sessions, 33);
      assert.equal(b.stats.sessions, 33);
      assert.equal(scrapeCalls.every(c => c.platformSegment === 'all'), true, 'a PC player is always the "all" segment, never gamepad/kbm-specific');
    }
  );
});
