// Verifies the Puppeteer-launch concurrency limiter: proxy-config.js's withBrowserSlot/
// MAX_CONCURRENT_BROWSERS, now wrapping the browser lifecycle in both scraper.js's
// scrapePlayerOnce and tournament-scraper.js's fetchRawCalendar — previously nothing anywhere in
// this codebase capped how many headless Chromium processes could run at once, which on a 458MB
// RAM VPS is a real path to exhausting memory (e.g. every registered player's cached stats
// expiring the instant a tournament goes live, then everyone queueing within seconds of each
// other — see proxy-config.js's header comment on withBrowserSlot for the full scenario).
//
// The synthetic tests below drive the real withBrowserSlot/MAX_CONCURRENT_BROWSERS directly
// against a fake task (no real Chromium) so concurrency counts and arrival/completion order are
// exact and fast to assert on. The last test wires the same real withBrowserSlot up against REAL
// puppeteer.launch() calls (a real local HTTP server, same precedent as
// test/scraper-resource-blocking.test.js) to prove it actually gates real browser launches
// end-to-end, not just an abstract counter nothing calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const puppeteer = require('puppeteer');

const { withBrowserSlot, MAX_CONCURRENT_BROWSERS } = require('../proxy-config');

test('MAX_CONCURRENT_BROWSERS is conservative for a small (458MB RAM) VPS — 2 or 3, not more', () => {
  assert.ok(
    MAX_CONCURRENT_BROWSERS === 2 || MAX_CONCURRENT_BROWSERS === 3,
    `expected 2 or 3, got ${MAX_CONCURRENT_BROWSERS}`
  );
});

test('withBrowserSlot: never runs more than MAX_CONCURRENT_BROWSERS tasks at once, and every task eventually completes', async () => {
  const TASK_COUNT = MAX_CONCURRENT_BROWSERS * 4; // comfortably more requests than the cap allows at once
  let active = 0;
  let peakActive = 0;
  let completed = 0;

  const tasks = Array.from({ length: TASK_COUNT }, (_, i) => withBrowserSlot(async () => {
    active++;
    peakActive = Math.max(peakActive, active);
    // A real scrape isn't instantaneous — a short real delay is what actually lets multiple
    // "clicks" overlap in time and exercise the cap, rather than every task finishing
    // synchronously before the next one even starts.
    await new Promise(r => setTimeout(r, 30));
    active--;
    completed++;
    return i;
  }));

  const results = await Promise.all(tasks);

  assert.ok(peakActive <= MAX_CONCURRENT_BROWSERS, `observed ${peakActive} concurrent tasks, cap is ${MAX_CONCURRENT_BROWSERS}`);
  assert.ok(peakActive >= 2, 'sanity check: this test is only meaningful if tasks genuinely overlapped in time');
  assert.equal(completed, TASK_COUNT, 'every queued task must eventually complete — queued work is delayed, not dropped');
  assert.deepEqual(results.slice().sort((a, b) => a - b), Array.from({ length: TASK_COUNT }, (_, i) => i));
});

test('withBrowserSlot: a throwing task still releases its slot — no leaked capacity after an error', async () => {
  // Fill every slot with a task that throws (a real scrape failing mid-navigation, say), then
  // confirm a fresh task afterward gets a slot promptly rather than waiting behind capacity an
  // error never gave back.
  const failures = await Promise.allSettled(
    Array.from({ length: MAX_CONCURRENT_BROWSERS }, () => withBrowserSlot(async () => {
      await new Promise(r => setTimeout(r, 10));
      throw new Error('simulated scrape failure');
    }))
  );
  assert.ok(failures.every(f => f.status === 'rejected'));

  const start = Date.now();
  const result = await withBrowserSlot(async () => 'ok');
  const elapsedMs = Date.now() - start;

  assert.equal(result, 'ok');
  assert.ok(elapsedMs < 500, `expected a slot to be immediately available once the failures released theirs, took ${elapsedMs}ms`);
});

test('withBrowserSlot: queued waiters are served in FIFO arrival order — no starvation', async () => {
  // Every slot gets occupied by a long-running "holder" first, then more requests queue up behind
  // them in a known arrival order. Once the holders release, the queued ones must complete in the
  // same order they arrived in — proving the earliest-waiting caller is never starved by later
  // arrivals cutting in front.
  const order = [];
  const holderStarted = [];
  let releaseHolders;
  const holdersCanRelease = new Promise(r => { releaseHolders = r; });

  const holders = Array.from({ length: MAX_CONCURRENT_BROWSERS }, (_, i) => withBrowserSlot(async () => {
    holderStarted.push(i);
    await holdersCanRelease;
  }));

  // Let the holders actually acquire their slots (capacity was free) before queuing more behind them.
  await new Promise(r => setTimeout(r, 20));
  assert.equal(holderStarted.length, MAX_CONCURRENT_BROWSERS, 'every holder should have acquired a slot immediately');

  const QUEUED_COUNT = 5;
  const queuedTasks = [];
  for (let i = 0; i < QUEUED_COUNT; i++) {
    await new Promise(r => setTimeout(r, 5)); // stagger so arrival order at the queue is deterministic
    queuedTasks.push(withBrowserSlot(async () => { order.push(i); }));
  }

  releaseHolders();
  await Promise.all(holders);
  await Promise.all(queuedTasks);

  assert.deepEqual(
    order, Array.from({ length: QUEUED_COUNT }, (_, i) => i),
    'queued tasks must complete in the order they arrived'
  );
});

test('withBrowserSlot against REAL puppeteer.launch(): never more than MAX_CONCURRENT_BROWSERS real Chromium processes alive at once, and every request eventually completes', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><head><title>concurrency-test</title></head><body>ok</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const REQUEST_COUNT = MAX_CONCURRENT_BROWSERS * 3;
  let aliveBrowsers = 0;
  let peakAliveBrowsers = 0;

  // Same shape scraper.js's scrapePlayerOnce and tournament-scraper.js's fetchRawCalendar now
  // use: the browser's whole launch-through-close lifetime runs inside withBrowserSlot.
  async function simulatedScrapeRequest() {
    return withBrowserSlot(async () => {
      const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      aliveBrowsers++;
      peakAliveBrowsers = Math.max(peakAliveBrowsers, aliveBrowsers);
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        return await page.title();
      } finally {
        await browser.close();
        aliveBrowsers--;
      }
    });
  }

  try {
    const results = await Promise.all(Array.from({ length: REQUEST_COUNT }, () => simulatedScrapeRequest()));

    assert.equal(results.length, REQUEST_COUNT, 'every request must eventually complete, not be dropped');
    assert.ok(results.every(t => t === 'concurrency-test'), 'every request must still have actually loaded the real page');
    assert.ok(
      peakAliveBrowsers <= MAX_CONCURRENT_BROWSERS,
      `observed ${peakAliveBrowsers} real Chromium processes alive at once, cap is ${MAX_CONCURRENT_BROWSERS}`
    );
    assert.ok(
      peakAliveBrowsers >= 2,
      `sanity check: with ${REQUEST_COUNT} requests fired at once against a cap of ${MAX_CONCURRENT_BROWSERS}, at least 2 real browsers should have genuinely overlapped — otherwise this test isn't proving anything about real concurrency (peak observed: ${peakAliveBrowsers})`
    );
  } finally {
    await new Promise(r => server.close(r));
  }
});
