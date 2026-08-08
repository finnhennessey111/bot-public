// Verifies the second bandwidth-blocking layer in proxy-config.js: BLOCKED_DOMAINS/isBlockedDomain
// abort third-party ad-tech/tracking requests (script/xhr/fetch — resource types the first layer,
// BLOCKED_RESOURCE_TYPES, deliberately allows through) regardless of resource type.
//
// Every hostname in BLOCKED_DOMAINS, and every exclusion below, was confirmed against a real
// Puppeteer capture of the real, live fortnitetracker.com/events and a real profile page — not
// guessed from how the name looks. Same precedent as test/tracker-only-source.test.js (deliberately
// hits the real live site: a synthetic fixture can't tell us which third-party hosts a real page
// actually calls) and test/scraper-resource-blocking.test.js (proving "aborted before ever being
// sent" requires observing whether a request actually reached a server, not just that its response
// went unused).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const puppeteer = require('puppeteer');

const { blockUnnecessaryResources, isBlockedDomain, BLOCKED_DOMAINS } = require('../proxy-config');
const { scrapePlayerOnce } = require('../scraper');
const { scrapeUpcomingTournaments } = require('../tournament-scraper');

// Confirmed present on both the real events page and a real profile page across repeated live
// captures — used below where a test needs at least one blocked domain to reliably fire, as
// opposed to iterating the full list (ad-tech calls that only fire conditionally would make an
// "every listed domain must appear" assertion flaky).
const RELIABLY_OBSERVED_BLOCKED_DOMAINS = [
  'static.cloudflareinsights.com',
  'www.googletagmanager.com',
  'singingunicorn.com',
  's.nitropay.com',
  'region1.google-analytics.com',
];

// The domains the task explicitly named as look-alikes that turned out NOT to be blockable —
// verified via the same real capture (see proxy-config.js's BLOCKED_DOMAINS comment for specifics:
// challenges.cloudflare.com is the Cloudflare bot-challenge itself; cdnjs.cloudflare.com and
// cdn.jsdelivr.net serve real Vue.js the live page loads; notifications.thetrackernetwork.com is
// Fortnite Tracker's own first-party notifications API).
const EXCLUDED_LOOKALIKE_DOMAINS = [
  'challenges.cloudflare.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'notifications.thetrackernetwork.com',
];

test('isBlockedDomain: matches every confirmed ad-tech hostname, rejects fortnitetracker.com/malformed URLs, and never matches the verified-safe lookalikes', () => {
  for (const domain of BLOCKED_DOMAINS) {
    assert.equal(isBlockedDomain(`https://${domain}/some/path?x=1`), true, `${domain} should be blocked`);
  }
  for (const domain of EXCLUDED_LOOKALIKE_DOMAINS) {
    assert.equal(isBlockedDomain(`https://${domain}/some/path`), false, `${domain} must never be blocked`);
  }
  assert.equal(isBlockedDomain('https://fortnitetracker.com/events'), false);
  assert.equal(isBlockedDomain('https://files.fortnitetracker.com/scripts/ads.js'), false);
  assert.equal(isBlockedDomain('not a url'), false, 'a malformed URL must not throw and must not be treated as blocked');
});

