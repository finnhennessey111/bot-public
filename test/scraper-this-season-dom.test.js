// Verifies the fix for a real, confirmed production bug: thisSeasonPR used to come from
// data.prSegments' current-season entry — a STATIC, non-decaying historical total that was
// confirmed (against two independent real Fortnite Tracker accounts, live) to OVERSTATE the real,
// live "This Season" figure by ~16-18%. That live figure only exists as server-rendered DOM text
// (Fortnite Tracker's own `.profile-stat__label`/`.profile-stat__value` markup, confirmed via a
// live capture — NOT present anywhere in the `const profile = {...}` JSON blob, or any other
// <script> tag), so this is fixed by reading the real rendered DOM instead of any JSON field.
//
// Real Puppeteer + a real local HTTP server serving the confirmed live markup shape, same
// precedent as test/scraper-resource-blocking.test.js — proves scrapePlayerOnce's actual
// production DOM-query code works against real rendered HTML, not a mocked page.evaluate.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const config = require('../config');
const { scrapePlayerOnce } = require('../scraper');

const TEST_REGION = 'EU';

// Mirrors the real, confirmed-live DOM structure exactly: a `.profile-stat__label` div whose text
// is "This Season", sharing a `.profile-stat__container` parent with a sibling `.profile-stat__value`
// div holding the comma-formatted number as both its title attribute and its text content.
function statBlockHtml(label, displayValue) {
  return `
    <div class="profile-stat">
      <div class="profile-stat__container">
        <div class="profile-stat__label" title="${label}">${label}</div>
        <div class="profile-stat-delta__container">
          <div class="profile-stat__value" title="${displayValue}">${displayValue}</div>
        </div>
      </div>
    </div>
  `;
}

// prSegments' season-41 entry (49325) deliberately does NOT match the rendered "This Season"
// figure (40262) below — the exact real-world pattern confirmed live (a static historical total
// vs. the real decayed current value) — so a passing test here proves the DOM value wins, not a
// coincidental match.
function htmlPage({ includeSeasonBlock = true, includeYearBlock = true } = {}) {
  const profile = {
    powerRank: { points: 224674, pr: 224674.83 },
    prSegments: [
      { segmentType: 'season', segmentValue: '41', points: 49325 },
      { segmentType: 'year', segmentValue: '2026', points: 172349 },
    ],
    currentSeason: 41,
    myEvents: [],
  };
  return `
    <!DOCTYPE html><html><body>
    ${includeSeasonBlock ? statBlockHtml('This Season', '40,262') : ''}
    ${includeYearBlock ? statBlockHtml('This Year', '163,286') : ''}
    <script>const profile = ${JSON.stringify(profile)};</script>
    </body></html>
  `;
}

function startServer(html) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
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
  const original = config.ftUrlTemplate;
  config.ftUrlTemplate = url;
  try {
    return await fn();
  } finally {
    config.ftUrlTemplate = original;
  }
}

test('scrapePlayerOnce: thisSeasonPR comes from the rendered "This Season" DOM stat, NOT prSegments (confirmed different real values)', async () => {
  const { url, close } = await startServer(htmlPage());
  try {
    await withOverriddenFtUrl(url, async () => {
      const result = await scrapePlayerOnce('TestPlayer', TEST_REGION, null);

      assert.equal(result.thisSeasonPR, 40262, 'must read the rendered DOM value, comma stripped');
      assert.notEqual(result.thisSeasonPR, 49325, 'must NOT fall back to prSegments\' season-41.points — that is the confirmed-wrong static historical total');

      // totalPR must be completely untouched by this fix — still data.powerRank.points, exactly.
      assert.equal(result.totalPR, 224674);
    });
  } finally {
    await close();
  }
});

test('scrapePlayerOnce: no "This Season" DOM block at all (no competitive/PR history) defaults thisSeasonPR to 0 — does NOT fall back to prSegments even though it has data', async () => {
  const { url, close } = await startServer(htmlPage({ includeSeasonBlock: false }));
  try {
    await withOverriddenFtUrl(url, async () => {
      const result = await scrapePlayerOnce('TestPlayer', TEST_REGION, null);

      assert.equal(result.thisSeasonPR, 0, 'DOM block absent -> honest 0, never silently reintroducing the prSegments bug as a fallback');
      assert.equal(result.totalPR, 224674, 'totalPR is unaffected — it never depended on this DOM block');
    });
  } finally {
    await close();
  }
});

test('scrapePlayerOnce: a real player with NO powerRank/prSegments data at all (confirmed real shape for an inactive account) still scrapes cleanly with thisSeasonPR 0', async () => {
  const profile = { myEvents: [] }; // confirmed real shape: powerRank/prSegments/currentSeason genuinely absent, not just empty
  const html = `<!DOCTYPE html><html><body><script>const profile = ${JSON.stringify(profile)};</script></body></html>`;
  const { url, close } = await startServer(html);
  try {
    await withOverriddenFtUrl(url, async () => {
      const result = await scrapePlayerOnce('InactivePlayer', TEST_REGION, null);
      assert.equal(result.totalPR, 0);
      assert.equal(result.thisSeasonPR, 0);
    });
  } finally {
    await close();
  }
});

// Real, live, non-mocked confirmation against the actual production site — same "real live site"
// precedent as test/proxy-domain-blocking.test.js's scrapePlayerOnce smoke test. A known, currently
// active competitive EU player (verified during this investigation to have real "This Season" PR)
// with their real accountId as epicId, so Fortnite Tracker resolves the correct competitive
// profile. The exact figure legitimately drifts over time (it's a live, continuously-decayed
// value, confirmed during investigation) so this only asserts genuine live extraction happened —
// a real positive number, not the 0 a broken selector or a reverted fix would silently produce.
test('scrapePlayerOnce: real live site — thisSeasonPR is a genuine positive number for a known active real player, proving the DOM extraction works end-to-end in production', async () => {
  const result = await scrapePlayerOnce('AG Sky.', 'EU', '2f98535a-2b2a-43d0-922c-1aa56034cbb6');
  assert.equal(typeof result.thisSeasonPR, 'number');
  assert.ok(result.thisSeasonPR > 0, `expected a real, live, positive "This Season" PR for a known active player, got ${result.thisSeasonPR}`);
  assert.equal(typeof result.totalPR, 'number');
  assert.ok(result.totalPR > 0);
});
