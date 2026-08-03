// Verifies players.js's three real changes together, since they share the same cache machinery:
//
//   #2 — split caching: a player whose most recent recorded event is already "settled" (older than
//   SETTLED_ACTIVITY_WINDOW_DAYS, ~90 days) gets a much longer cache TTL than one with recent/
//   current-season activity, cutting redundant re-scrapes of data that can't have changed. A player
//   with NO recorded events at all stays on the short TTL (they could start playing any day).
//
//   #3 — region-aware PR: a player queueing in a region that differs from their registered home
//   region gets a fresh, separate fetch for THAT region specifically, cached apart from (never
//   overwriting) their home-region snapshot.
//
//   #6 — platform-aware PR: a Console player gets their gamepad-segment PR for a console-exclusive
//   tournament, and their kbm-segment PR for a non-console-exclusive one — PC players are always
//   left on the 'all' segment regardless of tournament type (out of scope per the task this
//   shipped for).
//
// scraper.js's scrapePlayer delegates through module.exports.scrapePlayerOnce (its own documented
// pattern, for exactly this reason) — stubbing scraperModule.scrapePlayerOnce here intercepts every
// real scrapePlayer() call players.js makes, without touching Puppeteer/MongoDB at all. PlayerModel
// statics are stubbed directly (same precedent as test/epic-username-lower-backfill.test.js).
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
  const scrapeCalls = [];

  PlayerModel.findOne = async () => findOneResult;
  PlayerModel.updateOne = async (filter, update) => {
    updateOneCalls.push({ filter, update });
    return { acknowledged: true };
  };
  // upsertPlayer (players.js) — hit by getPlayerStats' cache-miss path, which persists via
  // findOneAndUpdate rather than updateOne.
  PlayerModel.findOneAndUpdate = () => ({ lean: async () => ({}) });
  scraperModule.scrapePlayerOnce = async (epicUsername, region, epicId, platformSegment) => {
    scrapeCalls.push({ epicUsername, region, epicId, platformSegment });
    return scrapeImpl
      ? scrapeImpl(region, platformSegment)
      : { totalPR: 111, thisSeasonPR: 11, prBand: null, recentEvents: [] };
  };

  return Promise.resolve(fn({ updateOneCalls, scrapeCalls })).finally(() => {
    PlayerModel.findOne = originalFindOne;
    PlayerModel.updateOne = originalUpdateOne;
    PlayerModel.findOneAndUpdate = originalFindOneAndUpdate;
    scraperModule.scrapePlayerOnce = originalScrapeOnce;
  });
}

// ── #2: cacheTtlMsFor ─────────────────────────────────────────────────────────
test('cacheTtlMsFor: recent activity (newest event within 90 days) gets the short TTL', () => {
  const recentEvents = [{ name: 'X', date: new Date(Date.now() - 5 * 86400000).toISOString() }];
  assert.equal(playerStore.cacheTtlMsFor(recentEvents), playerStore.RECENT_ACTIVITY_CACHE_TTL_MS);
});

test('cacheTtlMsFor: settled activity (newest event older than 90 days) gets the long TTL', () => {
  const oldEvents = [{ name: 'X', date: new Date(Date.now() - 200 * 86400000).toISOString() }];
  assert.equal(playerStore.cacheTtlMsFor(oldEvents), playerStore.SETTLED_CACHE_TTL_MS);
  assert.ok(playerStore.SETTLED_CACHE_TTL_MS > playerStore.RECENT_ACTIVITY_CACHE_TTL_MS, 'settled TTL must genuinely be longer, not just different');
});

test('cacheTtlMsFor: no recorded events at all stays on the SHORT TTL — never treated as settled', () => {
  assert.equal(playerStore.cacheTtlMsFor([]), playerStore.RECENT_ACTIVITY_CACHE_TTL_MS);
  assert.equal(playerStore.cacheTtlMsFor(undefined), playerStore.RECENT_ACTIVITY_CACHE_TTL_MS);
});

test('getPlayerStats: a settled player (old activity) is still a cache HIT well past the old 24h window — no scrape triggered', async () => {
  const oldEvents = [{ name: 'X', date: new Date(Date.now() - 200 * 86400000).toISOString() }];
  const existing = {
    totalPR: 500, thisSeasonPR: 0, prBand: null, recentEvents: oldEvents,
    lastUpdated: new Date(Date.now() - 5 * 86400000), // 5 days ago: stale under the OLD flat 24h TTL, fresh under the new settled TTL
  };

  await withStubs({ findOneResult: existing }, async ({ scrapeCalls }) => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
    assert.equal(scrapeCalls.length, 0, 'a settled player 5 days stale must NOT trigger a re-scrape (30-day settled TTL)');
    assert.equal(stats.totalPR, 500);
  });
});

test('getPlayerStats: a recently-active player past the 24h recent-activity TTL is a cache MISS — scrapes fresh', async () => {
  const recentEvents = [{ name: 'X', date: new Date(Date.now() - 2 * 86400000).toISOString() }];
  const existing = {
    totalPR: 500, thisSeasonPR: 0, prBand: null, recentEvents,
    lastUpdated: new Date(Date.now() - 25 * 3600000), // 25h ago: past the 24h recent-activity TTL
  };

  await withStubs({ findOneResult: existing, scrapeImpl: () => ({ totalPR: 999, thisSeasonPR: 5, prBand: null, recentEvents: [] }) }, async ({ scrapeCalls }) => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
    assert.equal(scrapeCalls.length, 1, 'an actively-competing player must still re-scrape on the short TTL');
    assert.equal(stats.totalPR, 999);
  });
});

