// proxy-config.js - Shared residential-proxy config for both Puppeteer scrapers (scraper.js's
// scrapePlayer, tournament-scraper.js's fetchRawCalendar). Direct requests to fortnitetracker.com
// get blocked outright, categorically, regardless of source IP — confirmed via manual testing —
// a residential proxy is what actually gets through cleanly. Conditional on PROXY_HOST alone:
// unset, and both scrapers launch exactly as before (no proxy args, no page.authenticate call),
// so a local dev environment with no proxy credentials configured is unaffected.

function isProxyConfigured() {
  return !!process.env.PROXY_HOST;
}

// Spread into puppeteer.launch()'s args array — an empty array (no-op) when no proxy is configured.
function proxyLaunchArgs() {
  return isProxyConfigured() ? [`--proxy-server=${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`] : [];
}

// Call right after page creation, before any navigation — a no-op when no proxy is configured.
async function authenticatePage(page) {
  if (!isProxyConfigured()) return;
  await page.authenticate({ username: process.env.PROXY_USERNAME, password: process.env.PROXY_PASSWORD });
}

// Resource types the data either scraper needs never lives in — both pull their result from an
// inline <script> tag's JSON blob in the initial document (scraper.js's `const profile =`,
// tournament-scraper.js's `var imp_calendar =`), confirmed against real pages, not assumed.
// Images/fonts/stylesheets/media are pure visual rendering this headless scrape never displays,
// and every one of them still gets routed (and billed) through the paid Webshare proxy exactly
// like a request that matters. Document/script/xhr/fetch stay allowed — the data lives in one of
// those, and blocking script would break page.evaluate() outright.
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet', 'media']);

// Second layer: third-party ad-tech/tracking calls made via script/xhr/fetch — resource types the
// scrape deliberately allows through above (the profile/calendar data lives in a raw inline
// <script> tag, and blocking script would break page.evaluate() outright) but that carry none of
// that data and still get routed through the paid Webshare proxy like everything else. Every
// hostname below was confirmed via a real Puppeteer capture of fortnitetracker.com/events and a
// real profile page (not guessed from how the name looks) — see test/proxy-domain-blocking.test.js.
//
// Deliberately NOT included, despite superficially fitting the pattern:
//   - challenges.cloudflare.com: the actual Cloudflare bot-challenge Puppeteer has to load and
//     solve to get past the block this whole proxy setup exists to route around (see this file's
//     header comment). Blocking it would break scraping entirely, proxy or not.
//   - cdnjs.cloudflare.com, cdn.jsdelivr.net: the same real capture showed the live page loading
//     actual Vue.js from both (cdnjs.cloudflare.com/ajax/libs/vue/2.5.16/vue.min.js and
//     cdn.jsdelivr.net/npm/vue@3.5.31/dist/vue.global.prod.js, plus vue-spinner) — real libraries
//     the page depends on, not ad-tech riding a public CDN. Not something this scrape's own data
//     extraction needs (that comes from a raw inline <script> tag, not anything Vue renders), but
//     blocking a dependency the live page genuinely loads is a different risk than blocking
//     confirmed ad-tech, so both stay allowed.
//   - notifications.thetrackernetwork.com: "Tracker Network" is Fortnite Tracker's own parent
//     brand — the same capture also showed cdn.thetrackernetwork.com, trackercdn.com, and
//     imgsvc.trackercdn.com serving real first-party images (player badges, premium icons), and
//     this endpoint (/api/notifications/fortnite) is a first-party notifications API, not an
//     ad/tracking call. Stays allowed.
//   - accounts.google.com, content-autofill.googleapis.com: raised as blocklist candidates after
//     both showed up repeating every 4-8s in live Webshare traffic. Checked for real, the same way
//     as everything else here — a fresh Puppeteer capture of both fortnitetracker.com/events and a
//     real profile page (10s settle window each) shows ZERO requests to either host, and neither
//     string appears anywhere in either page's rendered HTML (no <link>/<script> reference, unlike
//     www.google-analytics.com below). Nothing in this codebase's own pages calls them. That's the
//     opposite of "safe to block, confirmed ad-tech" — it means the traffic pattern that surfaced
//     them isn't explained by a normal page load at all. Both are well-known signatures of a
//     Chrome tab that's been left open (Chrome's own background autofill-prediction pings, and a
//     Google account/session-related periodic call) rather than something a fresh scrape's page
//     script requests once and finishes with. Left OFF the blocklist deliberately — see the
//     browser-close investigation in test/tournament-scraper-browser-close.test.js and this
//     session's findings: this is stronger evidence of a leaked/orphaned Chromium process
//     somewhere than it is evidence of missing ad-tech blocking, and blocking the symptom here
//     would only obscure that if it recurs.
const BLOCKED_DOMAINS = new Set([
  'ad.doubleclick.net',
  'securepubads.g.doubleclick.net',
  'consent.nitrocnct.com',
  'tags.crwdcntrl.net',
  'cdn.hadronid.net',
  'btloader.com',
  'api.btloader.com',
  'cdn.api.btloader.com',
  'cdn.btloader.com',
  'c.amazon-adsystem.com',
  'config.aps.amazon-adsystem.com',
  'aax.amazon-adsystem.com',
  'secure.cdn.fastclick.net',
  'prod.us-east-1.cxm-bcn.publisher-services.amazon.dev',
  'api.id5-sync.com',
  'cdn.id5-sync.com',
  'singingunicorn.com',
  'ad-delivery.net',
  'ab.dns-finder.com',
  'a.ad.gt',
  'live.primis.tech',
  'pagead2.googlesyndication.com',
  'www.googletagmanager.com',
  'ats-wrapper.privacymanager.io',
  'sb.scorecardresearch.com',
  'srv.scalibur.io',
  'floors.nitropay.com',
  's.nitropay.com',
  'static.cloudflareinsights.com',
  // Found during this same real capture, not in the original candidate list, but same category
  // and same confidence: every path ever observed hitting these hosts (across repeated live runs
  // of both the events page and a profile page) was a single-purpose ad/identity/analytics call —
  // region1.google-analytics.com's /g/collect (GA4 pageview beacon), api.rlcdn.com's
  // /api/identity/envelope (LiveRamp identity resolution), gum.criteo.com's /sid/json (Criteo ID
  // sync), match.adsrvr.org's /track/rid (The Trade Desk match tracking), and www.google.com's
  // /ccm/collect (Google conversion-tracking pixel — the one path ever seen on this specific host
  // here, despite www.google.com being a shared hostname other sites sometimes use for unrelated
  // legitimate purposes).
  'region1.google-analytics.com',
  'api.rlcdn.com',
  'gum.criteo.com',
  'match.adsrvr.org',
  'www.google.com',
  // Confirmed via a fresh real capture of fortnitetracker.com/events: the page's own HTML has
  // `<link rel="preconnect" href="//www.google-analytics.com">` — a genuine analytics preconnect
  // hint the page ships, same category as region1.google-analytics.com above (the actual GA4
  // beacon collector), just the preconnect target rather than the collector endpoint itself.
  'www.google-analytics.com',
]);

