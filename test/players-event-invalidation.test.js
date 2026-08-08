// Verifies players.js's event-driven cache invalidation (invalidateStaleAfterEvent), the mechanism
// that replaces the old flat 24h active-player cache TTL. channel-manager.js calls this the moment
// a tracked, non-permanent tournament's REAL scraped endTime (Epic's own eventWindow endTime — see
// tournament-scraper.js's buildTournamentGroups, never a guessed/hardcoded schedule) passes for a
// region — and this does ONLY cheap, instant invalidation (null out lastUpdated via one Mongo
// update). The actual re-scrape still only happens lazily, via getPlayerStats' existing cache-miss
// path, on that player's next real queue action — same lazy-rescrape shape as the pre-existing
// beginTime-triggered rescrapeRegisteredPlayers.
//
// scraper.js's scrapePlayer delegates through module.exports.scrapePlayerOnce — stubbing that here
// intercepts every real scrape call players.js could make, so "zero scrape calls" assertions below
// prove invalidation never eagerly re-scrapes, not just that we forgot to check.
const test = require('node:test');
const assert = require('node:assert/strict');

const PlayerModel = require('../models/Player');
const scraperModule = require('../scraper');
const playerStore = require('../players');

function withPlayerModelStubs({ candidates = [] } = {}, fn) {
  const originalFind = PlayerModel.find;
  const originalUpdateMany = PlayerModel.updateMany;
  const originalScrapeOnce = scraperModule.scrapePlayerOnce;

  const updateManyCalls = [];
  const scrapeCalls = [];

  PlayerModel.find = () => ({ lean: async () => candidates });
  PlayerModel.updateMany = async (filter, update) => {
    updateManyCalls.push({ filter, update });
    return { acknowledged: true };
  };
  scraperModule.scrapePlayerOnce = async (...args) => {
    scrapeCalls.push(args);
    return { totalPR: 1, thisSeasonPR: 1, prBand: null, recentEvents: [] };
  };

  return Promise.resolve(fn({ updateManyCalls, scrapeCalls })).finally(() => {
    PlayerModel.find = originalFind;
    PlayerModel.updateMany = originalUpdateMany;
    scraperModule.scrapePlayerOnce = originalScrapeOnce;
  });
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000);

test('invalidateStaleAfterEvent: nulls lastUpdated for an active player whose cache predates the real event conclusion', async () => {
  const player = { _id: 'p1', lastUpdated: daysAgo(3), recentEvents: [{ name: 'X', date: daysAgo(3).toISOString() }] };
  const eventEndTime = daysAgo(1).toISOString(); // event concluded 1 day ago; player's cache is 2 days older than that

  await withPlayerModelStubs({ candidates: [player] }, async ({ updateManyCalls, scrapeCalls }) => {
    await playerStore.invalidateStaleAfterEvent('g1', 'EU', eventEndTime);

    assert.equal(updateManyCalls.length, 1, 'must issue exactly one cheap Mongo update, nothing more');
    assert.deepEqual(updateManyCalls[0].filter, { _id: { $in: ['p1'] } });
    assert.deepEqual(updateManyCalls[0].update, { $set: { lastUpdated: null } });
    assert.equal(scrapeCalls.length, 0, 'invalidation must never itself trigger a scrape — instant, cheap invalidation only, never eager');
  });
});

test('invalidateStaleAfterEvent: leaves a player alone whose cache was ALREADY refreshed after the event concluded — avoids a needless re-invalidation', async () => {
  const eventEndTime = daysAgo(2).toISOString();
  // Queued (and got a fresh scrape) AFTER the tournament ended — their snapshot already reflects
  // it, so re-nulling their cache would just force a pointless re-scrape for zero new signal.
  const alreadyFresh = { _id: 'p1', lastUpdated: daysAgo(1), recentEvents: [] };

  await withPlayerModelStubs({ candidates: [alreadyFresh] }, async ({ updateManyCalls }) => {
    await playerStore.invalidateStaleAfterEvent('g1', 'EU', eventEndTime);
    assert.equal(updateManyCalls.length, 0, 'a player already fresher than the event conclusion must not be touched at all — not even a no-op write');
  });
});

test('invalidateStaleAfterEvent: leaves a SETTLED player alone even if their cache predates the event', async () => {
  const eventEndTime = daysAgo(1).toISOString();
  const settledPlayer = {
    _id: 'p1', lastUpdated: daysAgo(3),
    recentEvents: [{ name: 'X', date: daysAgo(200).toISOString() }], // last competed 200 days ago
  };

  await withPlayerModelStubs({ candidates: [settledPlayer] }, async ({ updateManyCalls }) => {
    await playerStore.invalidateStaleAfterEvent('g1', 'EU', eventEndTime);
    assert.equal(updateManyCalls.length, 0, 'a tournament concluding says nothing about a player who has not competed in 90+ days');
  });
});

