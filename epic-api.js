// epic-api.js - Client for api-fortnite.com, an unofficial wrapper around Epic's own real
// competitive-tournament backend (NOT Fortnite Tracker). Three things this bot gets from Epic here:
//   1. Primary tournament-calendar discovery (tournament-scraper.js's scrapeEpicCalendar) — the
//      bandwidth/cost reduction this whole integration exists for, with Fortnite Tracker as a
//      genuine fallback only when Epic's own call fails outright.
//   2. A structural (id-string-based) build-mode/roster-size cross-check for tournament-scraper.js's
//      title-word detection (build-mode.js's detectBuildModeFromEpicId, roster-size.js's
//      detectRosterSizeFromEpicId).
//   3. A precise per-tournament placement lookup for scraper.js's ownTournamentModifier
//      (getEpicOwnTournamentModifier) — Epic's own recorded rank/points for a specific player in a
//      specific tournament window.
//
// REAL confirmed structure (live data, not guessed) for both /api/v1/events/global and
// /api/v1/events/global/history — the SAME shape for both, confirmed directly: a flat array of
// tournament objects, each shaped:
//   { id: "S41_PSTypicalGamer_ZB::s41_ps_typical_zb", name: "PlayStation Typical Gamer Icon Cup",
//     regions: {
//       EU: [{ eventId: "epicgames_S41_PSTypicalGamer_ZB_EU", beginTime, endTime,
//              regions: ["EU"], platforms: ["PS4","PS5"], eventWindows: [{...}, {...}], link }],
//       ME: [{ ... }], NAE: [{ ... }], NAC: [{ ...byte-identical to NAE... }], NAW: [{ ... }],
//       BR: [{ ... }],
//     } }
// Region is a direct object KEY on `regions` — not something to reverse-engineer from an
// eventWindowId suffix (an earlier version of this file did exactly that, based on an incomplete
// picture of the real shape, and silently returned zero results because of it — see
// getRegionEntry below). "BR" here is Brazil, a real Fortnite competitive region — entirely
// unrelated to Battle Royale build mode, which lives in the tournament's own name/id (presence/
// absence of "ZB"/"Reload"). Never conflate the two.
//
// regions.NAE and regions.NAC hold byte-identical content in every real example seen — confirmed
// live — so only NAC is ever read; NAE is simply never looked up, no fallback logic needed.
//
// Every public function here fails soft: any network error, non-2xx response, rate limit, or
// unexpected payload shape returns null (or the FT-derived fallback the caller already has),
// logged clearly, never thrown up into a queue-join or channel-creation path. This API has a real
// credit system on top of its rate limits, so every entry point is cached — see the TTL constants
// below for each cache's reasoning.

const BASE_URL = 'https://prod.api-fortnite.com';

// Calendar lists (global + history) change on the timescale of new tournaments being announced —
// hours, not minutes — but findEventEntryByName is called on every real tournament queue-join
// (queue.js's buildPlayer), a genuinely hot path. An hour keeps a brand-new tournament showing up
// same-day while bounding how often the whole list gets re-fetched regardless of how many players
// queue in that window.
const CALENDAR_CACHE_TTL_MS = 60 * 60 * 1000;

// A past eventWindow's recorded placement is immutable once the window has ended — there's nothing
// to gain from re-fetching it. This is intentionally long (not "forever") purely to bound the
// in-memory Map's lifetime growth across a long-running process, not because the data might change.
const MATCHES_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Minimal in-memory TTL cache — same "small hand-rolled utility over a dependency" precedent as
// rate-limit.js's createRateLimiter. One shared Map for both cache namespaces below (calendar
// global/history, per-window matches), disambiguated by key prefix.
// ---------------------------------------------------------------------------------------------
const cache = new Map(); // key -> { value, expiresAt }

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCached(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Sweeps expired entries periodically so the cache doesn't grow unbounded across every distinct
// (eventId, eventWindowId, accountId) combination ever looked up. unref() so this timer never
// keeps the process alive on its own — same pattern as rate-limit.js.
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}, CALENDAR_CACHE_TTL_MS).unref();