// Exact-hostname match against BLOCKED_DOMAINS — deliberately not a suffix/subdomain match: the
// list above already spells out every distinct subdomain actually observed (e.g. both
// api.btloader.com and cdn.api.btloader.com separately), so a broader match would only risk
// catching some future, unverified subdomain of one of these registrable domains that was never
// actually confirmed to be ad-tech.
function isBlockedDomain(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return BLOCKED_DOMAINS.has(hostname);
}

// Call right after page creation, before any navigation. Aborting a request here happens before
// Puppeteer ever sends it over the wire — that's what actually saves proxy bandwidth, as opposed
// to letting it complete and just not reading the response.
async function blockUnnecessaryResources(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
      req.abort();
    } else if (isBlockedDomain(req.url())) {
      // Distinct error code from the plain abort() above (default 'failed') so a test can tell
      // "aborted by this domain blocklist" apart from a real network failure without needing the
      // domain to actually resolve.
      req.abort('blockedbyclient');
    } else {
      req.continue();
    }
  });
}

// Concurrency limit on live Puppeteer browsers — both scraper.js's scrapePlayerOnce and
// tournament-scraper.js's fetchRawCalendar launch a brand-new headless Chromium process per call,
// and nothing anywhere in this codebase previously capped how many could run at once. The
// realistic worst case: rescrapeRegisteredPlayers (players.js) invalidates cached stats for every
// registered player in a region the instant a tournament's start time passes, so the natural rush
// of everyone queueing right as that tournament goes live is exactly when a thundering herd of
// concurrent Chromium launches is most likely — each getPlayerStats cache miss (players.js) fires
// its own independent scrapePlayer call with no coordination between them. On a VPS this small
// (458MB RAM total, most of it already spoken for by Node/Discord.js/MongoDB before a single
// Chromium process launches), a handful of simultaneous headless Chromium instances is a real path
// to exhausting memory and taking the whole bot down, not just slowing individual scrapes.
//
// 2, not 3: picked at the conservative end of a 2-3 range specifically because 458MB is the WHOLE
// box, not memory set aside for scraping — headless Chromium alone commonly runs 100-300MB+ RSS
// per instance depending on page weight, and that's before Node's own process, Discord.js's
// gateway connection, and (if run locally rather than Atlas) MongoDB. Two concurrent instances
// already claims a large fraction of what's left; three felt like too little margin for a page
// that's briefly heavier than usual (or a temporary OS/GC spike) to tip the whole box into swap
// thrashing rather than just queueing the next launch.
//
// Dependency-free by design (no p-limit/bottleneck in package.json) — a small in-process FIFO
// queue of resolve functions is the whole mechanism.
const MAX_CONCURRENT_BROWSERS = 2;

