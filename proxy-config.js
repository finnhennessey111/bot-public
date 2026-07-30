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
};