// ---------------------------------------------------------------------------------------------
// Low-level HTTP
// ---------------------------------------------------------------------------------------------

// Delegates through module.exports (not a direct local reference) so a test can stub this one
// function and exercise every real caller (findEventEntryByName, getPlayerEventMatches, etc.)
// without a real network round trip — same precedent as scraper.js's scrapePlayer/scrapePlayerOnce.
async function fetchJson(path) {
  const apiKey = process.env.FORTNITE_API_KEY;
  if (!apiKey) {
    console.warn(`[epic-api] FORTNITE_API_KEY not set — skipping ${path}`);
    return null;
  }

  try {
    const res = await fetch(`${BASE_URL}${path}`, { headers: { 'x-api-key': apiKey } });
    if (!res.ok) {
      console.warn(`[epic-api] ${path} -> HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[epic-api] ${path} failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Calendar discovery (upcoming + history)
// ---------------------------------------------------------------------------------------------

// The outer shape (a bare array) is confirmed live for /global — the `data?.events` fallback below
// is kept as a defensive secondary check in case /global/history's own wrapper ever genuinely
// diverges (not independently re-confirmed against this exact nested-regions shape at the time of
// writing), never as the primary assumption.
async function fetchGlobalEvents() {
  const cached = getCached('global');
  if (cached !== undefined) return cached;

  const data = await module.exports.fetchJson('/api/v1/events/global');
  const list = Array.isArray(data) ? data : (Array.isArray(data?.events) ? data.events : null);
  if (list) setCached('global', list, CALENDAR_CACHE_TTL_MS);
  return list;
}

async function fetchGlobalEventsHistory() {
  const cached = getCached('history');
  if (cached !== undefined) return cached;

  const data = await module.exports.fetchJson('/api/v1/events/global/history');
  const list = Array.isArray(data) ? data : (Array.isArray(data?.events) ? data.events : null);
  if (list) setCached('history', list, CALENDAR_CACHE_TTL_MS);
  return list;
}

// Tolerant field access on id/name only (a slightly different real key, e.g. `title` instead of
// `name`, still works) — but `regions` is read as the confirmed real structural field, not guessed
// at with fallback names, since its exact shape (an object keyed by region code) is what
// getRegionEntry below depends on.
function normalizeEventEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id ?? raw.eventId ?? raw.templateId ?? null;
  const name = raw.name ?? raw.title ?? raw.displayName ?? null;
  const regions = (raw.regions && typeof raw.regions === 'object' && !Array.isArray(raw.regions)) ? raw.regions : {};
  if (!id || !name) return null;
  return { id, name, regions, raw };
}

function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase();
}

// Direct region-keyed lookup — region is a real structural key on the confirmed payload
// (entry.regions.EU / .NAC / .ME), each holding an array (every real example seen has exactly one
// element) of a fully region-scoped tournament entry: its own real eventId, beginTime/endTime,
// platforms, and eventWindows (the actual round-by-round schedule, e.g. Qualifier/Final). No
// suffix-parsing needed — region membership is never ambiguous. Returns null when this tournament
// simply isn't offered in the requested region (a normal, expected case — not an error).
function getRegionEntry(entry, region) {
  const bucket = entry?.regions?.[region];
  if (!Array.isArray(bucket) || bucket.length === 0) return null;
  return bucket[0];
}

// Searches the upcoming list first, then history — mirrors why the task asked for both endpoints
// (global for a live/upcoming tournament, history for resolving a recurring tournament's identity
// even once its current window has passed). Exact case-insensitive name match only: Fortnite
// Tracker's own tournament names are what this gets called with (tournament.name), and Epic's
// display names matched those exactly in every real example seen — a fuzzy/substring match risks
// picking the wrong one of two similarly-named tournaments (e.g. "Duos Ranked Cup (Battle Royale)"
// vs "Duos Ranked Cup (Zero Build)").
async function findEventEntryByName(name) {
  const target = normalizeName(name);
  if (!target) return null;

  const upcoming = await module.exports.fetchGlobalEvents();
  const fromUpcoming = upcoming?.map(normalizeEventEntry).find(e => e && normalizeName(e.name) === target);
  if (fromUpcoming) return fromUpcoming;

  const history = await module.exports.fetchGlobalEventsHistory();
  const fromHistory = history?.map(normalizeEventEntry).find(e => e && normalizeName(e.name) === target);
  return fromHistory ?? null;
}

// Real console platform codes confirmed live ("PS4","PS5" — "PlayStation Typical Gamer Icon Cup").
// Xbox/Switch codes are inferred from the same naming convention (not independently confirmed live
// yet) but are low-risk: this set is only ever used to recognize an OBVIOUS all-console platforms
// array, never to assert PC-inclusion from an absence, so an unrecognized code just falls through
// to detectConsoleOnlyFromEpic's keyword-heuristic fallback (tournament-scraper.js) rather than
// guessing wrong.
const KNOWN_CONSOLE_PLATFORM_CODES = new Set(['PS4', 'PS5', 'XSX', 'XB1', 'SWITCH', 'CONSOLE']);
const KNOWN_PC_PLATFORM_CODES = new Set(['PC', 'KBM', 'WIN', 'WINDOWS']);

// true/false when platforms is present and every code is one this module recognizes (definitive
// either way); null when platforms is missing/empty or contains anything unrecognized — signals
// "no confident answer from this field," letting the caller fall back to its own heuristic instead
// of risking a wrong guess on an unfamiliar platform code.
function consoleOnlyFromPlatforms(platforms) {
  if (!Array.isArray(platforms) || platforms.length === 0) return null;
  const codes = platforms.map(p => String(p).toUpperCase());
  if (codes.some(c => KNOWN_PC_PLATFORM_CODES.has(c))) return false;
  if (codes.every(c => KNOWN_CONSOLE_PLATFORM_CODES.has(c))) return true;
  return null; // at least one unrecognized, non-PC code — not confident enough to call it either way
}

// ---------------------------------------------------------------------------------------------
// Per-tournament, per-player placement lookup
// ---------------------------------------------------------------------------------------------

// The v1 (scanning, rankHint-tolerant) endpoint, NOT v2 — confirmed live during manual testing
// that v2's exact-match endpoint (/api/v2/events/{eventId}/windows/{eventWindowId}/players/
// {accountId}) fails with "No standing found" against the same real data v1 succeeds on.
async function getPlayerEventMatches(eventId, eventWindowId, accountId, rankHint = null) {
  if (!eventId || !eventWindowId || !accountId) return null;

  const cacheKey = `matches:${eventId}:${eventWindowId}:${accountId}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const qs = rankHint != null ? `?rankHint=${encodeURIComponent(rankHint)}` : '';
  const path = `/api/v1/events/${encodeURIComponent(eventId)}/${encodeURIComponent(eventWindowId)}/player/${encodeURIComponent(accountId)}/matches${qs}`;
  const data = await module.exports.fetchJson(path);

  if (!data?.found) {
    // Cache a genuine "not found" result too (still real signal, not a fetch failure) — a player
    // with no recorded standing in this specific window won't suddenly gain one on a re-check
    // within this window's already-past timeframe.
    if (data && data.found === false) setCached(cacheKey, null, MATCHES_CACHE_TTL_MS);
    return null;
  }

  setCached(cacheKey, data, MATCHES_CACHE_TTL_MS);
  return data;
}

// Returns eventWindows (from a single already-region-scoped regionEntry — see getRegionEntry)
// whose endTime has already passed, most-recent-first, capped at `limit`. Region-agnostic on
// purpose: by the time this runs, the caller has already narrowed to one region's own eventWindows,
// which (per the confirmed real structure) never mix in other regions' windows.
function pickPastEventWindows(eventWindows, limit) {
  const now = Date.now();
  return (eventWindows ?? [])
    .filter(w => w.endTime && new Date(w.endTime).getTime() < now)
    .sort((a, b) => new Date(b.endTime) - new Date(a.endTime))
    .slice(0, limit);
}

// Same shape/weight as scraper.js's computeOwnTournamentModifier (up to 3 most recent matching
// windows, 0.30 weight) — PR-native now, matching that function's own formula shape: each matched
// window's real pointsEarned (Epic's own per-window PR points, the direct analog of Fortnite
// Tracker's prPoints) is averaged and expressed as a fraction of currentPR, not converted through a
// 0-100 placement-bucket score. currentPR must be > 0 to express a percentage against — mirrors
// computeOwnTournamentModifier's own currentPR <= 0 guard, same "no signal, never a penalty" shape.
//
// tournament only needs { name, region } — NOT eventId. The real per-region eventId is resolved
// fresh from Epic's own calendar right here (getRegionEntry(entry, tournament.region).eventId),
// rather than trusting whatever tournament.eventId happens to be — that field means different
// things depending on which discovery path produced it (a real Fortnite-Tracker-scraped id, or
// tournament-scraper.js's own bookkeeping value), and re-resolving it from Epic directly makes this
// function correct regardless of that history, with no dependency on the caller having threaded the
// right value through.
//
// Returns null on absolutely any gap (no calendar match, no eligible past window for this region,
// no player standing found, currentPR <= 0) — callers fall back to the existing Fortnite
// Tracker-derived modifier whenever this returns null, exactly the same as any other fetch failure
// here.
async function getEpicOwnTournamentModifier(tournament, accountId, currentPR) {
  if (!tournament?.name || !tournament?.region || !accountId || !(currentPR > 0)) return null;

  const entry = await module.exports.findEventEntryByName(tournament.name);
  if (!entry) {
    console.log(`[epic-api] no calendar match for "${tournament.name}" — falling back to Fortnite Tracker history`);
    return null;
  }

  const regionEntry = getRegionEntry(entry, tournament.region);
  if (!regionEntry?.eventId) {
    console.log(`[epic-api] "${tournament.name}" has no ${tournament.region} entry (or no eventId on it) — falling back to Fortnite Tracker history`);
    return null;
  }

  const windows = pickPastEventWindows(regionEntry.eventWindows, 3);
  if (windows.length === 0) {
    console.log(`[epic-api] no past window found for "${tournament.name}" (${tournament.region}) — falling back to Fortnite Tracker history`);
    return null;
  }

  const results = await Promise.all(
    windows.map(w => module.exports.getPlayerEventMatches(regionEntry.eventId, w.eventWindowId, accountId))
  );
  const found = results.filter(r => r?.found && typeof r.pointsEarned === 'number');
  if (found.length === 0) return null;

  const avgPointsEarned = found.reduce((sum, r) => sum + r.pointsEarned, 0) / found.length;
  const modifier = (avgPointsEarned / currentPR) * 0.30;
  console.log(`[epic-api] own-tournament modifier for "${tournament.name}" served from Epic (${found.length} window(s))`);

  return {
    modifier,
    hasHistory: true,
    source: 'epic',
    matchedWindows: found.map(r => ({ eventWindowId: r.eventWindowId, rank: r.rank, pointsEarned: r.pointsEarned })),
  };
}

module.exports = {
  fetchJson,
  fetchGlobalEvents,
  fetchGlobalEventsHistory,
  findEventEntryByName,
  normalizeEventEntry,
  getRegionEntry,
  consoleOnlyFromPlatforms,
  getPlayerEventMatches,
  getEpicOwnTournamentModifier,
  // Test-only escape hatch — same precedent as rate-limit.js's middleware.stopSweep. The calendar/
  // matches cache above is module-level and long-TTL by design (that's the whole point in
  // production), which means it needs to be clearable between tests that stub different fetchJson
  // responses for the same '/api/v1/events/global' etc. paths — without this, a later test would
  // silently see an earlier test's cached result instead of exercising its own stub.
  __resetCacheForTests: () => cache.clear(),
};
