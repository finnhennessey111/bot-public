// epic-api.js - Client for api-fortnite.com, an unofficial wrapper around Epic's own real
// competitive-tournament backend (NOT Fortnite Tracker). Two things this bot actually gets from
// Epic here that Fortnite Tracker can't provide as well:
//   1. A structural (id-string-based) build-mode cross-check for tournament-scraper.js's existing
//      title-word detection (build-mode.js's detectBuildModeFromEpicId).
//   2. A more precise per-tournament placement lookup for scraper.js's ownTournamentModifier
//      (getEpicOwnTournamentModifier) — Epic's own recorded rank/points for a specific player in a
//      specific tournament window, instead of scanning Fortnite Tracker's capped 20-event
//      recentEvents history for a name match.
//
// Fortnite Tracker stays the PRIMARY tournament-calendar source (region/consoleOnly/rosterSize all
// come from real, already-confirmed FT fields — see tournament-scraper.js). Real Epic payloads
// (pasted from live manual testing, not guessed) have no region/platform field on an event window
// at all — only an eventWindowId whose trailing suffix happens to encode region (all three of this
// bot's supported regions are now confirmed live: "EU", "BR" — Brazil, not Battle Royale — and
// "NAC", e.g. "S41_MobileTestCup_Round1_NAC" — see REGION_SUFFIX_CANDIDATES below). Region-code
// uncertainty is no longer why Epic isn't primary — it's the missing consoleOnly/rosterSize fields
// on Epic's own payload, which FT still uniquely provides. Epic is used here purely as an
// enrichment/cross-check on top of FT's already-correct discovery, never as something whose
// failure or gap can make a real tournament disappear.
//
// Every public function here fails soft: any network error, non-2xx response, rate limit, or
// unexpected payload shape returns null (or the FT-derived fallback the caller already has),
// logged clearly, never thrown up into a queue-join or channel-creation path. This API has a real
// credit system on top of its rate limits, so every entry point is cached — see CACHE_TTL_MS below
// for each cache's reasoning.

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
// rate-limit.js's createRateLimiter. One shared Map for all three cache namespaces below (calendar
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

// The exact JSON key names for the list-view payload weren't confirmed byte-for-byte (the real
// example pasted from manual testing was reformatted for readability, not raw JSON) — only that
// each entry carries an id-like field, a display name, and (per the one full raw entry that WAS
// confirmed) a nested per-window array. Tolerant field access here means a slightly different real
// key name (e.g. `title` instead of `name`) still works instead of silently matching nothing.
function normalizeEventEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id ?? raw.eventId ?? raw.templateId ?? null;
  const name = raw.name ?? raw.title ?? raw.displayName ?? null;
  const eventWindows = raw.eventWindows ?? raw.windows ?? [];
  if (!id || !name) return null;
  return { id, name, eventWindows, raw };
}

function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase();
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

// Real Epic region codes confirmed live in this session's manual testing: "EU" (e.g.
// "S41_FNCSDivisionalCup_Division3_Event8_2_EU"), "BR" (Brazil — a real Fortnite competitive
// region, not Battle Royale; "S41_RankedCupDuosZB_Event7_BR"), and "NAC"
// ("S41_MobileTestCup_Round1_NAC") — all three of this bot's supported regions now have a real
// confirmed suffix, no guessed fallback needed for any of them. This is only ever used to pick
// which of an already-name-matched event's windows to use for enrichment (build-mode cross-check,
// placement lookup) — never to decide whether a tournament exists at all (that's still entirely
// Fortnite Tracker's job), so a wrong/missing mapping here just means that one enrichment quietly
// falls back to the existing FT-only behavior, not a disappearing tournament.
const REGION_SUFFIX_CANDIDATES = {
  EU: ['EU'],
  NAC: ['NAC'],
  ME: ['ME'],
};

