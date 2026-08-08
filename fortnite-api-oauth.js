// fortnite-api-oauth.js - Second, separate Epic-adjacent authorization: api-fortnite.com's own
// OAuth layer (a device-authorization-grant wrapper around Epic's OAuth), genuinely distinct from
// epic-oauth.js (Epic's OWN direct redirect-based OAuth, used for account linking — completely
// unchanged, completely independent of this file). Both ultimately authenticate against the same
// Epic Games account system, but via different client applications/flows, so a player authorizes
// each one separately. Used for open-ended tournament-history access (players.js), which — when a
// player has completed it — replaces the Fortnite-Tracker-scraped recentEvents for that player
// only; every other stat, and every player who hasn't done this, keep working exactly as before.
//
// REAL flow, confirmed live against the real API with a real FORTNITE_API_KEY (not assumed/
// guessed from docs — the docs UI itself, api-fortnite.com/docs and prod.api-fortnite.com/swagger,
// is Cloudflare-blocked to a plain fetch the same way fortnitetracker.com is; the raw OpenAPI spec
// at /swagger/v1/swagger.json is NOT blocked, and every shape below was cross-checked against real
// request/response pairs on top of that spec, including completing the flow twice with a real,
// currently-competitive Epic account):
//
//   1. GET /api/v1/oauth/get-token (x-api-key only) -> 200
//      { success, flowId, verificationUri, userCode, expiresIn: 600 }
//      verificationUri is a ready-to-click Epic activation link with userCode pre-filled
//      (https://www.epicgames.com/activate?userCode=XXXX). expiresIn (600s/10min) is how long
//      the FLOW stays open for the player to approve, not the resulting token's own lifetime.
//   2. Poll POST /api/v1/oauth/complete { flowId } every retryAfter seconds:
//      - 202 { success:false, code:"AUTHORIZATION_PENDING", retryAfter: 10 } while waiting
//      - 429 (RATE_LIMITED, per the API's own doc summary) if polled too fast — treated the same
//        as 202 here (back off and keep polling), not a hard failure.
//      - 400 { error:"Invalid or expired flow ID" } once the 10-minute window elapses unactioned
//      - 200 { success:true, accessToken, refreshToken, expiresIn: 7200 (2h — genuinely expires,
//        confirmed live), accountId, deviceAuth:{ deviceId, accountId, secret, created:{...} } }
//        once the player approves.
//   3. Two independent, both-confirmed-live refresh paths once the access token expires:
//      - POST /api/v1/oauth/refresh-token { refreshToken } -> 200 { success, accessToken,
//        refreshToken, tokenChanged, expiresIn, accountId }, or 401 { success:false,
//        code:"errors.com.epicgames.account.auth_token.invalid_refresh_token", error } if the
//        refresh token itself is invalid/expired.
//      - POST /api/v1/oauth/refresh-device { accountId, deviceId, secret } -> 200 { success,
//        accessToken, refreshToken, expiresIn, accountId } — Epic's own long-lived device-auth
//        credential (what a console/launcher uses to stay "logged in" indefinitely; the API's own
//        summary text calls this "re-authenticate silently ... no browser required"). This is the
//        real long-term mechanism: used whenever refresh-token itself fails, so a player should
//        essentially never need to redo the browser step, short of revoking device access from
//        their own Epic account settings.
//   4. GET /api/v2/events/players/{accountId}/history with BOTH `x-api-key` (still required
//      alongside the token — a request with only x-fortnite-token gets a flat 401 "API key
//      required", confirmed live) AND `x-fortnite-token: <accessToken>` (NOT
//      Authorization: Bearer) is the actual tournament-history data source.
//
// KNOWN GAP, confirmed live, not assumed: as of this writing GET /api/v2/events/players/
// {accountId}/history returns 404 for every account tested, INCLUDING a real player's own account
// with confirmed genuine tournament history (ruling out "no history" as the explanation) — and the
// two v1 alternatives (/api/v1/events/player/{accountId}/matches, /api/v1/events/player?
// accountId=...) both return 403 against that same real account, with or without region/platform
// query params. The token-issuance side above (steps 1-3) is fully confirmed working end-to-end
// with real tokens, refreshed both ways. Something about the data-fetch side (most likely a scope/
// entitlement gap in what this simplified device-auth flow grants — GET /oauth/get-token takes no
// `scope` parameter at all, unlike Epic's fuller OAuth) is not currently functional upstream.
// Shipped anyway, deliberately: fetchTournamentHistory below fails soft exactly like every other
// gap in this codebase (epic-api.js's fetchJson is the direct precedent) — returns null, logs
// once — which players.js already treats identically to "this player hasn't done this second
// authorization at all." If/when api-fortnite.com's history endpoint starts working, this starts
// serving real data automatically, zero further code changes, since every opted-in player's token
// is already being collected and kept fresh via steps 1-3.

