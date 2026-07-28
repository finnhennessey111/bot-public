// Verifies scrapePlayer's per-attempt navigation timeout (PLAYER_SCRAPE_NAV_TIMEOUT_MS = 15s, down
// from the old 30s) against REAL Puppeteer navigation — not a stubbed control-flow test — using a
// local HTTP server whose response timing we fully control, so this measures the actual configured
// timeout value rather than assuming it's wired through correctly.
//
// config.ftUrls[region] is a plain string template ('https://fortnitetracker.com/...{slug}...') —
// temporarily pointing it at our local server (then restoring it) is how scrapePlayerOnce gets
// pointed at a controllable target without touching scraper.js's production code at all.
//
// Real Puppeteer launches take real wall-clock time here (a ~10s "slow but succeeds" case and a
// ~15s "genuinely hung" case) — this file is intentionally slow, matching this session's existing
// precedent of using real navigation for scraper behavior instead of mocking Puppeteer away.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const config = require('../config');
const { scrapePlayerOnce } = require('../scraper');

const TEST_REGION = 'EU';

// A minimal but real profile payload shape — scrapePlayerOnce's page.evaluate looks for a
// `<script>` tag whose text contains "const profile =" and JSON.parses what follows.
const FAKE_PROFILE_HTML = delay => `
<!DOCTYPE html><html><body>
<script>const profile = ${JSON.stringify({ powerRank: { points: 777 }, prSegments: [], currentSeason: 1, myEvents: [] })};</script>
</body></html>
`;

// Starts a local server that waits `delayMs` before responding (or never responds at all if
// `delayMs` is Infinity), then resolves with { url, close }.
function startDelayedServer(delayMs) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (delayMs === Infinity) return; // never respond — simulates a genuinely hung request
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(FAKE_PROFILE_HTML(delayMs));
      }, delayMs);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/{slug}?id={epicId}`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

async function withOverriddenFtUrl(url, fn) {
  const original = config.ftUrls[TEST_REGION];
  config.ftUrls[TEST_REGION] = url;
  try {
    return await fn();
  } finally {
    config.ftUrls[TEST_REGION] = original;
  }
}

test('scrapePlayerOnce: a slow-but-completing response (10s) still succeeds within the new 15s timeout', async () => {
  const { url, close } = await startDelayedServer(10000);
  try {
    await withOverriddenFtUrl(url, async () => {
      const start = Date.now();
      const result = await scrapePlayerOnce('TestPlayer', TEST_REGION, null);
      const elapsedMs = Date.now() - start;

      assert.equal(result.totalPR, 777);
      assert.ok(elapsedMs < 15000, `should complete before the 15s timeout (took ${elapsedMs}ms)`);
      assert.ok(elapsedMs >= 10000, `should reflect the real 10s server delay (took ${elapsedMs}ms)`);
    });
  } finally {
    await close();
  }
});

test('scrapePlayerOnce: a genuinely hung request is caught around 15s, not the old 30s', async () => {
  const { url, close } = await startDelayedServer(Infinity);
  try {
    await withOverriddenFtUrl(url, async () => {
      const start = Date.now();
      await assert.rejects(
        () => scrapePlayerOnce('TestPlayer', TEST_REGION, null),
        err => /timeout/i.test(err.message)
      );
      const elapsedMs = Date.now() - start;

      // Comfortable margin around the 15s configured timeout — the key assertion is "meaningfully
      // faster than the old 30s", not an exact millisecond match.
      assert.ok(elapsedMs < 20000, `should time out near 15s, not the old 30s (took ${elapsedMs}ms)`);
      assert.ok(elapsedMs >= 14000, `should not time out suspiciously early (took ${elapsedMs}ms)`);
    });
  } finally {
    await close();
  }
});