test('invalidateStaleAfterEvent: mixed batch — only the active, pre-event-cached player is touched, not the fresh or settled ones', async () => {
  const eventEndTime = daysAgo(1).toISOString();
  const staleActive = { _id: 'active-stale', lastUpdated: daysAgo(3), recentEvents: [{ name: 'X', date: daysAgo(3).toISOString() }] };
  const freshActive = { _id: 'active-fresh', lastUpdated: daysAgo(0.1), recentEvents: [{ name: 'X', date: daysAgo(3).toISOString() }] };
  const staleSettled = { _id: 'settled-stale', lastUpdated: daysAgo(3), recentEvents: [{ name: 'X', date: daysAgo(200).toISOString() }] };

  await withPlayerModelStubs({ candidates: [staleActive, freshActive, staleSettled] }, async ({ updateManyCalls }) => {
    await playerStore.invalidateStaleAfterEvent('g1', 'EU', eventEndTime);
    assert.equal(updateManyCalls.length, 1);
    assert.deepEqual(updateManyCalls[0].filter, { _id: { $in: ['active-stale'] } });
  });
});

test('invalidateStaleAfterEvent: an empty/all-excluded candidate set issues no update at all', async () => {
  await withPlayerModelStubs({ candidates: [] }, async ({ updateManyCalls }) => {
    await playerStore.invalidateStaleAfterEvent('g1', 'EU', daysAgo(1).toISOString());
    assert.equal(updateManyCalls.length, 0);
  });
});

// ── End-to-end: invalidation is instant, the actual re-scrape stays lazy ──────
test('lifecycle: invalidateStaleAfterEvent nulls the cache, and the NEXT real getPlayerStats call is what actually re-scrapes — not the invalidation itself', async () => {
  const player = {
    _id: 'p1', discordId: 'd1', guildId: 'g1', epicUsername: 'Player1', epicId: 'e1',
    totalPR: 500, thisSeasonPR: 0, prBand: null,
    recentEvents: [{ name: 'X', date: daysAgo(3).toISOString() }],
    lastUpdated: daysAgo(3),
  };
  const eventEndTime = daysAgo(1).toISOString();

  const originalFindOne = PlayerModel.findOne;
  const originalFindOneAndUpdate = PlayerModel.findOneAndUpdate;

  await withPlayerModelStubs({ candidates: [player] }, async ({ updateManyCalls, scrapeCalls }) => {
    await playerStore.invalidateStaleAfterEvent('g1', 'EU', eventEndTime);
    assert.equal(updateManyCalls.length, 1, 'invalidation itself is a single cheap update');
    assert.equal(scrapeCalls.length, 0, 'invalidation alone must not scrape');

    // Reflect the invalidation's effect (lastUpdated -> null) before the "next queue action".
    player.lastUpdated = null;

    PlayerModel.findOne = async () => player;
    PlayerModel.findOneAndUpdate = () => ({ lean: async () => ({}) });
    try {
      const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
      assert.equal(scrapeCalls.length, 1, 'the SUBSEQUENT real queue action is what actually triggers the lazy re-scrape');
      assert.equal(stats.totalPR, 1);
    } finally {
      PlayerModel.findOne = originalFindOne;
      PlayerModel.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });
});

// ── Cache stays valid across days where nothing relevant happened ────────────
test('cache stays valid across days where nothing relevant happened: no invalidateStaleAfterEvent call ever made means no expiry, no matter how many days pass', async () => {
  const existing = {
    totalPR: 500, thisSeasonPR: 0, prBand: null,
    recentEvents: [{ name: 'X', date: daysAgo(10).toISOString() }],
    lastUpdated: daysAgo(6),
  };
  const originalFindOne = PlayerModel.findOne;
  const originalScrapeOnce = scraperModule.scrapePlayerOnce;
  const scrapeCalls = [];
  PlayerModel.findOne = async () => existing;
  scraperModule.scrapePlayerOnce = async (...args) => {
    scrapeCalls.push(args);
    return { totalPR: 1, thisSeasonPR: 1, prBand: null, recentEvents: [] };
  };

  try {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
    assert.equal(scrapeCalls.length, 0, 'six days with no tracked event conclusion (and no invalidation call) must still be a cache hit');
    assert.equal(stats.totalPR, 500);
  } finally {
    PlayerModel.findOne = originalFindOne;
    scraperModule.scrapePlayerOnce = originalScrapeOnce;
  }
});
