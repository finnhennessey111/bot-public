// Verifies rate-limit.js's createRateLimiter in isolation — pure middleware logic against fake
// req/res objects, no real HTTP server needed (test/elo-endpoint.test.js separately covers it
// wired into the real /api/elo route via real HTTP requests).
const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../rate-limit');

function makeReq(ip) {
  return { ip };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { res.headers[name] = value; return res; },
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

test('createRateLimiter: allows requests under the cap, calls next() each time', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
  try {
    for (let i = 0; i < 5; i++) {
      let nextCalled = false;
      limiter(makeReq('1.2.3.4'), makeRes(), () => { nextCalled = true; });
      assert.equal(nextCalled, true, `request ${i + 1}/5 should be allowed`);
    }
  } finally {
    limiter.stopSweep();
  }
});

test('createRateLimiter: blocks the request that exceeds the cap with 429 and a Retry-After header', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
  try {
    for (let i = 0; i < 3; i++) limiter(makeReq('5.6.7.8'), makeRes(), () => {});

    const res = makeRes();
    let nextCalled = false;
    limiter(makeReq('5.6.7.8'), res, () => { nextCalled = true; });

    assert.equal(nextCalled, false, 'the 4th request within the window must not reach the route handler');
    assert.equal(res.statusCode, 429);
    assert.ok(res.body.error);
    assert.ok(res.headers['Retry-After'], 'must tell the client how long to wait');
  } finally {
    limiter.stopSweep();
  }
});

test('createRateLimiter: tracks each IP independently — one IP being limited never affects another', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  try {
    limiter(makeReq('1.1.1.1'), makeRes(), () => {});
    limiter(makeReq('1.1.1.1'), makeRes(), () => {});
    const blockedRes = makeRes();
    let blockedNext = false;
    limiter(makeReq('1.1.1.1'), blockedRes, () => { blockedNext = true; });
    assert.equal(blockedNext, false);
    assert.equal(blockedRes.statusCode, 429);

    // A different IP, still fresh, must not be affected by 1.1.1.1's exhausted quota.
    let otherNext = false;
    limiter(makeReq('2.2.2.2'), makeRes(), () => { otherNext = true; });
    assert.equal(otherNext, true);
  } finally {
    limiter.stopSweep();
  }
});

test('createRateLimiter: the window resets after it expires, allowing requests again', async () => {
  const limiter = createRateLimiter({ windowMs: 50, max: 1 });
  try {
    limiter(makeReq('9.9.9.9'), makeRes(), () => {});
    const blockedRes = makeRes();
    let blockedNext = false;
    limiter(makeReq('9.9.9.9'), blockedRes, () => { blockedNext = true; });
    assert.equal(blockedNext, false);
    assert.equal(blockedRes.statusCode, 429);

    await new Promise(resolve => setTimeout(resolve, 70)); // past the 50ms window

    let allowedAgain = false;
    limiter(makeReq('9.9.9.9'), makeRes(), () => { allowedAgain = true; });
    assert.equal(allowedAgain, true, 'a new window must allow requests again');
  } finally {
    limiter.stopSweep();
  }
});
