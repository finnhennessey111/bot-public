// Verifies fortnite-api-oauth.js's own branching logic against the REAL response shapes confirmed
// live this session (see that file's header comment for the full confirmed flow — a real device-
// auth flow was started and completed twice with real Epic accounts, both refresh paths were
// exercised live, and every error shape below was reproduced against the real API with a real
// FORTNITE_API_KEY). request (the shared HTTP call) is stubbed throughout (module.exports
// delegation, same precedent as epic-api.js's fetchJson — see test/epic-api.test.js) so every test
// here runs with no real network round trip and no FORTNITE_API_KEY required.
const test = require('node:test');
const assert = require('node:assert/strict');

const fortniteApiOAuth = require('../fortnite-api-oauth');

function withStubbedRequest(impl, fn) {
  const original = fortniteApiOAuth.request;
  const calls = [];
  fortniteApiOAuth.request = async (method, path, opts) => {
    calls.push({ method, path, opts });
    return impl(method, path, opts);
  };
  return Promise.resolve(fn(calls)).finally(() => { fortniteApiOAuth.request = original; });
}

// ── isConfigured / request's own "not configured" path ────────────────────────
test('isConfigured: false when FORTNITE_API_KEY is unset, true when set', () => {
  const original = process.env.FORTNITE_API_KEY;
  try {
    delete process.env.FORTNITE_API_KEY;
    assert.equal(fortniteApiOAuth.isConfigured(), false);
    process.env.FORTNITE_API_KEY = 'some-real-key';
    assert.equal(fortniteApiOAuth.isConfigured(), true);
  } finally {
    if (original === undefined) delete process.env.FORTNITE_API_KEY; else process.env.FORTNITE_API_KEY = original;
  }
});

test('request: not configured returns a networkError, never throws, and never calls fetch', async () => {
  const original = process.env.FORTNITE_API_KEY;
  try {
    delete process.env.FORTNITE_API_KEY;
    const result = await fortniteApiOAuth.request('GET', '/api/v1/oauth/get-token');
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.ok(result.networkError);
  } finally {
    if (original === undefined) delete process.env.FORTNITE_API_KEY; else process.env.FORTNITE_API_KEY = original;
  }
});

// ── startDeviceAuthFlow — real confirmed shape: {success,flowId,verificationUri,userCode,expiresIn:600} ──
test('startDeviceAuthFlow: real confirmed success shape is parsed correctly', async () => {
  await withStubbedRequest(
    () => ({ ok: true, status: 200, data: { success: true, flowId: 'flow-1', verificationUri: 'https://www.epicgames.com/activate?userCode=ABCD1234', userCode: 'ABCD1234', expiresIn: 600 } }),
    async () => {
      const flow = await fortniteApiOAuth.startDeviceAuthFlow();
      assert.deepEqual(flow, { flowId: 'flow-1', verificationUri: 'https://www.epicgames.com/activate?userCode=ABCD1234', userCode: 'ABCD1234', expiresIn: 600 });
    }
  );
});

test('startDeviceAuthFlow: an unexpected/malformed success body fails soft to null, never throws', async () => {
  await withStubbedRequest(
    () => ({ ok: true, status: 200, data: { success: true } }), // missing flowId/verificationUri
    async () => {
      assert.equal(await fortniteApiOAuth.startDeviceAuthFlow(), null);
    }
  );
});

test('startDeviceAuthFlow: a network-level failure fails soft to null', async () => {
  await withStubbedRequest(
    () => ({ ok: false, status: null, data: null, networkError: 'ECONNREFUSED' }),
    async () => {
      assert.equal(await fortniteApiOAuth.startDeviceAuthFlow(), null);
    }
  );
});

// ── pollComplete — real confirmed shapes: 202 pending, 429 rate-limited, 400 expired, 200 authorized ──
test('pollComplete: 202 AUTHORIZATION_PENDING -> pending, with the real retryAfter', async () => {
  await withStubbedRequest(
    () => ({ ok: false, status: 202, data: { success: false, code: 'AUTHORIZATION_PENDING', retryAfter: 10 } }),
    async () => {
      assert.deepEqual(await fortniteApiOAuth.pollComplete('flow-1'), { status: 'pending', retryAfter: 10 });
    }
  );
});

test('pollComplete: 429 rate-limited is treated the same as pending, not as a hard failure', async () => {
  await withStubbedRequest(
    () => ({ ok: false, status: 429, data: null }),
    async () => {
      const result = await fortniteApiOAuth.pollComplete('flow-1');
      assert.equal(result.status, 'pending');
      assert.ok(result.retryAfter >= 10);
    }
  );
});

test('pollComplete: 400 invalid/expired flow -> expired', async () => {
  await withStubbedRequest(
    () => ({ ok: false, status: 400, data: { error: 'Invalid or expired flow ID' } }),
    async () => {
      assert.deepEqual(await fortniteApiOAuth.pollComplete('flow-1'), { status: 'expired' });
    }
  );
});

