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

// Call right after page creation, before any navigation. Aborting a request here happens before
// Puppeteer ever sends it over the wire — that's what actually saves proxy bandwidth, as opposed
// to letting it complete and just not reading the response.
async function blockUnnecessaryResources(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
      req.abort();
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

module.exports = { isProxyConfigured, proxyLaunchArgs, authenticatePage, blockUnnecessaryResources, logProxyMode };
