// Verifies the Webshare bandwidth fix: blockUnnecessaryResources (proxy-config.js) aborts
// image/font/stylesheet/media requests before they reach the network — not just after receiving
// them — and a real scrape still extracts the correct data with it enabled.
//
// Real Puppeteer + a real local HTTP server that tracks which paths actually got hit, same
// precedent as test/scraper-timeout.test.js and test/scraper-subresource-hang.test.js — a request
// either reaches this server's request handler or it doesn't, which is what actually proves
// "aborted before being sent" rather than "sent but ignored" (a mocked page.evaluate couldn't
// distinguish those two).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const puppeteer = require('puppeteer');

const config = require('../config');
const { proxyLaunchArgs, authenticatePage, blockUnnecessaryResources } = require('../proxy-config');
const { scrapePlayerOnce } = require('../scraper');

const TEST_REGION = 'EU';

// References one of each resource type BLOCKED_RESOURCE_TYPES should block (image, stylesheet,
// font — via a real @font-face declaration actually used by rendered text, so Chrome fetches it
// for real rather than it being a dead declaration, media via <video><source>), plus one of each
// type that must still be allowed through (script — required for page.evaluate's "const profile ="
// lookup to even be possible — and an XHR, standing in for "the data could come from a fetch/xhr
// response instead of inline HTML").
const HTML_WITH_ALL_RESOURCE_TYPES = `
<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/style.css">
<style>@font-face { font-family: 'TestFont'; src: url('/font.woff2') format('woff2'); }</style>
</head><body>
<img src="/photo.png">
<div style="font-family: 'TestFont'">rendered with the custom font so Chrome actually fetches it</div>
<video><source src="/clip.mp4" type="video/mp4"></video>
<script>
const profile = ${JSON.stringify({ powerRank: { points: 999 }, prSegments: [], currentSeason: 1, myEvents: [] })};
fetch('/xhr-endpoint').catch(() => {});
</script>
</body></html>
`;

function startTrackingServer() {
  const hits = new Set();
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      hits.add(req.url.split('?')[0]);
      if (req.url === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        return res.end('body { color: red; }');
      }
      if (req.url === '/font.woff2') {
        res.writeHead(200, { 'Content-Type': 'font/woff2' });
        return res.end(Buffer.from([0, 0, 0, 0]));
      }
      if (req.url === '/photo.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(Buffer.from([0, 0, 0, 0]));
      }
      if (req.url === '/clip.mp4') {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        return res.end(Buffer.from([0, 0, 0, 0]));
      }
      if (req.url === '/xhr-endpoint') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML_WITH_ALL_RESOURCE_TYPES);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        url: `http://127.0.0.1:${port}/{slug}?id={epicId}`,
        hits,
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

test('blockUnnecessaryResources: image/stylesheet/font/media requests never reach the server, but document/script/xhr do', async () => {
  const { baseUrl, hits, close } = await startTrackingServer();
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyLaunchArgs()],
    });
    try {
      const page = await browser.newPage();
      await authenticatePage(page);
      await blockUnnecessaryResources(page);
      await page.goto(baseUrl, { waitUntil: 'networkidle0', timeout: 15000 });

      // Blocked types: aborted before ever being sent, so the server's own request handler must
      // never have seen them — this is the actual bandwidth saving, not just an unused response.
      assert.equal(hits.has('/style.css'), false, 'stylesheet request should have been aborted, not sent');
      assert.equal(hits.has('/photo.png'), false, 'image request should have been aborted, not sent');
      assert.equal(hits.has('/font.woff2'), false, 'font request should have been aborted, not sent');
      assert.equal(hits.has('/clip.mp4'), false, 'media request should have been aborted, not sent');

      // Allowed types: must still go through — this is what proves the interception is selective,
      // not a blanket "block everything" that would also break real scraping.
      assert.equal(hits.has('/'), true, 'the main document request must still go through');
      assert.equal(hits.has('/xhr-endpoint'), true, 'an XHR/fetch request must still go through — the real data could live in one');
    } finally {
      await browser.close();
    }
  } finally {
    await close();
  }
});

test('scrapePlayerOnce: still extracts the correct data with resource blocking enabled, and never fetches the page\'s image/stylesheet/font sub-resources', async () => {
  const { url, hits, close } = await startTrackingServer();
  try {
    await withOverriddenFtUrl(url, async () => {
      const result = await scrapePlayerOnce('TestPlayer', TEST_REGION, null);

      // Same real extraction path as every other scraper test (script's "const profile =" ->
      // parseProfileData) — proves interception doesn't break the thing it's meant to leave alone.
      assert.equal(result.totalPR, 999);

      assert.equal(hits.has('/style.css'), false);
      assert.equal(hits.has('/photo.png'), false);
      assert.equal(hits.has('/font.woff2'), false);
      assert.equal(hits.has('/clip.mp4'), false);
    });
  } finally {
    await close();
  }
});