const BASE_URL = 'https://prod.api-fortnite.com';

function isConfigured() {
  return !!process.env.FORTNITE_API_KEY;
}

// Low-level HTTP helper — every real caller below goes through module.exports.request (not a
// closed-over local reference), so a test can stub this ONE function and exercise every caller's
// actual status/shape branching logic without a real network round trip or a FORTNITE_API_KEY —
// same "delegates through module.exports" precedent as epic-api.js's fetchJson (GET-only there;
// this also carries method/body/extraHeaders since the OAuth endpoints below mix GET and POST, and
// fetchTournamentHistory needs an extra x-fortnite-token header on top of x-api-key).
//
// Returns { ok, status, data } for any real HTTP response, even a non-2xx one — every caller below
// branches on specific non-2xx statuses (401/400/404 all carry real information here) — or
// { ok: false, status: null, data: null, networkError: message } for "not configured" or a genuine
// network-level failure (DNS, connection refused, etc.). Never throws.
async function request(method, path, { body, extraHeaders } = {}) {
  if (!isConfigured()) {
    console.warn(`[fortnite-api-oauth] FORTNITE_API_KEY not set — skipping ${method} ${path}`);
    return { ok: false, status: null, data: null, networkError: 'FORTNITE_API_KEY not set' };
  }

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'x-api-key': process.env.FORTNITE_API_KEY,
        ...extraHeaders,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: null, data: null, networkError: err.message };
  }
}

// Step 1. Fails soft to null (never throws) on any problem — same contract as every other public
// function here — so a caller (index.js's button handler) can show a clean "try again shortly"
// message instead of an unhandled rejection.
async function startDeviceAuthFlow() {
  const { ok, status, data, networkError } = await module.exports.request('GET', '/api/v1/oauth/get-token');
  if (networkError) {
    console.warn(`[fortnite-api-oauth] get-token failed: ${networkError}`);
    return null;
  }
  if (!ok) {
    console.warn(`[fortnite-api-oauth] get-token -> HTTP ${status}`);
    return null;
  }
  if (!data?.success || !data.flowId || !data.verificationUri) {
    console.warn(`[fortnite-api-oauth] get-token returned an unexpected shape: ${JSON.stringify(data)}`);
    return null;
  }
  return { flowId: data.flowId, verificationUri: data.verificationUri, userCode: data.userCode ?? null, expiresIn: data.expiresIn ?? 600 };
}

