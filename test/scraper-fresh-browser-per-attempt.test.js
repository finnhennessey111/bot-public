// Verifies that scrapePlayer's retry loop launches a genuinely NEW puppeteer.launch() browser on
// every attempt — never reusing a browser/page across retries. This matters specifically because
// we're on a paid rotating-residential-proxy plan (Webshare): each fresh local connection should
// get a different backend exit IP, and reusing a browser/connection across "retries" would defeat
// the whole point of retrying through a rotating pool.
//
// Monkey-patches the real `puppeteer` module's `.launch` (restored after) rather than reimplementing
// scrapePlayer's control flow — this exercises the actual retry loop in scraper.js, proving the real
// production code launches 3 separate browsers for 3 attempts, not 1 browser with 3 retried
// navigations.
const test = require('node:test');
const assert = require('node:assert/strict');

const puppeteer = require('puppeteer');
const scraperModule = require('../scraper');

test('scrapePlayer: launches a fresh puppeteer.launch() browser per attempt, closing the previous one first', async () => {
  const originalLaunch = puppeteer.launch;
  const browserRecords = []; // { launchIndex, closed }

  puppeteer.launch = async () => {
    // The core assertion: by the time a NEW browser launches, the previous attempt's browser must
    // already be fully closed — proving there's no overlap/reuse, just a clean launch -> close ->
    // launch sequence per attempt.
    if (browserRecords.length > 0) {
      const previous = browserRecords[browserRecords.length - 1];
      assert.equal(previous.closed, true, `browser #${previous.launchIndex} must be closed before the next attempt launches a new one`);
    }

    const record = { launchIndex: browserRecords.length + 1, closed: false };
    browserRecords.push(record);

    const fakePage = {
      async setUserAgent() {},
      async authenticate() {},
      async goto() {
        // Fail the first two attempts (simulating a bad exit IP / timeout), succeed on the third.
        if (record.launchIndex < 3) throw new Error(`simulated navigation timeout (browser #${record.launchIndex})`);
      },
      async evaluate() {
        return { powerRank: { points: 500 }, prSegments: [], currentSeason: 1, myEvents: [] };
      },
    };

    return {
      async newPage() { return fakePage; },
      async close() { record.closed = true; },
    };
  };

  try {
    const result = await scraperModule.scrapePlayer('TestPlayer', 'EU', null);

    assert.equal(browserRecords.length, 3, 'expected exactly 3 separate puppeteer.launch() calls, one per attempt');
    assert.deepEqual(browserRecords.map(r => r.launchIndex), [1, 2, 3]);
    assert.ok(browserRecords.every(r => r.closed), 'every launched browser (including the two failed attempts) must end up closed');
    assert.equal(result.totalPR, 500);
  } finally {
    puppeteer.launch = originalLaunch;
  }
});

test('scrapePlayer: even when every attempt fails, each one still gets its own fresh browser', async () => {
  const originalLaunch = puppeteer.launch;
  const browserRecords = [];

  puppeteer.launch = async () => {
    if (browserRecords.length > 0) {
      assert.equal(browserRecords[browserRecords.length - 1].closed, true);
    }
    const record = { launchIndex: browserRecords.length + 1, closed: false };
    browserRecords.push(record);

    return {
      async newPage() {
        return {
          async setUserAgent() {},
          async authenticate() {},
          async goto() { throw new Error(`always-fails browser #${record.launchIndex}`); },
        };
      },
      async close() { record.closed = true; },
    };
  };

  try {
    await assert.rejects(() => scraperModule.scrapePlayer('AlwaysFails', 'EU', null));
    assert.equal(browserRecords.length, 3);
    assert.ok(browserRecords.every(r => r.closed));
  } finally {
    puppeteer.launch = originalLaunch;
  }
});