test('pollComplete: real confirmed 200 authorized shape, including the deviceAuth triple, is parsed correctly', async () => {
  const before = Date.now();
  await withStubbedRequest(
    () => ({
      ok: true, status: 200,
      data: {
        success: true, accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200, accountId: 'acct-1',
        deviceAuth: { deviceId: 'dev-1', accountId: 'acct-1', secret: 'sec-1', created: { location: 'Switzerland' } },
      },
    }),
    async () => {
      const result = await fortniteApiOAuth.pollComplete('flow-1');
      assert.equal(result.status, 'authorized');
      assert.equal(result.accessToken, 'at-1');
      assert.equal(result.refreshToken, 'rt-1');
      assert.equal(result.accountId, 'acct-1');
      assert.equal(result.deviceId, 'dev-1');
      assert.equal(result.deviceSecret, 'sec-1');
      assert.ok(result.expiresAt instanceof Date);
      // 7200s (2h) from now, confirmed live — allow a small margin for test execution time.
      assert.ok(result.expiresAt.getTime() >= before + 7200_000 - 1000);
      assert.ok(result.expiresAt.getTime() <= Date.now() + 7200_000 + 1000);
    }
  );
});

// ── refreshWithToken — real confirmed shapes: 200 ok, 401 invalid_refresh_token ────────────────
test('refreshWithToken: real confirmed 200 success shape', async () => {
  await withStubbedRequest(
    () => ({ ok: true, status: 200, data: { success: true, accessToken: 'at-2', refreshToken: 'rt-2', tokenChanged: false, expiresIn: 7200, accountId: 'acct-1' } }),
    async () => {
      const result = await fortniteApiOAuth.refreshWithToken('rt-1');
      assert.equal(result.status, 'ok');
      assert.equal(result.accessToken, 'at-2');
      assert.equal(result.refreshToken, 'rt-2');
      assert.equal(result.accountId, 'acct-1');
    }
  );
});

test('refreshWithToken: real confirmed 401 invalid_refresh_token shape -> invalid', async () => {
  await withStubbedRequest(
    () => ({ ok: false, status: 401, data: { success: false, code: 'errors.com.epicgames.account.auth_token.invalid_refresh_token', error: 'invalid' } }),
    async () => {
      assert.deepEqual(await fortniteApiOAuth.refreshWithToken('garbage'), { status: 'invalid' });
    }
  );
});

test('refreshWithToken: no refresh token at all -> invalid, without even calling request', async () => {
  await withStubbedRequest(
    () => { throw new Error('must not be called'); },
    async (calls) => {
      assert.deepEqual(await fortniteApiOAuth.refreshWithToken(null), { status: 'invalid' });
      assert.equal(calls.length, 0);
    }
  );
});

// ── refreshWithDevice — real confirmed shapes: 200 ok, 400 invalid device auth ──────────────────
test('refreshWithDevice: real confirmed 200 success shape (fresh tokens, no deviceAuth re-issued)', async () => {
  await withStubbedRequest(
    () => ({ ok: true, status: 200, data: { success: true, accessToken: 'at-3', refreshToken: 'rt-3', expiresIn: 7200, accountId: 'acct-1' } }),
    async () => {
      const result = await fortniteApiOAuth.refreshWithDevice({ accountId: 'acct-1', deviceId: 'dev-1', secret: 'sec-1' });
      assert.equal(result.status, 'ok');
      assert.equal(result.accessToken, 'at-3');
    }
  );
});

test('refreshWithDevice: real confirmed 400 (garbage device auth) -> invalid', async () => {
  await withStubbedRequest(
    () => ({ ok: false, status: 400, data: { status: 400, error: 'Upstream API error: Response status code does not indicate success: 400 (Bad Request).' } }),
    async () => {
      assert.deepEqual(await fortniteApiOAuth.refreshWithDevice({ accountId: 'x', deviceId: 'y', secret: 'z' }), { status: 'invalid' });
    }
  );
});

test('refreshWithDevice: missing any of accountId/deviceId/secret -> invalid without calling request', async () => {
  await withStubbedRequest(
    () => { throw new Error('must not be called'); },
    async (calls) => {
      assert.deepEqual(await fortniteApiOAuth.refreshWithDevice({ accountId: 'a', deviceId: null, secret: 's' }), { status: 'invalid' });
      assert.equal(calls.length, 0);
    }
  );
});

// ── fetchTournamentHistory — real confirmed gap: 404 for every account tested ───────────────────
test('fetchTournamentHistory: real confirmed 404 gap fails soft to null, uses the x-fortnite-token header (not Authorization)', async () => {
  await withStubbedRequest(
    (method, path, opts) => {
      assert.equal(method, 'GET');
      assert.equal(path, '/api/v2/events/players/acct-1/history');
      assert.deepEqual(opts.extraHeaders, { 'x-fortnite-token': 'at-1' });
      return { ok: false, status: 404, data: { status: 404, error: 'Upstream API error: Response status code does not indicate success: 404 (Not Found).' } };
    },
    async () => {
      assert.equal(await fortniteApiOAuth.fetchTournamentHistory('acct-1', 'at-1'), null);
    }
  );
});

