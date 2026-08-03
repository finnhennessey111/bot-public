// Verifies #1 (scrape only what's needed) for scraper.js's per-player profile fetch: the actual
// request Puppeteer sends includes competitive=pr (narrows to PR-affecting events only, matching
// what parseProfileData already discards client-side via event.isPrEvent) and the correct
// platform-segment path — real Puppeteer + a real local HTTP server that records the exact request
// it received, same precedent as test/scraper-resource-blocking.test.js (a request either reaches
// the server or it doesn't, proving what was ACTUALLY sent rather than mocking page.evaluate).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const config = require('../config');
const { scrapePlayerOnce } = require('../scraper');

const FAKE_PROFILE = { powerRank: { points: 123 }, prSegments: [], currentSeason: 1, myEvents: [] };

function startRecordingServer() {
  // Chrome fires its own incidental requests against a real navigation (favicon.ico being the
  // reliable one) alongside the actual profile request — tracking only the LAST request received
  // would flakily capture one of those instead. Tracking the one request whose path actually
  // starts with /profile/ (the only path this server's own template ever points scrapePlayerOnce
  // at) is what actually isolates the real scrape request.
  let profileRequest = null;
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/profile/')) profileRequest = { url: req.url };
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body><script>const profile = ${JSON.stringify(FAKE_PROFILE)};</script></body></html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        // {platform}/{region}/{epicId} all land in the path/query exactly like the real Tracker
        // template — this is config.ftUrlTemplate's own shape, just pointed at localhost.
        url: `http://127.0.0.1:${port}/profile/{platform}/{slug}/events?region={region}&id={epicId}&competitive=pr`,
        getLastRequest: () => profileRequest,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

async function withOverriddenFtUrl(url, fn) {
  const original = config.ftUrlTemplate;
  config.ftUrlTemplate = url;
  try {
    return await fn();
  } finally {
    config.ftUrlTemplate = original;
  }
}

test('scrapePlayerOnce: the real request includes competitive=pr and the "all" platform segment by default', async () => {
  const { url, getLastRequest, close } = await startRecordingServer();
  try {
    await withOverriddenFtUrl(url, async () => {
      await scrapePlayerOnce('TestPlayer', 'EU', 'epic-1');
      const { url: requestUrl } = getLastRequest();
      assert.match(requestUrl, /^\/profile\/all\//, 'default platform segment must be "all"');
      assert.match(requestUrl, /region=EU/);
      assert.match(requestUrl, /id=epic-1/);
      assert.match(requestUrl, /competitive=pr/);
    });
  } finally {
    await close();
  }
});

test('scrapePlayerOnce: a Console-context request uses the gamepad platform segment and the queued region', async () => {
  const { url, getLastRequest, close } = await startRecordingServer();
  try {
    await withOverriddenFtUrl(url, async () => {
      await scrapePlayerOnce('TestPlayer', 'NAC', 'epic-2', config.ftPlatformSegments.Console);
      const { url: requestUrl } = getLastRequest();
      assert.match(requestUrl, /^\/profile\/gamepad\//);
      assert.match(requestUrl, /region=NAC/);
      assert.match(requestUrl, /competitive=pr/);
    });
  } finally {
    await close();
  }
});

test('scrapePlayerOnce: a PC-context request uses the kbm platform segment', async () => {
  const { url, getLastRequest, close } = await startRecordingServer();
  try {
    await withOverriddenFtUrl(url, async () => {
      await scrapePlayerOnce('TestPlayer', 'EU', 'epic-3', config.ftPlatformSegments.PC);
      const { url: requestUrl } = getLastRequest();
      assert.match(requestUrl, /^\/profile\/kbm\//);
    });
  } finally {
    await close();
  }
});