let activeBrowserCount = 0;
const browserSlotQueue = [];

function acquireBrowserSlot() {
  if (activeBrowserCount < MAX_CONCURRENT_BROWSERS) {
    activeBrowserCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => browserSlotQueue.push(resolve));
}

// Hands a freed slot directly to the next FIFO waiter (if any) rather than decrementing the
// counter and letting a fresh acquireBrowserSlot() race for it — so the slot count invariant
// (activeBrowserCount <= MAX_CONCURRENT_BROWSERS) holds at every instant, and the queue can never
// starve: whoever has waited longest is always served next, regardless of how many new callers
// arrive after them.
function releaseBrowserSlot() {
  const next = browserSlotQueue.shift();
  if (next) {
    next();
  } else {
    activeBrowserCount--;
  }
}

// Wraps a full browser lifecycle (launch through close) so no more than MAX_CONCURRENT_BROWSERS
// headless Chromium processes ever run at once — everything beyond the cap waits its turn instead
// of launching immediately (or being dropped: the queue only ever grows and drains, nothing times
// out of it). Call with an async function that does its own puppeteer.launch()/browser.close() —
// the slot is held for that function's entire lifetime and released in a finally, so it's freed
// even if the scrape throws.
async function withBrowserSlot(fn) {
  await acquireBrowserSlot();
  try {
    return await fn();
  } finally {
    releaseBrowserSlot();
  }
}

// Confirmed via a real production incident (a headless Chromium process still alive ~2 hours
// after the scrape that launched it should have finished) AND by reading Puppeteer's own
// BrowserLauncher.closeBrowser: when the CDP `Browser.close` command is acknowledged promptly (so
// its own ~180s protocolTimeout never fires), Puppeteer falls through to
// `await browserProcess.hasClosed()` — a promise that only resolves on the underlying OS
// process's own 'exit' event, with NO timeout anywhere in that path. If Chrome's actual shutdown
// stalls (e.g. it's still busy with background page activity — matches what was observed: the
// same ~15 background hostnames continuing to fire every 4-8s the whole ~2 hours), that wait is
// genuinely unbounded — none of this codebase's own timeouts (page.goto's, or protocolTimeout)
// cover this specific step.
//
// This races EVERY real browser.close() call in this codebase against a short timeout, force-
// killing the underlying OS process directly via SIGKILL (bypassing Puppeteer's own close
// sequence entirely, which is exactly what's stuck) if it doesn't resolve in time. 8s — within the
// 5-10s range a healthy close should comfortably finish inside, while bounding the worst case to
// single-digit seconds instead of hours.
//
// Deliberately does NOT add its own kill-fallback for a REJECTED browser.close() (as opposed to
// one that never settles) — Puppeteer's own closeBrowser already force-kills internally before
// rejecting in that case (see its catch branch), so a second kill here would be redundant; only
// the "never settles at all" case has no existing safety net, which is what this adds.
const BROWSER_CLOSE_TIMEOUT_MS = 8000;

async function closeBrowserSafely(browser, timeoutMs = BROWSER_CLOSE_TIMEOUT_MS) {
  let timer;
  try {
    const timedOut = await Promise.race([
      browser.close().then(() => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(true), timeoutMs); }),
    ]);

    if (timedOut) {
      console.warn(`⚠️ browser.close() did not resolve within ${timeoutMs}ms — force-killing the underlying Chromium process directly (SIGKILL) instead of continuing to wait on it`);
      browser.process()?.kill('SIGKILL');
    }
  } finally {
    clearTimeout(timer);
  }
}

// Called once at module load by each scraper file, so it's obvious from a fresh startup's logs
// which path each one is actually running on.
function logProxyMode(label) {
  if (isProxyConfigured()) {
    console.log(`[${label}] Fortnite Tracker requests: PROXIED via ${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`);
  } else {
    console.log(`[${label}] Fortnite Tracker requests: DIRECT (no proxy configured — set PROXY_HOST/PROXY_PORT/PROXY_USERNAME/PROXY_PASSWORD in .env)`);
  }
}

module.exports = {
  isProxyConfigured, proxyLaunchArgs, authenticatePage, blockUnnecessaryResources, logProxyMode,
  isBlockedDomain, BLOCKED_DOMAINS,
  withBrowserSlot, MAX_CONCURRENT_BROWSERS,
  closeBrowserSafely, BROWSER_CLOSE_TIMEOUT_MS,
};
