// Verifies players.js's wiring of the second, separate api-fortnite.com OAuth authorization
// (applyFortniteApiOAuthOverride/getValidFortniteApiAccessToken) against getPlayerStats — the same
// composition getContextualPlayerStats/refreshPlayerStats/forceRefreshStats all share. Three things
// this task explicitly required real tests for:
//   1. A player who never authorized (or FORTNITE_API_KEY isn't configured at all) gets ZERO
//      behavior change — recentEvents is exactly whatever scrapePlayer produced, and the
//      fortnite-api-oauth.js network functions are never even called.
//   2. A player who HAS authorized, with a still-valid token, gets recentEvents sourced from
//      api-fortnite.com's history instead of Fortnite Tracker's own scrape.
//   3. Token expiry is handled without breaking anything: refresh-token first, refresh-device as
//      fallback, and if BOTH fail, the player falls back to Fortnite Tracker's recentEvents exactly
//      like they'd never authorized at all — never an error, never a broken queue-join.
//
// Same stubbing precedent as test/players-contextual-pr.test.js (PlayerModel statics stubbed
// directly, scraperModule.scrapePlayerOnce stubbed via module.exports delegation) — extended here
// with fortniteApiOAuth's own functions stubbed the same way (namespace import, not destructured —
// see players.js's own comment on why), so no real network call or FORTNITE_API_KEY is needed.
const test = require('node:test');
const assert = require('node:assert/strict');

const PlayerModel = require('../models/Player');
const scraperModule = require('../scraper');
const fortniteApiOAuth = require('../fortnite-api-oauth');
const playerStore = require('../players');

function withStubs({ findOneResult = null, scrapeImpl, fortniteApiImpl = {}, isConfiguredResult = true } = {}, fn) {
  const originalFindOne = PlayerModel.findOne;
  const originalFindOneAndUpdate = PlayerModel.findOneAndUpdate;
  const originalScrapeOnce = scraperModule.scrapePlayerOnce;
  const originalIsConfigured = fortniteApiOAuth.isConfigured;
  const originalFetchHistory = fortniteApiOAuth.fetchTournamentHistory;
  const originalRefreshToken = fortniteApiOAuth.refreshWithToken;
  const originalRefreshDevice = fortniteApiOAuth.refreshWithDevice;

  const scrapeCalls = [];
  const upsertCalls = [];
  const fetchHistoryCalls = [];
  const refreshTokenCalls = [];
  const refreshDeviceCalls = [];

  PlayerModel.findOne = async () => findOneResult;
  PlayerModel.findOneAndUpdate = (filter, update) => {
    upsertCalls.push({ filter, update });
    return { lean: async () => ({}) };
  };
  scraperModule.scrapePlayerOnce = async (epicUsername, region, epicId, platformSegment) => {
    scrapeCalls.push({ epicUsername, region, epicId, platformSegment });
    return scrapeImpl
      ? scrapeImpl()
      : { totalPR: 111, thisSeasonPR: 11, prBand: null, recentEvents: [{ name: 'FT Event', date: '2026-01-01', placement: 1, prPoints: 50, rosterSize: 1, matches: 1, wins: 1, elims: 1, kd: 1 }] };
  };

  fortniteApiOAuth.isConfigured = () => isConfiguredResult;
  fortniteApiOAuth.fetchTournamentHistory = async (accountId, accessToken) => {
    fetchHistoryCalls.push({ accountId, accessToken });
    return fortniteApiImpl.fetchTournamentHistory ? fortniteApiImpl.fetchTournamentHistory() : null;
  };
  fortniteApiOAuth.refreshWithToken = async (refreshToken) => {
    refreshTokenCalls.push(refreshToken);
    return fortniteApiImpl.refreshWithToken ? fortniteApiImpl.refreshWithToken() : { status: 'invalid' };
  };
  fortniteApiOAuth.refreshWithDevice = async (deviceAuth) => {
    refreshDeviceCalls.push(deviceAuth);
    return fortniteApiImpl.refreshWithDevice ? fortniteApiImpl.refreshWithDevice() : { status: 'invalid' };
  };
  // mapHistoryToRecentEvents is deliberately NOT stubbed — using the real function proves the
  // whole chain (fetch -> map -> override) is wired correctly end to end, not just that players.js
  // calls something.

  return Promise.resolve(fn({ scrapeCalls, upsertCalls, fetchHistoryCalls, refreshTokenCalls, refreshDeviceCalls })).finally(() => {
    PlayerModel.findOne = originalFindOne;
    PlayerModel.findOneAndUpdate = originalFindOneAndUpdate;
    scraperModule.scrapePlayerOnce = originalScrapeOnce;
    fortniteApiOAuth.isConfigured = originalIsConfigured;
    fortniteApiOAuth.fetchTournamentHistory = originalFetchHistory;
    fortniteApiOAuth.refreshWithToken = originalRefreshToken;
    fortniteApiOAuth.refreshWithDevice = originalRefreshDevice;
  });
}

