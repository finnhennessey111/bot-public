// Companion to test/scraper-fresh-browser-per-attempt.test.js and
// test/browser-concurrency-limit.test.js, but targeting tournament-scraper.js's two browser call
// sites (fetchRawCalendar, called via scrapeTrackerCalendar since it isn't exported directly, and
// fetchEventDescriptionRosterSize) instead of scraper.js's scrapePlayerOnce — those were the only
// two call sites with an existing real-browser-lifecycle test before this file. Written in
// response to a live-traffic finding (repeating requests to ~15 hostnames every 4-8s, well outside
// any real scraping cadence) that raised the possibility of an unclosed/leaked browser polling in
// the background. Reading both functions shows every browser.close() already sits in a
// try/finally, itself inside withBrowserSlot's own try/finally slot release — this file proves
// that holds under real error/timeout conditions, not just on the happy path, so the leak
// hypothesis can be ruled in or out with evidence instead of a guess.
const test = require('node:test');
const assert = require('node:assert/strict');

const puppeteer = require('puppeteer');
const { withBrowserSlot, MAX_CONCURRENT_BROWSERS } = require('../proxy-config');
const tournamentScraper = require('../tournament-scraper');
const config = require('../config');

// fetchRawCalendar now fetches once per config.ftCalendarPlaylists entry (duos, trios — see that
// function's own doc comment) and closes a separate browser for each, instead of one shared
// unfiltered fetch — every "closes exactly once" assertion below for fetchRawCalendar became
// "once per playlist" accordingly.
const CALENDAR_PLAYLIST_COUNT = config.ftCalendarPlaylists.length;

function fakeBrowser(record, { gotoThrows = null, evaluateReturns = null } = {}) {
  return {
    async newPage() {
      return {
        async setUserAgent() {},
        async authenticate() {},
        async setRequestInterception() {},
        on() {},
        async goto() {
          if (gotoThrows) throw gotoThrows;
        },
        async evaluate() {
          return evaluateReturns;
        },
      };
    },
    async close() {
      record.closeCount++;
    },
  };
}

test('fetchRawCalendar (via scrapeTrackerCalendar): success path closes one browser per playlist fetch, no leaks', async () => {
  const originalLaunch = puppeteer.launch;
  const record = { closeCount: 0 };
  puppeteer.launch = async () => fakeBrowser(record, { evaluateReturns: null }); // no imp_calendar found -> [] downstream, still exercises real close path

  try {
    const result = await tournamentScraper.scrapeTrackerCalendar();
    assert.deepEqual(result, []);
    assert.equal(record.closeCount, CALENDAR_PLAYLIST_COUNT, `browser.close() must be called once per playlist fetch (${CALENDAR_PLAYLIST_COUNT})`);
  } finally {
    puppeteer.launch = originalLaunch;
  }
});

test('fetchRawCalendar (via scrapeTrackerCalendar): a navigation timeout still closes every playlist fetch\'s browser, and the error propagates', async () => {
  const originalLaunch = puppeteer.launch;
  const record = { closeCount: 0 };
  const timeoutErr = new Error('Navigation timeout of 30000 ms exceeded');
  puppeteer.launch = async () => fakeBrowser(record, { gotoThrows: timeoutErr });

  try {
    await assert.rejects(() => tournamentScraper.scrapeTrackerCalendar(), /Navigation timeout/);
    assert.equal(record.closeCount, CALENDAR_PLAYLIST_COUNT, 'browser.close() must still run on a timeout, via the finally, for every playlist fetch');
  } finally {
    puppeteer.launch = originalLaunch;
  }
});

test('fetchEventDescriptionRosterSize: success path closes the browser exactly once', async () => {
  const originalLaunch = puppeteer.launch;
  const record = { closeCount: 0 };
  puppeteer.launch = async () => fakeBrowser(record, { evaluateReturns: null });

  try {
    const result = await tournamentScraper.fetchEventDescriptionRosterSize('some-event-id');
    assert.equal(result, null);
    assert.equal(record.closeCount, 1);
  } finally {
    puppeteer.launch = originalLaunch;
  }
});

test('fetchEventDescriptionRosterSize: a page-load error still closes the browser exactly once, and the error propagates (enrichWithDescriptionRosterSize is what catches it, not this function)', async () => {
  const originalLaunch = puppeteer.launch;
  const record = { closeCount: 0 };
  puppeteer.launch = async () => fakeBrowser(record, { gotoThrows: new Error('simulated nav failure') });

  try {
    await assert.rejects(() => tournamentScraper.fetchEventDescriptionRosterSize('some-event-id'), /simulated nav failure/);
    assert.equal(record.closeCount, 1);
  } finally {
    puppeteer.launch = originalLaunch;
  }
});

test('enrichWithDescriptionRosterSize: a single group failing to fetch does not leak that call\'s browser and does not abort the rest', async () => {
  const originalFetch = tournamentScraper.fetchEventDescriptionRosterSize;
  const originalLaunch = puppeteer.launch;
  const closeCounts = [];

  // Exercise the real fetchEventDescriptionRosterSize (real close-path), not a stub, for the first
  // (failing) group, then a stub for the second so this test isn't also re-proving success-path
  // behavior already covered above.
  let call = 0;
  puppeteer.launch = async () => {
    call++;
    const record = { closeCount: 0 };
    closeCounts.push(record);
    if (call === 1) return fakeBrowser(record, { gotoThrows: new Error('boom') });
    return fakeBrowser(record, { evaluateReturns: null });
  };

  const groups = [
    { name: 'Group A', rosterSize: null, eventId: 'a', isTrios: false },
    { name: 'Group B', rosterSize: null, eventId: 'b', isTrios: false },
  ];

  try {
    const result = await tournamentScraper.enrichWithDescriptionRosterSize(groups);
    assert.equal(result.length, 2, 'a failed fetch for one group must not abort processing the rest');
    assert.ok(closeCounts.every(r => r.closeCount === 1), 'every browser launched across both groups, including the failing one, must be closed exactly once');
  } finally {
    puppeteer.launch = originalLaunch;
    tournamentScraper.fetchEventDescriptionRosterSize = originalFetch;
  }
});

test('withBrowserSlot: filling every slot via real tournament-scraper failures still releases them all — no stuck slot after an error mid-slot', async () => {
  const originalLaunch = puppeteer.launch;
  puppeteer.launch = async () => {
    const record = { closeCount: 0 };
    return fakeBrowser(record, { gotoThrows: new Error('simulated failure to fill the slot') });
  };

  try {
    const failures = await Promise.allSettled(
      Array.from({ length: MAX_CONCURRENT_BROWSERS }, () => tournamentScraper.fetchEventDescriptionRosterSize('id'))
    );
    assert.ok(failures.every(f => f.status === 'rejected'), 'every one of these calls should have failed inside the slot');

    // If a slot were left stuck by one of those failures, this next acquire would hang/queue
    // indefinitely behind capacity nothing ever gave back.
    const start = Date.now();
    const result = await withBrowserSlot(async () => 'slot free');
    const elapsedMs = Date.now() - start;

    assert.equal(result, 'slot free');
    assert.ok(elapsedMs < 500, `expected an immediately free slot after every failure released its own, took ${elapsedMs}ms`);
  } finally {
    puppeteer.launch = originalLaunch;
  }
});
