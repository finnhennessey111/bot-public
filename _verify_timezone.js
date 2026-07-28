// One-off timezone verification — NOT part of the app, delete after use.
// Run with: node _verify_timezone.js EU
//
// Fetches the same schedule page 3x with different emulated browser timezones (default/system,
// forced UTC, forced America/Los_Angeles which is UTC-7 in July/DST) and compares the displayed
// event times. page.emulateTimezone() only affects what JS running INSIDE the browser tab
// perceives as its timezone — it has no effect on Epic's server. So the comparison still correctly
// distinguishes the two possible mechanisms: if the site formats times client-side (post-hydration)
// using the browser's local timezone, the UTC and LA runs will show times exactly 7 hours apart for
// the same events; if the site bakes in a fixed zone server-side regardless of viewer, all 3 runs
// will show identical times no matter what we emulate.
//
// Each of the 3 fetches retries up to 3 attempts total on 403/timeout/no-parseable-data before
// giving up — same rotating-proxy retry logic planned for the real scraper. A run that returns
// HTTP 200 but 0 parseable entries (e.g. a challenge/interstitial page) is NOT treated as success —
// only a real, non-empty schedule counts, otherwise the final comparison would silently be built on
// empty/garbage data for that arm and produce a meaningless verdict.
//
// Runs standalone (not via index.js, which calls dotenv.config() before requiring anything else),
// so it must load .env itself — otherwise proxy-config.js's isProxyConfigured() sees an empty
// process.env and silently runs DIRECT regardless of what's actually in .env on disk.
require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const { proxyLaunchArgs, authenticatePage, logProxyMode } = require('./proxy-config');

logProxyMode('verify-timezone');

const region = process.argv[2] || 'EU';
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Pulls out the sequence of (time, roundLabel, eventName) triples in document order, ignoring the
// optional trailing player-name line — same line-grammar as the real inspection, just enough to
// diff two runs against each other.
function extractEntries(bodyText) {
  const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
  const isTime = l => /^\d{1,2}:\d{2} (AM|PM)$/i.test(l);
  const isRoundLabel = l => /^(WEEK|SESSION) \d+( - ROUND \d+)?$/.test(l);

  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTime(lines[i]) && isRoundLabel(lines[i + 1] ?? '')) {
      const time = lines[i];
      const roundLabel = lines[i + 1];
      const eventName = lines[i + 2] ?? '';
      entries.push(`${time} | ${roundLabel} | ${eventName}`);
    }
  }
  return entries;
}

async function fetchBodyTextOnce(timezone) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyLaunchArgs()],
  });

  try {
    const page = await browser.newPage();
    await authenticatePage(page);
    if (timezone) await page.emulateTimezone(timezone);
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const url = `https://www.fortnite.com/competitive/schedule?region=${region}`;
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const status = response.status();
    const bodyText = await page.evaluate(() => document.body.innerText);
    return { status, bodyText };
  } finally {
    await browser.close();
  }
}

async function fetchBodyText(timezone, label) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result;
    try {
      result = await fetchBodyTextOnce(timezone);
    } catch (err) {
      console.log(`  [${label}] attempt ${attempt}/${MAX_ATTEMPTS} threw: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new Error(`[${label}] all ${MAX_ATTEMPTS} attempts failed (last error: ${err.message})`);
    }

    const entries = extractEntries(result.bodyText);
    if (result.status === 200 && entries.length > 0) {
      console.log(`  [${label}] attempt ${attempt}/${MAX_ATTEMPTS} succeeded: HTTP 200, ${entries.length} entries parsed`);
      return result.bodyText;
    }

    console.log(`  [${label}] attempt ${attempt}/${MAX_ATTEMPTS} did not yield usable data (HTTP ${result.status}, ${entries.length} entries parsed)`);
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  throw new Error(`[${label}] all ${MAX_ATTEMPTS} attempts failed to return usable schedule data — cannot trust any comparison built on this`);
}

(async () => {
  console.log('Fetching with system-default timezone...');
  const textDefault = await fetchBodyText(null, 'default');
  console.log('Fetching with forced UTC...');
  const textUTC = await fetchBodyText('UTC', 'UTC');
  console.log('Fetching with forced America/Los_Angeles (UTC-7 in July)...');
  const textLA = await fetchBodyText('America/Los_Angeles', 'LA');

  fs.writeFileSync(`tz_${region}_default.txt`, textDefault);
  fs.writeFileSync(`tz_${region}_utc.txt`, textUTC);
  fs.writeFileSync(`tz_${region}_la.txt`, textLA);

  const entriesDefault = extractEntries(textDefault);
  const entriesUTC = extractEntries(textUTC);
  const entriesLA = extractEntries(textLA);

  console.log(`\nAll 3 fetches succeeded with real data: ${entriesDefault.length} / ${entriesUTC.length} / ${entriesLA.length} entries (default/UTC/LA)\n`);
  console.log('First 15 entries, side by side:\n');
  const n = Math.min(15, entriesDefault.length, entriesUTC.length, entriesLA.length);
  for (let i = 0; i < n; i++) {
    console.log(`DEFAULT: ${entriesDefault[i]}`);
    console.log(`UTC:     ${entriesUTC[i]}`);
    console.log(`LA:      ${entriesLA[i]}`);
    console.log('---');
  }

  const defaultMatchesUTC = JSON.stringify(entriesDefault) === JSON.stringify(entriesUTC);
  const utcMatchesLA = JSON.stringify(entriesUTC) === JSON.stringify(entriesLA);
  console.log(`\nDefault === UTC: ${defaultMatchesUTC}`);
  console.log(`UTC === LA: ${utcMatchesLA}`);
  if (!utcMatchesLA) {
    console.log('=> Times DO shift with emulated timezone: page renders client-side in browser-local time. Force page.emulateTimezone(\'UTC\') in the real scraper and treat displayed times as true UTC.');
  } else {
    console.log('=> Times do NOT shift with emulated timezone: page bakes in a fixed zone server-side. Need to cross-reference a known event against tournament-scraper.js\'s existing Fortnite Tracker beginTime to pin down which fixed zone this is.');
  }
})().catch(err => {
  console.error('Verification failed:', err.message);
  process.exit(1);
});