function linkedRecord({ expiresAt } = {}) {
  return {
    totalPR: 500, thisSeasonPR: 0, prBand: null, recentEvents: [], lastUpdated: null,
    fortniteApiOAuth: {
      accountId: 'acct-1', accessToken: 'old-at', refreshToken: 'old-rt',
      expiresAt: expiresAt ?? new Date(Date.now() + 3600_000), // valid for another hour by default
      deviceId: 'dev-1', deviceSecret: 'sec-1', linkedAt: new Date(),
    },
  };
}

// ── #1: zero behavior change when never authorized / not configured ────────────────────────────
test('getPlayerStats: a player with no fortniteApiOAuth field at all gets recentEvents exactly as scraped — zero fortnite-api-oauth network calls', async () => {
  await withStubs({ findOneResult: { totalPR: 1, thisSeasonPR: 0, recentEvents: [], lastUpdated: null } }, async ({ fetchHistoryCalls, refreshTokenCalls, refreshDeviceCalls }) => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
    assert.equal(stats.recentEvents.length, 1);
    assert.equal(stats.recentEvents[0].name, 'FT Event', 'must be exactly the Fortnite Tracker-scraped event, untouched');
    assert.equal(fetchHistoryCalls.length, 0);
    assert.equal(refreshTokenCalls.length, 0);
    assert.equal(refreshDeviceCalls.length, 0);
  });
});

test('getPlayerStats: FORTNITE_API_KEY not configured at all short-circuits before even checking the player record\'s link state', async () => {
  await withStubs({ findOneResult: linkedRecord(), isConfiguredResult: false }, async ({ fetchHistoryCalls }) => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
    assert.equal(stats.recentEvents[0].name, 'FT Event');
    assert.equal(fetchHistoryCalls.length, 0, 'not configured must never even reach the isFortniteApiOAuthLinked check');
  });
});

test('isFortniteApiOAuthLinked: false for a record missing any of accountId/deviceId/deviceSecret', () => {
  assert.equal(playerStore.isFortniteApiOAuthLinked(null), false);
  assert.equal(playerStore.isFortniteApiOAuthLinked({}), false);
  assert.equal(playerStore.isFortniteApiOAuthLinked({ fortniteApiOAuth: { accountId: 'a' } }), false, 'accountId alone is not enough — needs deviceId/deviceSecret too, for the refresh fallback');
  assert.equal(playerStore.isFortniteApiOAuthLinked(linkedRecord()), true);
});

// ── #2: authorized player with a valid token gets recentEvents from api-fortnite.com ────────────
test('getPlayerStats: a linked player with a still-valid token gets recentEvents sourced from api-fortnite.com, never refreshing', async () => {
  await withStubs({
    findOneResult: linkedRecord(),
    fortniteApiImpl: { fetchTournamentHistory: () => [{ name: 'Real Tournament', date: '2026-08-01', prPoints: 88, placement: 2 }] },
  }, async ({ fetchHistoryCalls, refreshTokenCalls, refreshDeviceCalls }) => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
    assert.equal(stats.recentEvents.length, 1);
    assert.equal(stats.recentEvents[0].name, 'Real Tournament', 'must be sourced from api-fortnite.com, not the Fortnite Tracker scrape');
    assert.equal(stats.recentEvents[0].prPoints, 88);
    assert.equal(fetchHistoryCalls.length, 1);
    assert.equal(fetchHistoryCalls[0].accountId, 'acct-1');
    assert.equal(fetchHistoryCalls[0].accessToken, 'old-at', 'a still-valid token must be reused as-is, no refresh call');
    assert.equal(refreshTokenCalls.length, 0);
    assert.equal(refreshDeviceCalls.length, 0);
  });
});

test('getPlayerStats: an empty/unusable history response falls back to Fortnite Tracker\'s own recentEvents, not an empty array', async () => {
  await withStubs({
    findOneResult: linkedRecord(),
    fortniteApiImpl: { fetchTournamentHistory: () => [] },
  }, async () => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
    assert.equal(stats.recentEvents[0].name, 'FT Event', 'an empty api-fortnite.com result must not wipe out the real Fortnite Tracker data');
  });
});

