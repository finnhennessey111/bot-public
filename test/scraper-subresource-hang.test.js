// Verifies the actual production concern behind switching scrapePlayerOnce's page.goto from
// networkidle2 to domcontentloaded: a page whose MAIN document loads fine (and already contains
// the "const profile =" data scrapePlayerOnce needs) but that also references a sub-resource (an
// <img>) which never responds — reproducing a Webshare-dashboard-observed real condition where a
// specific CDN host (cdn2.unrealengine.com) is permanently blocked for proxied requests
// (client_connect_forbidden_host), independent of which exit IP a rotating proxy picks.
//
// Real Puppeteer + a real local HTTP server, not a mock — same precedent as
// test/scraper-timeout.test.js. This file is intentionally slow (it has to actually demonstrate
// networkidle2 hanging past a real wall-clock timeout to prove the fix matters).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const puppeteer = require('puppeteer');

const config = require('../config');
const { proxyLaunchArgs, authenticatePage } = require('../proxy-config');
const { scrapePlayerOnce } = require('../scraper');

const TEST_REGION = 'EU';

// Main document responds immediately and already contains the profile data — but also references
// several sub-resource images served by requests that never complete, simulating a permanently-
// blocked host. Three, not one: networkidle2 fires once there are "no more than 2" in-flight
// connections for 500ms straight, so a single hung connection doesn't stop it — this only
// reproduces a real hang once concurrent in-flight requests exceed that threshold, matching a real
// page with multiple tournament banner images all pointing at the same blocked CDN host.
const HTML_WITH_HANGING_SUBRESOURCE = `
<!DOCTYPE html><html><body>
<img src="/hanging-image-1.jpg">
<img src="/hanging-image-2.jpg">
<img src="/hanging-image-3.jpg">
<script>const profile = ${JSON.stringify({ powerRank: { points: 888 }, prSegments: [], currentSeason: 1, myEvents: [] })};</script>
</body></html>
`;

function startServerWithHangingSubResource() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/hanging-image-')) {
        return; // never respond — simulates a request to a permanently-blocked host
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML_WITH_HANGING_SUBRESOURCE);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        url: `http://127.0.0.1:${port}/{slug}?id={epicId}`,
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

test('scrapePlayerOnce: a hanging sub-resource no longer blocks the scrape (domcontentloaded)', async () => {
  const { url, close } = await startServerWithHangingSubResource();
  try {
    await withOverriddenFtUrl(url, async () => {
      const start = Date.now();
      const result = await scrapePlayerOnce('TestPlayer', TEST_REGION, null);
      const elapsedMs = Date.now() - start;

      assert.equal(result.totalPR, 888);
      // The main document itself responds instantly; a hanging image sub-resource must not add
      // meaningful delay. Generous margin for real browser launch/navigation overhead, but nowhere
      // near the 15s PLAYER_SCRAPE_NAV_TIMEOUT_MS a networkidle2 wait would burn through.
      assert.ok(elapsedMs < 8000, `should resolve promptly despite the hanging sub-resource (took ${elapsedMs}ms)`);
    });
  } finally {
    await close();
  }
});

test('control: the same page WOULD hang under networkidle2, proving the fix is load-bearing', async () => {
  const { baseUrl, close } = await startServerWithHangingSubResource();
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyLaunchArgs()],
    });
    try {
      const page = await browser.newPage();
      await authenticatePage(page);

      const start = Date.now();
      await assert.rejects(
        () => page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 5000 }),
        err => /timeout/i.test(err.message),
        'networkidle2 should time out waiting for the hanging image sub-resource to go quiet'
      );
      const elapsedMs = Date.now() - start;
      assert.ok(elapsedMs >= 4900, `should actually wait out the full timeout, not resolve early (took ${elapsedMs}ms)`);
    } finally {
      await browser.close();
    }
  } finally {
    await close();
  }
});