test('blockUnnecessaryResources: a fetch() to a real blocked domain is genuinely aborted pre-flight (ERR_BLOCKED_BY_CLIENT), while a fetch() to a verified-safe lookalike is not', async () => {
  const sampleBlocked = 'static.cloudflareinsights.com';
  const html = `
<!DOCTYPE html><html><body>
<script>
  fetch('https://${sampleBlocked}/beacon.min.js').catch(() => {});
  fetch('https://challenges.cloudflare.com/turnstile/probe').catch(() => {});
  fetch('https://cdnjs.cloudflare.com/probe').catch(() => {});
</script>
</body></html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    try {
      const page = await browser.newPage();
      const blockedByClientHosts = new Set();
      page.on('requestfailed', (req) => {
        const errorText = (req.failure()?.errorText || '').toLowerCase();
        if (errorText.includes('blocked_by_client')) {
          blockedByClientHosts.add(new URL(req.url()).hostname);
        }
      });

      await blockUnnecessaryResources(page);
      await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0', timeout: 15000 });
      // The fetch() calls above are fire-and-forget (.catch swallows the error) — give the
      // interception handler a moment to actually run and the requestfailed event to fire.
      await new Promise(r => setTimeout(r, 1000));

      assert.equal(blockedByClientHosts.has(sampleBlocked), true, `${sampleBlocked} should have been aborted by the domain blocklist`);
      assert.equal(blockedByClientHosts.has('challenges.cloudflare.com'), false, 'the Cloudflare challenge domain must never be blocked');
      assert.equal(blockedByClientHosts.has('cdnjs.cloudflare.com'), false, 'cdnjs.cloudflare.com must never be blocked — it serves a real dependency');
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('blockUnnecessaryResources against the real live Fortnite Tracker events page: blocked domains never get a real response, verified-safe lookalikes do', async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const requestedHosts = new Set();
    const respondedHosts = new Set();
    page.on('request', (req) => {
      try { requestedHosts.add(new URL(req.url()).hostname); } catch { /* ignore */ }
    });
    page.on('response', (res) => {
      try { respondedHosts.add(new URL(res.url()).hostname); } catch { /* ignore */ }
    });

    await blockUnnecessaryResources(page);
    await page.goto('https://fortnitetracker.com/events', { waitUntil: 'networkidle2', timeout: 30000 });
    // Some ad-tech calls fire asynchronously shortly after the page settles, not strictly before
    // networkidle2 — give them a window to fire so this test can actually observe them.
    await new Promise(r => setTimeout(r, 5000));

    // The real page itself must still load correctly — proves this layer isn't a blanket block.
    assert.equal(respondedHosts.has('fortnitetracker.com'), true);

    let confirmedAtLeastOneBlockedDomainFired = false;
    for (const domain of BLOCKED_DOMAINS) {
      if (requestedHosts.has(domain)) {
        assert.equal(respondedHosts.has(domain), false, `${domain} was requested but should never have received a real response`);
        if (RELIABLY_OBSERVED_BLOCKED_DOMAINS.includes(domain)) confirmedAtLeastOneBlockedDomainFired = true;
      }
    }
    assert.equal(
      confirmedAtLeastOneBlockedDomainFired, true,
      'expected at least one of the reliably-observed ad-tech domains to actually fire on a real load — if none did, the page may have changed and this test needs a fresh capture'
    );

    for (const domain of EXCLUDED_LOOKALIKE_DOMAINS) {
      if (requestedHosts.has(domain)) {
        assert.equal(respondedHosts.has(domain), true, `${domain} was requested and should have received a real response — it must not be blocked`);
      }
    }
  } finally {
    await browser.close();
  }
});

test('scrapePlayerOnce: still extracts correct real profile data from the real live site with both blocking layers active', async () => {
  const data = await scrapePlayerOnce('Bugha', 'NAC', null);

  assert.equal(typeof data.totalPR, 'number');
  assert.equal(typeof data.thisSeasonPR, 'number');
  assert.ok(Array.isArray(data.recentEvents));
  // Sessions — same "Event Totals" section as Earnings/Events/Matches, same page load thisSeasonPR's
  // DOM read already uses, no separate navigation. Real live capture (see scraper.js's
  // parseProfileData doc comment) confirmed the block can genuinely be absent for an account with
  // no competitive/PR history in the queried region/platform, same as thisSeasonPR — so this only
  // asserts the type (number when present) or null, not an exact value that could legitimately
  // change on the real site between runs.
  assert.ok(data.sessions === null || typeof data.sessions === 'number', 'sessions must be a real number or a genuine null, never undefined/NaN/a string');
});

test('scrapeUpcomingTournaments: still extracts correct real calendar data from the real live site with both blocking layers active', async () => {
  const tournaments = await scrapeUpcomingTournaments();

  assert.ok(Array.isArray(tournaments));
  assert.ok(tournaments.length > 0, 'expected at least one real upcoming tournament right now');
  for (const t of tournaments) {
    assert.equal(typeof t.name, 'string');
    assert.ok(t.name.length > 0);
    assert.ok(['EU', 'NAC', 'ME'].includes(t.region));
    assert.ok(!Number.isNaN(new Date(t.beginTime).getTime()));
  }
});