test('fetchTournamentHistory: a genuinely populated success response passes through as-is', async () => {
  const body = { events: [{ prPoints: 50 }] };
  await withStubbedRequest(
    () => ({ ok: true, status: 200, data: body }),
    async () => {
      assert.deepEqual(await fortniteApiOAuth.fetchTournamentHistory('acct-1', 'at-1'), body);
    }
  );
});

test('fetchTournamentHistory: missing accountId/accessToken -> null without calling request', async () => {
  await withStubbedRequest(
    () => { throw new Error('must not be called'); },
    async (calls) => {
      assert.equal(await fortniteApiOAuth.fetchTournamentHistory(null, 'at-1'), null);
      assert.equal(await fortniteApiOAuth.fetchTournamentHistory('acct-1', null), null);
      assert.equal(calls.length, 0);
    }
  );
});

// ── mapHistoryToRecentEvents — pure function, no stubbing needed ────────────────────────────────
test('mapHistoryToRecentEvents: a bare array of entries with real-looking field names maps correctly', () => {
  const mapped = fortniteApiOAuth.mapHistoryToRecentEvents([
    { name: 'Cash Cup', date: '2026-08-01T00:00:00Z', placement: 5, prPoints: 42, rosterSize: 1 },
    { name: 'FNCS Major 1', date: '2026-07-01T00:00:00Z', placement: 12, prPoints: 30, rosterSize: 3 },
  ]);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].name, 'Cash Cup', 'newest-first');
  assert.equal(mapped[0].prPoints, 42);
  assert.equal(mapped[1].prPoints, 30);
});

test('mapHistoryToRecentEvents: tolerant of alternate real-world field names (pointsEarned/rank/eventName)', () => {
  const mapped = fortniteApiOAuth.mapHistoryToRecentEvents([
    { eventName: 'Ranked Cup', endTime: '2026-08-01T00:00:00Z', rank: 3, pointsEarned: 99 },
  ]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].name, 'Ranked Cup');
  assert.equal(mapped[0].placement, 3);
  assert.equal(mapped[0].prPoints, 99);
});

test('mapHistoryToRecentEvents: an entry with no usable numeric points value is dropped, not defaulted to 0', () => {
  const mapped = fortniteApiOAuth.mapHistoryToRecentEvents([
    { name: 'No Points Field', date: '2026-08-01T00:00:00Z' },
    { name: 'Has Points', date: '2026-08-02T00:00:00Z', prPoints: 10 },
  ]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].name, 'Has Points');
});

test('mapHistoryToRecentEvents: accepts a wrapped {events:[...]} / {history:[...]} / {entries:[...]} shape, not just a bare array', () => {
  assert.equal(fortniteApiOAuth.mapHistoryToRecentEvents({ events: [{ prPoints: 5 }] }).length, 1);
  assert.equal(fortniteApiOAuth.mapHistoryToRecentEvents({ history: [{ prPoints: 5 }] }).length, 1);
  assert.equal(fortniteApiOAuth.mapHistoryToRecentEvents({ entries: [{ prPoints: 5 }] }).length, 1);
});

test('mapHistoryToRecentEvents: an unrecognized shape returns an empty array, never throws', () => {
  assert.deepEqual(fortniteApiOAuth.mapHistoryToRecentEvents({ somethingElse: true }), []);
  assert.deepEqual(fortniteApiOAuth.mapHistoryToRecentEvents(null), []);
  assert.deepEqual(fortniteApiOAuth.mapHistoryToRecentEvents(undefined), []);
});

test('mapHistoryToRecentEvents: sorted newest-first and capped at 20, same convention as scraper.js', () => {
  const raw = Array.from({ length: 25 }, (_, i) => ({
    name: `Event ${i}`, date: new Date(Date.now() - i * 86400000).toISOString(), prPoints: i,
  }));
  const mapped = fortniteApiOAuth.mapHistoryToRecentEvents(raw);
  assert.equal(mapped.length, 20);
  assert.equal(mapped[0].name, 'Event 0', 'most recent (smallest date offset) first');
  assert.equal(mapped[19].name, 'Event 19');
});

test('mapHistoryToRecentEvents: matches/wins/elims/kd are always 0 — never read downstream, but always present and numeric', () => {
  const mapped = fortniteApiOAuth.mapHistoryToRecentEvents([{ name: 'X', date: '2026-08-01', prPoints: 1 }]);
  assert.deepEqual({ matches: mapped[0].matches, wins: mapped[0].wins, elims: mapped[0].elims, kd: mapped[0].kd }, { matches: 0, wins: 0, elims: 0, kd: 0 });
});
