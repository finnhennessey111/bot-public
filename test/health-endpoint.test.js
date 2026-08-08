// Verifies GET /health (webhook-server.js) reports accurate real status for its three fields:
// process uptime, MongoDB connection status, and the timestamp of the last successful tournament
// scrape. Real Express route, real HTTP request over an ephemeral port — same pattern as
// test/elo-endpoint.test.js's bottom block (native fetch, no supertest).
//
// db.isConnected/channelManager.getLastSuccessfulScrapeAt are monkey-patched directly on the
// shared module objects (not destructured anywhere), so — unlike discord-dm.js's dmUser or
// tournament-scraper.js's scrapeUpcomingTournaments elsewhere in this test suite — no
// require.cache reset is needed; webhook-server.js's own `db.isConnected()` /
// `channelManager.getLastSuccessfulScrapeAt()` calls read straight through to whatever the test
// just set on those same singleton objects.
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const channelManager = require('../channel-manager');
const { startWebhookServer } = require('../webhook-server');

async function withHealthServer(fn) {
  const originalPort = process.env.PORT;
  process.env.PORT = '0';

  let server;
  try {
    server = startWebhookServer({});
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  }
}

test('GET /health — MongoDB connected and a real last-scrape timestamp: 200, status "ok", accurate fields', async () => {
  const originalIsConnected = db.isConnected;
  const originalGetScrape = channelManager.getLastSuccessfulScrapeAt;
  const fixedStamp = new Date('2026-08-08T12:00:00.000Z');
  db.isConnected = () => true;
  channelManager.getLastSuccessfulScrapeAt = () => fixedStamp;

  try {
    await withHealthServer(async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.mongoConnected, true);
      assert.equal(body.lastSuccessfulScrapeAt, fixedStamp.toISOString());
      assert.equal(typeof body.uptimeSeconds, 'number');
      assert.ok(body.uptimeSeconds >= 0);
      assert.ok(Number.isInteger(body.uptimeSeconds));
      assert.ok(!Number.isNaN(Date.parse(body.timestamp)), 'timestamp must be a real, parseable date');
    });
  } finally {
    db.isConnected = originalIsConnected;
    channelManager.getLastSuccessfulScrapeAt = originalGetScrape;
  }
});

test('GET /health — MongoDB NOT connected: 503, status "degraded", still reports uptime honestly', async () => {
  const originalIsConnected = db.isConnected;
  db.isConnected = () => false;

  try {
    await withHealthServer(async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 503, 'an automated check watching only the HTTP status code must see this as unhealthy');

      const body = await res.json();
      assert.equal(body.status, 'degraded');
      assert.equal(body.mongoConnected, false);
      assert.equal(typeof body.uptimeSeconds, 'number');
    });
  } finally {
    db.isConnected = originalIsConnected;
  }
});

test('GET /health — before any scrape has ever succeeded this process: lastSuccessfulScrapeAt is honestly null, not a fabricated time', async () => {
  const originalIsConnected = db.isConnected;
  const originalGetScrape = channelManager.getLastSuccessfulScrapeAt;
  db.isConnected = () => true;
  channelManager.getLastSuccessfulScrapeAt = () => null;

  try {
    await withHealthServer(async (base) => {
      const res = await fetch(`${base}/health`);
      const body = await res.json();
      assert.equal(body.lastSuccessfulScrapeAt, null);
    });
  } finally {
    db.isConnected = originalIsConnected;
    channelManager.getLastSuccessfulScrapeAt = originalGetScrape;
  }
});

test('GET /health — uptimeSeconds genuinely reflects process.uptime(), not a stubbed/fixed value', async () => {
  const originalIsConnected = db.isConnected;
  db.isConnected = () => true;

  try {
    await withHealthServer(async (base) => {
      const before = process.uptime();
      const res = await fetch(`${base}/health`);
      const after = process.uptime();
      const body = await res.json();

      assert.ok(body.uptimeSeconds >= Math.floor(before) && body.uptimeSeconds <= Math.ceil(after) + 1,
        `expected uptimeSeconds (${body.uptimeSeconds}) to fall between real process.uptime() readings taken just before/after the request`);
    });
  } finally {
    db.isConnected = originalIsConnected;
  }
});