// eventWindowId (or, if absent, link.code) trailing token — both confirmed real examples end in a
// region code with no other separator convention observed ("S41_RankedCupDuosZB_Event7_BR",
// "S41_FNCSDivisionalCup_Division3_Event8_2_EU").
function windowRegionSuffix(window) {
  const idLike = window?.eventWindowId ?? window?.link?.code ?? '';
  const parts = String(idLike).split('_');
  return parts.length ? parts[parts.length - 1].toUpperCase() : null;
}

// Returns eventWindows matching `region` (via REGION_SUFFIX_CANDIDATES), most-recent-first by
// endTime. onlyPast restricts to windows that have already concluded (endTime in the past) — what
// getEpicOwnTournamentModifier wants, since a player's OWN history can only come from tournaments
// they've already played.
function pickEventWindowsForRegion(eventWindows, region, { onlyPast = false } = {}) {
  const candidates = REGION_SUFFIX_CANDIDATES[region] ?? [region];
  const now = Date.now();

  return (eventWindows ?? [])
    .filter(w => candidates.includes(windowRegionSuffix(w)))
    .filter(w => !onlyPast || (w.endTime && new Date(w.endTime).getTime() < now))
    .sort((a, b) => new Date(b.endTime ?? 0) - new Date(a.endTime ?? 0));
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

// Same shape/weight as scraper.js's computeOwnTournamentModifier (up to 3 most recent matching
// events, averaged placement score, /100 scale, 0.30 weight) — deliberately unchanged, since only
// the DATA SOURCE is being upgraded here, not the scoring formula itself. tournament needs eventId
// (Fortnite Tracker's own scraped identifier, tournament-scraper.js's session.eventId — confirmed
// live to be the exact same real Epic eventId format the matches endpoint expects, e.g.
// "epicgames_S41_FNCSDivisionalCup_Division3_EU") and region (one of SUPPORTED_REGIONS). Returns
// null on absolutely any gap (no eventId, no calendar match, no eligible past window, no player
// standing found) — callers fall back to the existing Fortnite Tracker-derived modifier whenever
// this returns null, exactly the same as any other fetch failure here.
async function getEpicOwnTournamentModifier(tournament, accountId, { getPlacementScore } = {}) {
  if (!tournament?.eventId || !tournament?.name || !tournament?.region || !accountId) return null;

  const entry = await module.exports.findEventEntryByName(tournament.name);
  if (!entry) {
    console.log(`[epic-api] no calendar match for "${tournament.name}" — falling back to Fortnite Tracker history`);
    return null;
  }

  const windows = pickEventWindowsForRegion(entry.eventWindows, tournament.region, { onlyPast: true }).slice(0, 3);
  if (windows.length === 0) {
    console.log(`[epic-api] no past ${tournament.region} window found for "${tournament.name}" — falling back to Fortnite Tracker history`);
    return null;
  }

  const results = await Promise.all(
    windows.map(w => module.exports.getPlayerEventMatches(tournament.eventId, w.eventWindowId, accountId))
  );
  const found = results.filter(r => r?.found && typeof r.rank === 'number');
  if (found.length === 0) return null;

  const modifier = (found.reduce((sum, r) => sum + getPlacementScore(r.rank), 0) / found.length / 100) * 0.30;
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
  pickEventWindowsForRegion,
  getPlayerEventMatches,
  getEpicOwnTournamentModifier,
  normalizeEventEntry,
  windowRegionSuffix,
  REGION_SUFFIX_CANDIDATES,
  // Test-only escape hatch — same precedent as rate-limit.js's middleware.stopSweep. The calendar/
  // matches cache above is module-level and long-TTL by design (that's the whole point in
  // production), which means it needs to be clearable between tests that stub different fetchJson
  // responses for the same '/api/v1/events/global' etc. paths — without this, a later test would
  // silently see an earlier test's cached result instead of exercising its own stub.
  __resetCacheForTests: () => cache.clear(),
};
