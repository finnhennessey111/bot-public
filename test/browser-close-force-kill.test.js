// Verifies the fix for a real production incident: a headless Chromium process was still alive
// ~2 hours after the scrape that launched it should have finished (15-30s expected). Root-caused
// by reading Puppeteer's own BrowserLauncher.closeBrowser: when the CDP `Browser.close` command is
// acknowledged promptly, Puppeteer falls through to `await browserProcess.hasClosed()` — a promise
// bound to nothing but the OS process's own 'exit' event, with NO timeout anywhere in that path.
// If Chrome's actual shutdown stalls, browser.close() itself can hang indefinitely, with none of
// this codebase's existing timeouts (page.goto's, protocolTimeout) covering that specific step.
//
// proxy-config.js's closeBrowserSafely fixes this: races the real browser.close() against a short
// timeout, force-killing the OS process directly (SIGKILL) if it doesn't resolve in time. These
// tests use fake browser objects (no real Chromium) so the "hang" and "force-kill" behavior can be
// asserted precisely and fast, with a short overridden timeoutMs standing in for the real 8s
// default (BROWSER_CLOSE_TIMEOUT_MS) — same relationship, just scaled down for a fast test.
const test = require('node:test');
const assert = require('node:assert/strict');

const { closeBrowserSafely, withBrowserSlot, MAX_CONCURRENT_BROWSERS, BROWSER_CLOSE_TIMEOUT_MS } = require('../proxy-config');

function fakeProcess() {
  const calls = [];
  return { process: { kill: (signal) => calls.push(signal) }, calls };
}

test('BROWSER_CLOSE_TIMEOUT_MS is in the 5-10s range this fix was scoped to', () => {
  assert.ok(BROWSER_CLOSE_TIMEOUT_MS >= 5000 && BROWSER_CLOSE_TIMEOUT_MS <= 10000, `expected 5000-10000, got ${BROWSER_CLOSE_TIMEOUT_MS}`);
});

test('closeBrowserSafely: a healthy, quickly-resolving close() is completely unaffected — no force-kill, resolves promptly', async () => {
  const { process: fakeProc, calls } = fakeProcess();
  let closeCalled = false;
  const browser = {
    close: async () => { closeCalled = true; await new Promise(r => setTimeout(r, 10)); },
    process: () => fakeProc,
  };

  const start = Date.now();
  await closeBrowserSafely(browser, 5000); // large timeout relative to the 10ms close — must never fire
  const elapsedMs = Date.now() - start;

  assert.equal(closeCalled, true, 'the real browser.close() must still be called on the healthy path');
  assert.equal(calls.length, 0, 'a close() that resolves normally must NEVER trigger the SIGKILL fallback');
  assert.ok(elapsedMs < 500, `expected the healthy close to resolve quickly (well under its own 10ms + scheduling slack), took ${elapsedMs}ms`);
});

test('closeBrowserSafely: a browser.close() that never resolves on its own gets force-killed via SIGKILL within the configured timeout — not stuck for its full (simulated) hang duration', async () => {
  const { process: fakeProc, calls } = fakeProcess();
  const FORCE_KILL_TIMEOUT_MS = 150;
  const SIMULATED_HANG_MS = 5000; // stands in for the real incident's ~2 hours — close() "would" resolve eventually, just wildly late

  const browser = {
    // .unref() — this timer only exists to simulate "would eventually resolve, just very late"; it
    // must never keep the test process alive after closeBrowserSafely has already moved on via the
    // force-kill timeout, the same way a real orphaned Chromium process wouldn't block Node either.
    close: () => new Promise(resolve => setTimeout(resolve, SIMULATED_HANG_MS).unref()),
    process: () => fakeProc,
  };

  const start = Date.now();
  await closeBrowserSafely(browser, FORCE_KILL_TIMEOUT_MS);
  const elapsedMs = Date.now() - start;

  assert.deepEqual(calls, ['SIGKILL'], 'must force-kill the underlying process exactly once, with SIGKILL specifically');
  assert.ok(
    elapsedMs >= FORCE_KILL_TIMEOUT_MS && elapsedMs < SIMULATED_HANG_MS,
    `must resolve around the configured ${FORCE_KILL_TIMEOUT_MS}ms timeout, NOT wait anywhere near the simulated ${SIMULATED_HANG_MS}ms hang — took ${elapsedMs}ms`
  );
});

test('closeBrowserSafely: a REJECTED browser.close() (not a hang) still propagates the error, and does NOT redundantly force-kill — Puppeteer already force-kills internally in that case', async () => {
  const { process: fakeProc, calls } = fakeProcess();
  const browser = {
    close: async () => { throw new Error('simulated CDP failure'); },
    process: () => fakeProc,
  };

  await assert.rejects(() => closeBrowserSafely(browser, 5000), /simulated CDP failure/);
  assert.equal(calls.length, 0, 'a rejection (not a hang) must not trigger a redundant SIGKILL — Puppeteer\'s own closeBrowser already force-kills before rejecting in this case');
});

test('closeBrowserSafely + withBrowserSlot: a hung close() still releases its concurrency slot promptly, bounded by the close timeout — not stuck for the mocked hang\'s full duration', async () => {
  const FORCE_KILL_TIMEOUT_MS = 150;
  const SIMULATED_HANG_MS = 5000;
  const killCalls = [];

  function hungBrowser() {
    return {
      // .unref() — this timer only exists to simulate "would eventually resolve, just very late"; it
    // must never keep the test process alive after closeBrowserSafely has already moved on via the
    // force-kill timeout, the same way a real orphaned Chromium process wouldn't block Node either.
    close: () => new Promise(resolve => setTimeout(resolve, SIMULATED_HANG_MS).unref()),
      process: () => ({ kill: (signal) => killCalls.push(signal) }),
    };
  }

  // Fill every real concurrency slot with a task whose browser.close() hangs — same real shape as
  // scraper.js/tournament-scraper.js: the browser lifecycle (including the finally's close call)
  // runs entirely inside withBrowserSlot.
  const holders = Array.from({ length: MAX_CONCURRENT_BROWSERS }, () => withBrowserSlot(async () => {
    const browser = hungBrowser();
    try {
      return 'did work';
    } finally {
      await closeBrowserSafely(browser, FORCE_KILL_TIMEOUT_MS);
    }
  }));

  const start = Date.now();
  // If a hung close() held its slot for anywhere near the full simulated hang, this next acquire
  // would queue behind it for ~SIMULATED_HANG_MS. It must instead become available once the force-
  // kill timeout fires, not when the fake browser's own close() would have eventually resolved.
  const result = await withBrowserSlot(async () => 'slot free');
  const elapsedMs = Date.now() - start;

  assert.equal(result, 'slot free');
  assert.ok(
    elapsedMs < SIMULATED_HANG_MS,
    `slot must free up once the force-kill timeout fires, NOT after the full simulated hang — took ${elapsedMs}ms (hang was ${SIMULATED_HANG_MS}ms)`
  );
  assert.ok(
    elapsedMs < FORCE_KILL_TIMEOUT_MS + 1000,
    `expected slot release shortly after the ${FORCE_KILL_TIMEOUT_MS}ms force-kill timeout (with some scheduling slack), took ${elapsedMs}ms`
  );

  await Promise.all(holders); // let the holder tasks fully settle before the test ends
  assert.equal(killCalls.length, MAX_CONCURRENT_BROWSERS, 'every hung holder must have been force-killed, not just the first');
});