// Step 2 (one poll attempt — the caller owns the retry/backoff loop, see index.js's
// pollFortniteApiAuthorization, so this stays a single HTTP call). Distinguishes 'pending' (keep
// polling), 'expired' (the 10-minute flow window elapsed — the player needs to restart from step
// 1), 'authorized' (done — real credentials attached), and 'error' (anything else) rather than
// collapsing them to null/truthy, since the caller's UI genuinely differs per case.
async function pollComplete(flowId) {
  const { status, data, networkError } = await module.exports.request('POST', '/api/v1/oauth/complete', { body: { flowId } });
  if (networkError) {
    console.warn(`[fortnite-api-oauth] complete failed: ${networkError}`);
    return { status: 'error', message: networkError };
  }

  // 429 (RATE_LIMITED) treated identically to 202 — a rate-limit blip should just widen the next
  // wait, not abandon the whole flow the player is actively waiting on.
  if (status === 202 || status === 429) {
    return { status: 'pending', retryAfter: data?.retryAfter ?? (status === 429 ? 20 : 10) };
  }
  if (status === 200 && data?.success && data.accessToken) {
    return {
      status: 'authorized',
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? null,
      expiresAt: new Date(Date.now() + (data.expiresIn ?? 7200) * 1000),
      accountId: data.accountId,
      deviceId: data.deviceAuth?.deviceId ?? null,
      deviceSecret: data.deviceAuth?.secret ?? null,
    };
  }
  if (status === 400) {
    console.log(`[fortnite-api-oauth] complete: flow ${flowId} invalid or expired`);
    return { status: 'expired' };
  }

  console.warn(`[fortnite-api-oauth] complete -> unexpected HTTP ${status}: ${JSON.stringify(data)}`);
  return { status: 'error', message: data?.error ?? `HTTP ${status}` };
}

// Shared shape-normalizer for both refresh paths below — both real endpoints return the identical
// { success, accessToken, refreshToken, expiresIn, accountId } shape on success (confirmed live);
// refresh-token additionally carries a tokenChanged flag neither caller needs.
function normalizeRefreshResponse(data) {
  return {
    status: 'ok',
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresAt: new Date(Date.now() + (data.expiresIn ?? 7200) * 1000),
    accountId: data.accountId,
  };
}

// Step 3a. 'invalid' specifically on a 401 (confirmed live shape: code
// "errors.com.epicgames.account.auth_token.invalid_refresh_token") — the caller (players.js) uses
// this to know it's worth trying refresh-device next, rather than treating every failure the same.
async function refreshWithToken(refreshToken) {
  if (!refreshToken) return { status: 'invalid' };

  const { status, data, networkError } = await module.exports.request('POST', '/api/v1/oauth/refresh-token', { body: { refreshToken } });
  if (networkError) {
    console.warn(`[fortnite-api-oauth] refresh-token failed: ${networkError}`);
    return { status: 'error', message: networkError };
  }
  if (status === 401) return { status: 'invalid' };
  if (status !== 200 || !data?.success || !data.accessToken) {
    console.warn(`[fortnite-api-oauth] refresh-token -> unexpected HTTP ${status}: ${JSON.stringify(data)}`);
    return { status: 'error', message: data?.error ?? `HTTP ${status}` };
  }
  return normalizeRefreshResponse(data);
}

// Step 3b — the real long-term mechanism (see this file's header comment). 'invalid' means the
// device auth itself has been revoked (e.g. the player removed it from their Epic account
// settings) — at that point players.js has no way to silently recover and must leave this player
// on the Fortnite Tracker path until they redo the whole flow from step 1.
async function refreshWithDevice({ accountId, deviceId, secret }) {
  if (!accountId || !deviceId || !secret) return { status: 'invalid' };

  const { status, data, networkError } = await module.exports.request('POST', '/api/v1/oauth/refresh-device', { body: { accountId, deviceId, secret } });
  if (networkError) {
    console.warn(`[fortnite-api-oauth] refresh-device failed: ${networkError}`);
    return { status: 'error', message: networkError };
  }
  if (status === 400 || status === 401) return { status: 'invalid' };
  if (status !== 200 || !data?.success || !data.accessToken) {
    console.warn(`[fortnite-api-oauth] refresh-device -> unexpected HTTP ${status}: ${JSON.stringify(data)}`);
    return { status: 'error', message: data?.error ?? `HTTP ${status}` };
  }
  return normalizeRefreshResponse(data);
}

