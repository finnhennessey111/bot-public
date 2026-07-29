// Verifies scrapePlayer's retry logic: a Puppeteer navigation timeout on one attempt must not
// fail the whole scrape outright — it should retry (a rotating proxy gets a different exit IP
// each attempt) and only give up after PLAYER_SCRAPE_MAX_ATTEMPTS genuinely-failed attempts.
//
// scrapePlayer delegates through module.exports.scrapePlayerOnce (not a closed-over local
// reference) specifically so a test can swap in a fake single-attempt implementation here and
// exercise the real retry/backoff/error-wrapping control flow without a live Puppeteer/network
// round trip.
const test = require('node:test');
const assert = require('node:assert/strict');

const scraperModule = require('../scraper');

function withStubbedScrapeOnce(stub, fn) {
  const original = scraperModule.scrapePlayerOnce;
  scraperModule.scrapePlayerOnce = stub;
  return fn().finally(() => { scraperModule.scrapePlayerOnce = original; });
}

test('scrapePlayer: a timeout on the first attempt is retried and succeeds on the second', async () => {
  let callCount = 0;
  const fakeResult = { totalPR: 500, thisSeasonPR: 120, prBand: 'Elite', recentEvents: [] };

  await withStubbedScrapeOnce(async (epicUsername, region, epicId) => {
    callCount++;
    if (callCount === 1) throw new Error('Navigation timeout of 30000 ms exceeded');
    assert.equal(epicUsername, 'TestPlayer');
    assert.equal(region, 'EU');
    return fakeResult;
  }, async () => {
    const result = await scraperModule.scrapePlayer('TestPlayer', 'EU', null);
    assert.equal(callCount, 2, 'should have retried exactly once after the first timeout');
    assert.deepEqual(result, fakeResult);
  });
});

test('scrapePlayer: succeeds on the third attempt after two failures (uses the full retry budget)', async () => {
  let callCount = 0;
  const fakeResult = { totalPR: 10, thisSeasonPR: 0, prBand: null, recentEvents: [] };

  await withStubbedScrapeOnce(async () => {
    callCount++;
    if (callCount < 3) throw new Error(`simulated failure #${callCount}`);
    return fakeResult;
  }, async () => {
    const result = await scraperModule.scrapePlayer('AnotherPlayer', 'NAC', 'epic123');
    assert.equal(callCount, 3);
    assert.deepEqual(result, fakeResult);
  });
});

test('scrapePlayer: gives up after exhausting all attempts and wraps the last error clearly', async () => {
  let callCount = 0;

  await withStubbedScrapeOnce(async () => {
    callCount++;
    throw new Error('Navigation timeout of 30000 ms exceeded');
  }, async () => {
    await assert.rejects(
      () => scraperModule.scrapePlayer('AlwaysFails', 'EU', null),
      err => {
        assert.match(err.message, /failed after 3 attempts/);
        assert.match(err.message, /Navigation timeout/);
        return true;
      }
    );
    assert.equal(callCount, 3, 'should have made exactly 3 attempts, no more');
  });
});