// ── #3: region-aware PR ───────────────────────────────────────────────────────
test('getStatsForContext: same region as home, PC platform -> uses the home-context cache path, no contextual scrape', async () => {
  const existing = { totalPR: 300, thisSeasonPR: 0, prBand: null, recentEvents: [], lastUpdated: new Date() };
  await withStubs({ findOneResult: existing }, async ({ scrapeCalls }) => {
    const { stats, prContext } = await playerStore.getStatsForContext('g1', 'd1', 'Player1', 'e1', {
      homeRegion: 'EU', queueRegion: 'EU', platform: 'PC', tournamentConsoleOnly: false,
    });
    assert.equal(scrapeCalls.length, 0, 'already-fresh home cache must be reused, no scrape at all');
    assert.equal(stats.totalPR, 300);
    assert.deepEqual(prContext, { region: 'EU', platformSegment: 'all', isHomeRegion: true, isHomePlatform: true });
  });
});

test('getStatsForContext: queueing in a DIFFERENT region than home fetches that region specifically, keyed apart from home', async () => {
  await withStubs({ findOneResult: null, scrapeImpl: (region) => ({ totalPR: region === 'NAC' ? 777 : 1, thisSeasonPR: 0, prBand: null, recentEvents: [] }) },
    async ({ scrapeCalls, updateOneCalls }) => {
      const { stats, prContext } = await playerStore.getStatsForContext('g1', 'd1', 'Player1', 'e1', {
        homeRegion: 'EU', queueRegion: 'NAC', platform: 'PC', tournamentConsoleOnly: false,
      });

      assert.equal(scrapeCalls.length, 1);
      assert.equal(scrapeCalls[0].region, 'NAC', 'must fetch the QUEUE region, not home');
      assert.equal(scrapeCalls[0].platformSegment, 'all', 'PC player -> always the all segment, region is the only thing that changed');
      assert.equal(stats.totalPR, 777);
      assert.deepEqual(prContext, { region: 'NAC', platformSegment: 'all', isHomeRegion: false, isHomePlatform: true });

      assert.equal(updateOneCalls.length, 1);
      assert.ok('statsByContext.NAC|all' in updateOneCalls[0].update.$set, 'must be written to the per-context cache, NOT the home-context fields');
    });
});

test('getStatsForContext: only the ONE queued-for region is ever fetched — never every supported region preemptively', async () => {
  await withStubs({ findOneResult: null }, async ({ scrapeCalls }) => {
    await playerStore.getStatsForContext('g1', 'd1', 'Player1', 'e1', {
      homeRegion: 'EU', queueRegion: 'ME', platform: 'PC', tournamentConsoleOnly: false,
    });
    assert.equal(scrapeCalls.length, 1, 'exactly one scrape for exactly the one region actually being queued for');
    assert.equal(scrapeCalls[0].region, 'ME');
  });
});

// ── #6: platform-aware PR ─────────────────────────────────────────────────────
test('getStatsForContext: Console player in a console-exclusive tournament -> gamepad segment', async () => {
  await withStubs({ findOneResult: null }, async ({ scrapeCalls }) => {
    const { prContext } = await playerStore.getStatsForContext('g1', 'd1', 'Player1', 'e1', {
      homeRegion: 'EU', queueRegion: 'EU', platform: 'Console', tournamentConsoleOnly: true,
    });
    assert.equal(scrapeCalls[0].platformSegment, 'gamepad');
    assert.equal(prContext.platformSegment, 'gamepad');
    assert.equal(prContext.isHomeRegion, true, 'region is still home — only platform diverged');
    assert.equal(prContext.isHomePlatform, false);
  });
});

test('getStatsForContext: Console player in a NON-console-exclusive tournament -> kbm segment (their PC-tournament PR)', async () => {
  await withStubs({ findOneResult: null }, async ({ scrapeCalls }) => {
    const { prContext } = await playerStore.getStatsForContext('g1', 'd1', 'Player1', 'e1', {
      homeRegion: 'EU', queueRegion: 'EU', platform: 'Console', tournamentConsoleOnly: false,
    });
    assert.equal(scrapeCalls[0].platformSegment, 'kbm');
    assert.equal(prContext.platformSegment, 'kbm');
  });
});

test('getStatsForContext: PC player always stays on the "all" segment, regardless of tournamentConsoleOnly', async () => {
  await withStubs({ findOneResult: null }, async ({ scrapeCalls }) => {
    await playerStore.getStatsForContext('g1', 'd1', 'Player1', 'e1', {
      homeRegion: 'EU', queueRegion: 'EU', platform: 'PC', tournamentConsoleOnly: true,
    });
    assert.equal(scrapeCalls[0].platformSegment, 'all', 'the platform-segment rule only ever applies to Console players (per this task\'s explicit PC+Console scope)');
  });
});

test('getStatsForContext: Console player, different region AND non-console tournament -> both dimensions diverge from home together', async () => {
  await withStubs({ findOneResult: null }, async ({ scrapeCalls, updateOneCalls }) => {
    const { prContext } = await playerStore.getStatsForContext('g1', 'd1', 'Player1', 'e1', {
      homeRegion: 'EU', queueRegion: 'NAC', platform: 'Console', tournamentConsoleOnly: false,
    });
    assert.equal(scrapeCalls[0].region, 'NAC');
    assert.equal(scrapeCalls[0].platformSegment, 'kbm');
    assert.deepEqual(prContext, { region: 'NAC', platformSegment: 'kbm', isHomeRegion: false, isHomePlatform: false });
    assert.ok('statsByContext.NAC|kbm' in updateOneCalls[0].update.$set);
  });
});