// ── #3: token expiry — refresh-token, then refresh-device fallback, then total-failure fallback ─
test('getPlayerStats: an EXPIRED token successfully refreshes via refresh-token, persists the new tokens, and still applies the override', async () => {
  const record = linkedRecord({ expiresAt: new Date(Date.now() - 1000) }); // already expired
  await withStubs({
    findOneResult: record,
    fortniteApiImpl: {
      refreshWithToken: () => ({ status: 'ok', accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: new Date(Date.now() + 7200_000), accountId: 'acct-1' }),
      fetchTournamentHistory: () => [{ name: 'Fresh After Refresh', date: '2026-08-01', prPoints: 5 }],
    },
  }, async ({ fetchHistoryCalls, refreshTokenCalls, refreshDeviceCalls, upsertCalls }) => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');

    assert.equal(refreshTokenCalls.length, 1);
    assert.equal(refreshTokenCalls[0], 'old-rt');
    assert.equal(refreshDeviceCalls.length, 0, 'refresh-token succeeding must never fall through to refresh-device');
    assert.equal(fetchHistoryCalls[0].accessToken, 'new-at', 'must use the freshly-refreshed token, not the stale one');
    assert.equal(stats.recentEvents[0].name, 'Fresh After Refresh');

    const tokenPersist = upsertCalls.find(c => c.update.$set.fortniteApiOAuth?.accessToken === 'new-at');
    assert.ok(tokenPersist, 'the refreshed token must be persisted back to the player record');
    assert.equal(tokenPersist.update.$set.fortniteApiOAuth.deviceId, 'dev-1', 'device credentials must be preserved across a refresh-token-only update');
  });
});

test('getPlayerStats: refresh-token invalid falls back to refresh-device, persists, and still applies the override', async () => {
  const record = linkedRecord({ expiresAt: new Date(Date.now() - 1000) });
  await withStubs({
    findOneResult: record,
    fortniteApiImpl: {
      refreshWithToken: () => ({ status: 'invalid' }),
      refreshWithDevice: () => ({ status: 'ok', accessToken: 'device-at', refreshToken: 'device-rt', expiresAt: new Date(Date.now() + 7200_000), accountId: 'acct-1' }),
      fetchTournamentHistory: () => [{ name: 'Fresh Via Device', date: '2026-08-01', prPoints: 7 }],
    },
  }, async ({ fetchHistoryCalls, refreshTokenCalls, refreshDeviceCalls }) => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');

    assert.equal(refreshTokenCalls.length, 1);
    assert.equal(refreshDeviceCalls.length, 1);
    assert.deepEqual(refreshDeviceCalls[0], { accountId: 'acct-1', deviceId: 'dev-1', secret: 'sec-1' });
    assert.equal(fetchHistoryCalls[0].accessToken, 'device-at');
    assert.equal(stats.recentEvents[0].name, 'Fresh Via Device');
  });
});

test('getPlayerStats: BOTH refresh-token and refresh-device failing falls back to Fortnite Tracker\'s recentEvents — no throw, zero broken queue-join', async () => {
  const record = linkedRecord({ expiresAt: new Date(Date.now() - 1000) });
  await withStubs({
    findOneResult: record,
    fortniteApiImpl: {
      refreshWithToken: () => ({ status: 'invalid' }),
      refreshWithDevice: () => ({ status: 'invalid' }), // device auth itself revoked
    },
  }, async ({ fetchHistoryCalls }) => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
    assert.equal(stats.recentEvents[0].name, 'FT Event', 'total auth failure must fall back exactly like never having authorized at all');
    assert.equal(fetchHistoryCalls.length, 0, 'must never even attempt the history fetch without a valid access token');
  });
});

test('getPlayerStats: a network/unexpected-error refresh result also falls back safely, same as invalid', async () => {
  const record = linkedRecord({ expiresAt: new Date(Date.now() - 1000) });
  await withStubs({
    findOneResult: record,
    fortniteApiImpl: {
      refreshWithToken: () => ({ status: 'error', message: 'ECONNRESET' }),
      refreshWithDevice: () => ({ status: 'error', message: 'ECONNRESET' }),
    },
  }, async () => {
    const stats = await playerStore.getPlayerStats('g1', 'd1', 'Player1', 'e1', 'EU');
    assert.equal(stats.recentEvents[0].name, 'FT Event');
  });
});
