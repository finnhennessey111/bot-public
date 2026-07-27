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

// Called once at module load by each scraper file, so it's obvious from a fresh startup's logs
// which path each one is actually running on.
function logProxyMode(label) {
  if (isProxyConfigured()) {
    console.log(`[${label}] Fortnite Tracker requests: PROXIED via ${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`);
  } else {
    console.log(`[${label}] Fortnite Tracker requests: DIRECT (no proxy configured — set PROXY_HOST/PROXY_PORT/PROXY_USERNAME/PROXY_PASSWORD in .env)`);
  }
}

module.exports = { isProxyConfigured, proxyLaunchArgs, authenticatePage, logProxyMode };