// Step 4 — see this file's header comment for the confirmed-live 404/403 gap. Fails soft to null
// on absolutely any non-2xx/parse failure, same contract as epic-api.js's fetchJson, so
// players.js's caller can treat "no data from this path" identically whether the cause is today's
// upstream gap, a genuinely empty history, or a real network error — all equally "fall back to
// Fortnite Tracker for this player, this once."
async function fetchTournamentHistory(accountId, accessToken) {
  if (!accountId || !accessToken) return null;

  const { ok, status, data, networkError } = await module.exports.request(
    'GET', `/api/v2/events/players/${encodeURIComponent(accountId)}/history`, { extraHeaders: { 'x-fortnite-token': accessToken } }
  );
  if (networkError) {
    console.warn(`[fortnite-api-oauth] tournament history failed: ${networkError}`);
    return null;
  }
  if (!ok) {
    console.warn(`[fortnite-api-oauth] tournament history -> HTTP ${status} for account ${accountId}`);
    return null;
  }
  return data;
}

// Tolerant field-access, same precedent as epic-api.js's normalizeEventEntry — the exact shape of
// a POPULATED response is unconfirmed (see this file's header comment: every real account tested
// hit the 404/403 gap before a real example could be observed), so this accepts several plausible
// real-world field-name variants per attribute rather than assuming one. Only scraper.js's
// actually-consumed minimal contract is produced — name/date/placement/prPoints/rosterSize (see
// scraper.js's parseProfileData and tier-comparison.js's computeWindowStats, confirmed via a full-
// repo grep to be the only fields any real downstream consumer reads) — matches/wins/elims/kd are
// left at 0 always, since nothing reads them regardless of which source produced recentEvents.
//
// An entry with no usable numeric points value is dropped entirely rather than kept with a
// fabricated 0 — a fabricated 0 would be indistinguishable from a genuine "scored zero points"
// result and would corrupt tier-comparison.js's window-average; dropping it just means one fewer
// data point, same fail-soft posture as everything else here (one unparseable ENTRY doesn't
// invalidate the whole array).
function mapHistoryToRecentEvents(historyData) {
  const list = Array.isArray(historyData)
    ? historyData
    : (Array.isArray(historyData?.events) ? historyData.events
      : (Array.isArray(historyData?.history) ? historyData.history
        : (Array.isArray(historyData?.entries) ? historyData.entries : null)));

  if (!list) {
    if (historyData != null) {
      console.warn(`[fortnite-api-oauth] tournament history response did not match any expected array shape: ${JSON.stringify(historyData).slice(0, 300)}`);
    }
    return [];
  }

  const mapped = list.map(raw => {
    const prPoints = raw?.prPoints ?? raw?.pointsEarned ?? raw?.points ?? raw?.powerRankingPoints ?? null;
    if (typeof prPoints !== 'number') return null;

    return {
      name: raw.name ?? raw.eventName ?? raw.title ?? raw.displayName ?? null,
      date: raw.date ?? raw.beginTime ?? raw.endTime ?? raw.windowBeginTime ?? null,
      placement: typeof raw.placement === 'number' ? raw.placement : (typeof raw.rank === 'number' ? raw.rank : null),
      prPoints,
      rosterSize: typeof raw.rosterSize === 'number' ? raw.rosterSize : null,
      matches: 0, wins: 0, elims: 0, kd: 0, // never read downstream — see this function's doc comment
    };
  }).filter(Boolean);

  // Same newest-first + 20-cap convention as scraper.js's parseProfileData, for parity/consistency
  // regardless of which source produced this array.
  return mapped
    .sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0))
    .slice(0, 20);
}

module.exports = {
  isConfigured,
  request,
  startDeviceAuthFlow,
  pollComplete,
  refreshWithToken,
  refreshWithDevice,
  fetchTournamentHistory,
  mapHistoryToRecentEvents,
};
