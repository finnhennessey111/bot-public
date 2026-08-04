const puppeteer = require('puppeteer');
const config = require('./config');
const { proxyLaunchArgs, authenticatePage, blockUnnecessaryResources, logProxyMode, withBrowserSlot, closeBrowserSafely } = require('./proxy-config');
const { resolveRosterSize, inferRosterSize, detectRosterSizeFromEpicId } = require('./roster-size');
const { detectBuildMode, detectBuildModeFromEpicId } = require('./build-mode');
const epicApi = require('./epic-api');

logProxyMode('tournament-scraper');

// Skip these entirely when creating queue channels (scrapeUpcomingTournaments) — this (plus the
// separate restricted-FNCS-stage compound checks below, isFncsFinals/isFncsHeats) is the single
// source of truth for tournament channel eligibility. channel-manager.js has no whitelist of its
// own — anything that survives this filter gets a channel, including ranked cups, skin/creator
// cups (Mongraal Cup, Clix Cup, etc.), victory cups, cash cups, reload cups, and FNCS divisions
// (which additionally get a permanent, always-open channel — see PERMANENT_KEYWORDS below).
const BLOCKED_KEYWORDS = [
  'mobile',
  'solo',
];

// These are multi-session — keep one channel alive until last session ends. Only genuinely
// multi-day single-run events belong here (FNCS's Fri/Sat/Sun qualifying weekend). "Fortnite
// Performance Evaluation" used to be listed here too, but it recurs weekly under this exact same
// title with no distinguishing round/date text — since grouping is by title+region only, a scrape
// taken while this week's session is still upcoming also picks up next week's (and beyond) under
// the same group, pushing lastBeginTime weeks out and arming the deletion timer accordingly. It's
// a single-session-per-week event, so it belongs on the default (per-occurrence beginTime) path.
const MULTI_SESSION_KEYWORDS = [
  'fncs',
];

// Tournaments that get a permanent, always-open channel per title+region (channel-manager.js's
// checkAndCreateChannels/createTournamentChannel) instead of the normal 48hr-window/auto-delete
// path, since players want to find teammates early to prep:
//   - 'fncs division' — narrower than MULTI_SESSION_KEYWORDS' broad 'fncs' match, which would
//     also catch FNCS Majors and the Last Chance Qualifier; those stay on the normal path.
//   - 'console duos victory cup' — a full-phrase match specifically to avoid also catching
//     "Console Duos ZB Cash Cup", a different (non-permanent) tournament that also starts with
//     "Console Duos".
const PERMANENT_KEYWORDS = [
  'fncs division',
  'console duos victory cup',
];

// Regions we support — Fortnite Tracker's calendar covers more (OCE, ASIA, NAW, BR/Brazil, etc.)
// but the bot only has role/category config for these three.
const SUPPORTED_REGIONS = ['EU', 'NAC', 'ME'];

// Epic's own calendar payload has no console/platform-restriction field at all (confirmed absent
// from every real example seen this session — no platformMappings/additionalRequirements or
// similar). Every real console-exclusive example seen so far says "Console" directly in its own
// name/id ("Console Duos ZB Cash Cup", "Console Solo Victory Cup (ZB)", "S41_ConsoleVCC_SolosZB")
// — 100% correlation in the data available, so detectConsoleOnlyFromEpic below uses that as a text
// heuristic rather than a structured flag. This override map exists specifically because a text
// heuristic WILL eventually meet a counter-example (a console-exclusive tournament that doesn't say
// "console", or one that mentions "console" without being exclusive) — same philosophy and shape as
// roster-size.js's KNOWN_TOURNAMENT_ROSTER_SIZES: keep this small, only add an entry once it's
// actually confirmed wrong, matched by substring against the combined lowercased name+id.
const CONSOLE_ONLY_OVERRIDES = {
  // 'some future tournament name': true, // or false, once a real counter-example is confirmed
};

// See CONSOLE_ONLY_OVERRIDES above for why this is a text heuristic, not a confirmed structured
// signal — used only by scrapeEpicCalendar below (Fortnite Tracker's own consoleOnly detection,
// window.platformGroups, is unaffected and untouched).
function detectConsoleOnlyFromEpic(name, id) {
  const combined = `${name ?? ''} ${id ?? ''}`.toLowerCase();
  for (const [known, value] of Object.entries(CONSOLE_ONLY_OVERRIDES)) {
    if (combined.includes(known.toLowerCase())) return value;
  }
  return /console/.test(combined);
}

// ---------------------------------------------------------------------------------------------
// Shared grouping/filtering — takes a flat array of raw sessions (one per tournament/window/
// region combination) and applies the blocked-keyword filter, same-day collapse, and past/region
// filter + final grouping.
// ---------------------------------------------------------------------------------------------
function buildTournamentGroups(rawSessions) {
  // Stage 1: blocked-keyword filter (title-only, doesn't depend on timing or source).
  let blockedCount = 0;
  let bareBuildModeCount = 0;
  const survivingSessions = [];
  for (const session of rawSessions) {
    const blockedMatch = BLOCKED_KEYWORDS.find(k => session.titleLower.includes(k));
    // Restricted-to-already-qualified-players FNCS stages are compound matches — "fncs" alone
    // would also block regular FNCS divisions, so these check for a second, stage-specific word
    // instead. Confirmed against real Fortnite Tracker titles: "FNCS Major 2 Last Chance
    // Qualifier" (fncs + neither finals nor heats) survives correctly; "FNCS Major 2 Finals",
    // "FNCS Major 2 Heats", and "FNCS Global Championship Last Chance Finals" are all correctly
    // excluded. A plain 'fncs'+'major' check (an earlier version of this logic) wrongly excluded
    // the Last Chance Qualifier, since "Major 2" is just part of its real name, not an indicator
    // it's restricted.
    const isFncsFinals = session.titleLower.includes('fncs') && session.titleLower.includes('finals');
    const isFncsHeats = session.titleLower.includes('fncs') && session.titleLower.includes('heats');
    if (blockedMatch || isFncsFinals || isFncsHeats) {
      blockedCount++;
      continue;
    }
    // Defensive backstop, not currently reachable from real Fortnite Tracker data (every real
    // title observed is "{cup name} {build mode}", never the build-mode word alone) — kept
    // because channel-manager.js's createTournamentChannel also guards on this immediately before
    // creating a channel, and a title that somehow resolves to nothing but a build-mode label is
    // never a valid channel name regardless of source.
    if (isBareBuildModeLabel(session.titleLower)) {
      bareBuildModeCount++;
      continue;
    }
    survivingSessions.push(session);
  }

  // Stage 2: collapse same-title+region raw sessions that fall on the same UTC calendar day down
  // to just the earliest. This is specifically for "Fortnite Performance Evaluation", which
  // scrapes as two same-day sessions under the identical title+region each week: an earlier
  // "Opens" session and a later "Finals" session the same day. Ordering matters: this runs BEFORE
  // the past-time filter (Stage 3), using every raw session including already-past ones — so once
  // Opens has started (and would itself get filtered out as "past"), Finals still never surfaces
  // as a fallback "earliest upcoming session for this key". Discarded sessions never touch
  // beginTime, lastBeginTime, or isMultiSession detection for anything. Days with only one raw
  // session (the overwhelming majority) are unaffected, and a genuinely multi-day tournament
  // (FNCS's Fri/Sat/Sun) keeps every day's session since each falls on a different calendar day.
  const earliestPerDay = new Map(); // `${key}|${utcDayKey}` -> rawSession

  for (const session of survivingSessions) {
    const dayKey = new Date(session.beginTime).toISOString().slice(0, 10);
    const dedupeKey = `${session.key}|${dayKey}`;
    const existing = earliestPerDay.get(dedupeKey);
    if (!existing || new Date(session.beginTime) < new Date(existing.beginTime)) {
      earliestPerDay.set(dedupeKey, session);
    }
  }
  const sameDayDuplicatesDropped = survivingSessions.length - earliestPerDay.size;
  if (sameDayDuplicatesDropped > 0) {
    console.log(`📅 Collapsed ${sameDayDuplicatesDropped} same-day duplicate session(s) to their earliest occurrence (e.g. Performance Evaluation's Opens/Finals pairing)`);
  }

  // Stage 3: apply the past-time and unsupported-region filters to the already-deduplicated
  // survivors, then fold what's left into one group per title+region — beginTime = earliest
  // surviving session, lastBeginTime = latest.
  let pastCount = 0;
  let unsupportedRegionCount = 0;
  const now = new Date();
  const groups = {};

  for (const session of earliestPerDay.values()) {
    if (!SUPPORTED_REGIONS.includes(session.region)) {
      unsupportedRegionCount++;
      continue;
    }

    const beginTime = new Date(session.beginTime);
    if (beginTime < now) {
      pastCount++;
      continue;
    }

    // isTrios only matters as a boolean downstream (buildTournamentEmbed/buildQueueButtons only
    // distinguish Trios vs. Duos) — solo is already blocked above, and squads isn't a format this
    // bot's queue system offers at all, so any non-trios survivor defaults to "Duos" same as today.
    // rosterSize (the raw, possibly-null resolution) is kept on the group too — not just the
    // derived boolean — so enrichWithDescriptionRosterSize below (scrapeTrackerCalendar) knows
    // exactly which groups the title+override signals actually left unclassified (null) vs.
    // genuinely resolved to non-trios (1/2/4), and only spends a description fetch on the former.
    const rosterSize = resolveRosterSize(session.titleLower);
    const isTrios = rosterSize === 3;
    const isMultiSession = MULTI_SESSION_KEYWORDS.some(k => session.titleLower.includes(k));
    const isPermanent = PERMANENT_KEYWORDS.some(k => session.titleLower.includes(k));
    const isRankedCup = isRankedCupTitle(session.titleLower);
    // Auto-detected default (build-mode.js) — routes channel-manager.js's createTournamentChannel
    // into the correct one of the 9 region×build-mode forums. Carried through
    // tournament-approval.js's pending record as-is; a mod can override it via the approval DM's
    // build-mode select menu before approving (tournament-approval.js's setBuildMode) — that
    // override, once made, takes precedence over re-running this detection on every later tick
    // (see gateTournaments' doc comment on why the already-approved fast path reads it back off
    // the record instead of recomputing).
    const buildMode = detectBuildMode(session.titleLower);

    if (!groups[session.key]) {
      groups[session.key] = {
        name: session.name,
        region: session.region,
        beginTime: session.beginTime,
        lastBeginTime: session.beginTime,
        consoleOnly: session.consoleOnly,
        isTrios,
        rosterSize,
        isMultiSession,
        isPermanent,
        isRankedCup,
        buildMode,
        platforms: session.platforms,
        // Stable identity independent of the rendered title — Fortnite Tracker's own event
        // identifier for this tournament+region+build-mode (e.g. "epicgames_S41_PSTypicalGamer_EU"
        // vs "..._ZB_EU" for the Zero Build variant of the same cup — confirmed distinct per real
        // data), constant across that event's multiple windows/rounds and unaffected by any future
        // change to how we render/format the display or channel name. See channel-manager.js's
        // createTournamentChannel, which uses this to rename an existing channel in place instead
        // of creating a duplicate when naming logic changes.
        eventId: session.eventId ?? null,
      };
    } else {
      const g = groups[session.key];
      // Track earliest start time (for channel creation)
      if (beginTime < new Date(g.beginTime)) g.beginTime = session.beginTime;
      // Track latest start time (for deletion of multi-session tournaments)
      if (beginTime > new Date(g.lastBeginTime)) g.lastBeginTime = session.beginTime;
    }
  }

  console.log(`📊 Filtering: ${blockedCount} blocked-keyword session(s), ${bareBuildModeCount} bare-build-mode-label session(s), ${pastCount} past session(s), ${unsupportedRegionCount} unsupported-region session(s) skipped`);
  console.log(`📋 Grouped into ${Object.keys(groups).length} tournament/region entries`);

  return Object.values(groups);
}

// Ranked Cup tournaments span 6 separate in-game rank tiers (Bronze/Silver/Gold/Platinum/Diamond/
// Elite) under ONE Fortnite Tracker event listing — confirmed against live scrape data, real
// titles never mention a rank tier at all ("Duos Ranked Cup (Battle Royale)"/"(Zero Build)"/
// "(Reload)" is the full set observed, one per build mode per region). embeds.js's
// buildRankedCupQueueButtons/buildRankedCupTournamentEmbed use this to give the channel one queue
// button per rank instead of the single generic one every other tournament gets.
function isRankedCupTitle(nameLower) {
  return nameLower.includes('ranked cup');
}

// True if, once every build-mode word/abbreviation is stripped out, nothing recognizable is left —
// i.e. the title IS a build-mode label and nothing else (e.g. "Battle Royale", "Zero Build (ZB)"),
// as opposed to a real tournament name that merely mentions a build mode ("Solo Ranked Cup (Battle
// Royale)"). Exported so channel-manager.js can use it as a last-resort guard right before channel
// creation too.
function isBareBuildModeLabel(nameLower) {
  const stripped = nameLower
    .replace(/\(?\s*battle royale\s*\)?/gi, ' ')
    .replace(/\(?\s*zero build\s*\)?/gi, ' ')
    .replace(/\bbr\b|\bzb\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, '');
  return stripped.length === 0;
}

// ---------------------------------------------------------------------------------------------
// Fortnite Tracker (fortnitetracker.com/events) — sole tournament data source. The official
// fortnite.com/competitive/schedule was tried as a primary source for a while (Fortnite Tracker
// load reduction was the goal), but that's already solved separately (a several-hour scrape
// interval — channel-manager.js's TOURNAMENT_CHECK_INTERVAL_MS, 4h as of this writing, widened
// from an original 20min since every detected tournament already sits behind a manual approval
// gate regardless of scrape cadence — instead of hourly, one shared scrape fanned out to every
// guild instead of per-guild, capped event history) — and the official schedule's rendered text
// turned out to be genuinely ambiguous
// (byte-identical visible text for a cup's Battle Royale and Zero Build variants, one generic
// label covering multiple FNCS stages), which was the root cause of nearly every tournament-
// naming bug fixed while it was in use. Fortnite Tracker's own titles don't have that problem —
// confirmed against real data: every build-mode-split cup already spells out "Battle Royale" /
// "Zero Build" / "ZB" plainly in its own title (e.g. "PlayStation Typical Gamer Icon Cup Battle
// Royale" vs "...Zero Build" as genuinely different strings) — so channel-manager.js's existing
// abbreviateBuildMode (a simple keyword check on the title) is sufficient on its own; no href/
// slug-based detection is needed against this source at all.
// ---------------------------------------------------------------------------------------------

// Loads the events page for ONE playlist and pulls out the raw `imp_calendar` JSON blob.
// competitive=pr + playlist=<playlist> are real Fortnite Tracker query params (confirmed live,
// e.g. fortnitetracker.com/profile/kbm/finn444.../events?playlist=trios existing as a real,
// indexed page) — server-side filtering to exactly what this bot ever wants (real PR tournaments,
// Duos/Trios only — Solo is BLOCKED_KEYWORDS-rejected client-side today and Squads was never a
// real competitive format this bot supports) instead of downloading every playlist/every non-PR
// listing and discarding most of it in buildTournamentGroups. The browser's whole launch-through-
// close lifetime runs inside withBrowserSlot (proxy-config.js) so no more than
// MAX_CONCURRENT_BROWSERS headless Chromium processes are ever alive at once across the whole bot
// — see that function's header comment for why.
async function fetchRawCalendarForPlaylist(playlist) {
  return withBrowserSlot(async () => {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyLaunchArgs()]
    });

    try {
      const page = await browser.newPage();
      await authenticatePage(page);
      await blockUnnecessaryResources(page);
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      await page.goto(`https://fortnitetracker.com/events?competitive=pr&playlist=${playlist}`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      return await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const content = script.innerText || script.textContent;
          if (content.includes('imp_calendar')) {
            const match = content.match(/var imp_calendar = (\[.*?\]);/s);
            if (match) return JSON.parse(match[1]);
          }
        }
        return null;
      });
    } finally {
      await closeBrowserSafely(browser);
    }
  });
}

// Fetches every playlist config.ftCalendarPlaylists lists (duos, trios) and concatenates the raw
// entries — a real tournament never straddles two playlist fetches (a title is either the Duos or
// the Trios listing for its region, never both), and buildTournamentGroups' existing title+region
// keying already merges/dedupes correctly if a title somehow did appear in more than one fetch, so
// a plain concatenation here is safe. One navigation per playlist (2 today) rather than one big
// unfiltered fetch — a real added cost (an extra Puppeteer launch per calendar check), but this
// only runs on channel-manager.js's TOURNAMENT_CHECK_INTERVAL_MS tick (hours apart), nowhere near
// the per-player scrape hot path #2/#3 are about, so doubling it here is a real but low-frequency
// trade against downloading (and then discarding, client-side) every other playlist/every non-PR
// listing on every single tick.
async function fetchRawCalendar() {
  const perPlaylist = await Promise.all(
    config.ftCalendarPlaylists.map(playlist => fetchRawCalendarForPlaylist(playlist))
  );

  if (perPlaylist.every(entries => !entries)) {
    return null;
  }

  return perPlaylist.flatMap(entries => entries ?? []);
}

// THIRD roster-size signal (after title keyword + the manual override map, both in
// roster-size.js's resolveRosterSize) — a tournament's own Fortnite Tracker event page
// (https://fortnitetracker.com/events/{eventId}, the same URL embeds.js's tournament embed link
// already uses) sometimes states team size in plain English in its description even when the
// title itself doesn't. Confirmed against real data: "Champion Aphrodite FNCS Cup"'s title has no
// team-size word at all, but its page's <meta name="description"> reads "...Duo up and compete...",
// while "PlayStation Typical Gamer Icon Cup" (already in the override map) has no such wording in
// its description either — this signal genuinely doesn't help every unclassified title, it just
// helps some of them, reducing how often a brand-new title needs a manual override entry added at
// all. Only ever called for a title that already has no signal from the first two stages (see
// enrichWithDescriptionRosterSize below) — never on the scraper.js per-player-event hot path,
// where a network fetch per unclassified event would be far too expensive to do inline.
async function fetchEventDescriptionRosterSize(eventId) {
  return withBrowserSlot(async () => {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyLaunchArgs()]
    });

    try {
      const page = await browser.newPage();
      await authenticatePage(page);
      await blockUnnecessaryResources(page);
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      await page.goto(`https://fortnitetracker.com/events/${eventId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });

      const description = await page.evaluate(() => {
        const meta = document.querySelector('meta[name="description"]') ?? document.querySelector('meta[property="og:description"]');
        return meta?.content ?? null;
      });

      if (!description) return null;
      return inferRosterSize(description.toLowerCase());
    } finally {
      await closeBrowserSafely(browser);
    }
  });
}

// Runs fetchEventDescriptionRosterSize for every group the first two signals left unclassified
// (rosterSize === null) — mutates isTrios/rosterSize in place on the ones it manages to resolve,
// leaves everything else exactly as buildTournamentGroups produced it (same "leave unclassified,
// log it" fallback as before this signal existed). One extra Puppeteer navigation per still-
// unclassified group, not per session/player — bounded by however many distinct tournaments are
// currently unclassified (typically zero or a small handful), same order of magnitude as the one
// navigation scrapeTrackerCalendar already does for the calendar itself. A single group's fetch
// failing (network error, page shape change, etc.) is logged and skipped, never aborts the rest.
//
// Calls fetchEventDescriptionRosterSize through module.exports (not a direct local reference) —
// same delegation precedent as scraper.js's scrapePlayer/scrapePlayerOnce — so a test can swap in
// a fake implementation without a real Puppeteer/network round trip.
async function enrichWithDescriptionRosterSize(groups) {
  for (const group of groups) {
    // A synthetic "epic_..." eventId (scrapeEpicCalendar's stand-in for a real Fortnite Tracker
    // event id — see its doc comment) would never resolve to a real fortnitetracker.com/events/
    // page, so this would always fail. Skipping it outright avoids launching a full Puppeteer
    // browser for a fetch that's guaranteed to 404 — both a correctness no-op and, more to the
    // point, exactly the kind of wasted Fortnite Tracker traffic flipping to Epic-primary discovery
    // was meant to reduce.
    if (group.rosterSize != null || !group.eventId || group.eventId.startsWith('epic_')) continue;

    try {
      const rosterSize = await module.exports.fetchEventDescriptionRosterSize(group.eventId);
      if (rosterSize != null) {
        group.rosterSize = rosterSize;
        group.isTrios = rosterSize === 3;
        console.log(`  📝 Resolved roster size for "${group.name}" (${group.region}) from its event description: ${rosterSize}`);
      }
    } catch (err) {
      console.error(`  ⚠️ Failed to fetch event description for "${group.name}" (${group.eventId}):`, err.message);
    }
  }
  return groups;
}

// Cross-checks/upgrades each group's auto-detected build mode (title-word based — detectBuildMode)
// against Epic's own id-string pattern (epic-api.js's findEventEntryByName + build-mode.js's
// detectBuildModeFromEpicId) — a structural signal straight from Epic's own naming. Only ever
// OVERRIDES group.buildMode when Epic actually has a matching calendar entry (by exact name) AND
// that entry's id(s) contain an explicit ZB/Reload marker; leaves the existing title-based default
// untouched otherwise (no Epic match, FORTNITE_API_KEY unset, an API failure, or an id with no
// explicit marker — see detectBuildModeFromEpicId's doc comment on why a "no marker" id isn't
// treated as confirmation of Battle Royale). Logs whenever Epic's signal would have DISAGREED with
// the title-based default, to surface any real case the id pattern doesn't hold for. A mod can
// still manually correct the result either way via the approval DM's build-mode select menu
// (tournament-approval.js's setBuildMode) before a channel is ever created. Same
// "enrich in place, log failures, never abort the rest" shape as enrichWithDescriptionRosterSize
// above.
async function enrichWithEpicBuildMode(groups) {
  for (const group of groups) {
    let entry;
    try {
      entry = await epicApi.findEventEntryByName(group.name);
    } catch (err) {
      console.error(`  ⚠️ Epic build-mode lookup failed for "${group.name}":`, err.message);
      continue;
    }
    if (!entry) continue;

    const epicBuildMode = detectBuildModeFromEpicId(entry.id, entry.eventWindows?.[0]?.eventTemplateId);
    if (!epicBuildMode) continue;

    if (epicBuildMode !== group.buildMode) {
      console.log(`  🔀 Build mode for "${group.name}" (${group.region}): title-based detection said "${group.buildMode}", Epic's id says "${epicBuildMode}" — using Epic's.`);
    }
    group.buildMode = epicBuildMode;
  }
  return groups;
}

// Same cross-check pattern as enrichWithEpicBuildMode above, applied to roster size instead
// (roster-size.js's detectRosterSizeFromEpicId) — only overrides when Epic's id has an explicit
// solo/duo/trio/squad marker, leaves the existing value (title-based, manual-override-map, or the
// FT event-description fallback) untouched otherwise. A separate function/lookup rather than
// folding into enrichWithEpicBuildMode above: that function is already in real use and tested, and
// the extra findEventEntryByName call this makes is a cached local scan (no extra network cost),
// not worth the churn of merging two already-working, independently-testable enrichments.
async function enrichWithEpicRosterSize(groups) {
  for (const group of groups) {
    let entry;
    try {
      entry = await epicApi.findEventEntryByName(group.name);
    } catch (err) {
      console.error(`  ⚠️ Epic roster-size lookup failed for "${group.name}":`, err.message);
      continue;
    }
    if (!entry) continue;

    const epicRosterSize = detectRosterSizeFromEpicId(entry.id, entry.eventWindows?.[0]?.eventTemplateId);
    if (epicRosterSize == null) continue;

    if (epicRosterSize !== group.rosterSize) {
      console.log(`  🔀 Roster size for "${group.name}" (${group.region}): existing detection said ${group.rosterSize ?? 'unclassified'}, Epic's id says ${epicRosterSize} — using Epic's.`);
    }
    group.rosterSize = epicRosterSize;
    group.isTrios = epicRosterSize === 3;
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------
// Epic (api-fortnite.com) — PRIMARY tournament-calendar source as of tonight's rework. Builds the
// exact same rawSessions shape Fortnite Tracker's scrapeTrackerCalendar produces below, then runs
// it through the SAME, UNCHANGED buildTournamentGroups — every filtering rule (blocked keywords,
// FNCS finals/heats exclusion, same-day collapse, permanent-tournament detection, past-time/region
// filtering, bare-build-mode guard) applies identically regardless of which source produced the raw
// sessions, since buildTournamentGroups only ever looks at the rawSessions shape itself, never
// which scraper built it. This is deliberate: it's the lowest-risk way to guarantee FNCS/permanent-
// tournament handling really does carry over unchanged, rather than re-implementing that logic
// against Epic's shape and hoping it stays in sync.
//
// What Epic's own payload genuinely does NOT provide (confirmed absent from every real example
// seen this session, not assumed): a structured platform/console-restriction field (see
// CONSOLE_ONLY_OVERRIDES/detectConsoleOnlyFromEpic above for the text-heuristic stand-in), and the
// real "epicgames_..._REGION"-shaped eventId Epic's own placement-lookup API expects (only ever
// confirmed via Fortnite Tracker's scrape — see the synthetic eventId comment below). Region,
// build-mode, and roster-size ARE all confirmed derivable from Epic's own data.
//
// Returns null (not []) when Epic's fetch itself fails outright (no key set, rate limited, network
// error, empty/unrecognized payload) — same "null means try the fallback, [] means a real but
// empty result" distinction fetchRawCalendar/scrapeTrackerCalendar already draw for the Fortnite
// Tracker path. See scrapeUpcomingTournaments below for the actual fail-soft wiring.
// ---------------------------------------------------------------------------------------------
async function scrapeEpicCalendar() {
  const events = await epicApi.fetchGlobalEvents();
  if (!events) return null;

  const rawSessions = [];
  for (const raw of events) {
    const entry = epicApi.normalizeEventEntry(raw);
    if (!entry) continue;

    const title = entry.name.trim();
    const titleLower = title.toLowerCase();
    const consoleOnly = detectConsoleOnlyFromEpic(entry.name, entry.id);

    for (const window of entry.eventWindows ?? []) {
      const suffix = epicApi.windowRegionSuffix(window);
      const region = SUPPORTED_REGIONS.find(r => (epicApi.REGION_SUFFIX_CANDIDATES[r] ?? [r]).includes(suffix));
      if (!region) continue; // not one of this bot's 3 regions (or an unrecognized suffix)

      rawSessions.push({
        key: `${title}-${region}`,
        name: title,
        titleLower,
        region,
        beginTime: window.beginTime,
        consoleOnly,
        // Only the consoleOnly boolean above is actually read downstream (channel-manager.js/
        // queue.js's isCompatiblePlatform) — this array itself is never inspected, so a synthetic
        // single-entry stand-in is enough to keep the rawSession shape consistent with Fortnite
        // Tracker's (which populates a real platformGroups-derived array here).
        platforms: consoleOnly ? ['Console'] : [],
        // Epic's own calendar payload never exposes the real "epicgames_..._REGION" identifier its
        // OWN placement-lookup API (epic-api.js's getPlayerEventMatches) expects — only ever
        // confirmed via Fortnite Tracker's scraped window.eventId. This synthetic value is stable
        // and unique per tournament+region (entry.id is Epic's own persistent identifier, constant
        // across a recurring tournament's rounds/weeks — confirmed via the real "Season41_..." ids
        // seen this session), which is ALL channel-manager.js's dedup/rename actually needs (any
        // consistent value works there — see its findExistingTournamentChannel doc comment). It is
        // NOT a value Epic's real matches endpoint will recognize: getEpicOwnTournamentModifier
        // already fails soft on an unrecognized eventId (falls back to Fortnite-Tracker-derived
        // data), so this is safe — it just means that specific enrichment won't engage for a
        // tournament discovered via this path, until a real derivation is confirmed.
        eventId: `epic_${entry.id}_${region}`,
      });
    }
  }

  const groups = buildTournamentGroups(rawSessions);
  const withRosterSize = await module.exports.enrichWithEpicRosterSize(groups);
  return module.exports.enrichWithEpicBuildMode(withRosterSize);
}

async function scrapeTrackerCalendar() {
  const rawCalendar = await fetchRawCalendar();

  if (!rawCalendar) {
    console.log('❌ Could not find calendar data');
    return [];
  }

  console.log(`📡 Tracker scraper fetched ${rawCalendar.length} raw calendar entries`);

  const rawSessions = [];
  for (const entry of rawCalendar) {
    const title = entry.customData?.title?.trim() ?? '';
    const titleLower = title.toLowerCase();
    const windows = entry.customData?.windows ?? [];

    for (const window of windows) {
      const regions = window.regions ?? [];
      const platforms = window.platformGroups ?? [];

      for (const region of regions) {
        rawSessions.push({
          key: `${title}-${region}`,
          name: title,
          titleLower,
          region,
          beginTime: window.beginTime,
          consoleOnly: platforms.length === 1 && platforms[0] === 'Console',
          platforms,
          // e.g. "epicgames_S41_PSTypicalGamer_EU" — see buildTournamentGroups' eventId comment.
          eventId: window.eventId ?? null,
        });
      }
    }
  }

  const groups = buildTournamentGroups(rawSessions);
  const withDescriptionRosterSize = await enrichWithDescriptionRosterSize(groups);
  const withEpicRosterSize = await module.exports.enrichWithEpicRosterSize(withDescriptionRosterSize);
  return module.exports.enrichWithEpicBuildMode(withEpicRosterSize);
}

// Returns global tournament-calendar data — identical regardless of which guild (if any) asks,
// since it's one shared scrape, not scoped to a guild in any way. Callers MUST hoist this out of
// any per-guild loop and fan the single result out to every guild instead — calling it once per
// guild means one full Puppeteer navigation per guild for data that's the same every time, which
// at scale (40+ guilds) is exactly what got this bot's VPS IP blocked by Cloudflare in the past.
// See channel-manager.js's runTournamentCheckTick/runEmbedRefreshTick.
//
// Epic (api-fortnite.com) is the PRIMARY source as of tonight's rework — scrapeEpicCalendar above
// genuinely replaces Fortnite Tracker's own two-full-page Puppeteer calendar scrape
// (fetchRawCalendar) on every tick Epic succeeds, which is the actual bandwidth/cost reduction this
// was for. scrapeTrackerCalendar only runs now when Epic's own call fails outright (no
// FORTNITE_API_KEY set, rate limited, network error, unrecognized payload) — same fail-soft
// pattern already built and proven for the ownTournamentModifier enrichment (epic-api.js), reused
// here rather than reinvented. Never throws either way: scrapeEpicCalendar's own internal errors
// are caught here so a bug in the new path can't take tournament discovery down entirely with
// Fortnite Tracker sitting right there as a working fallback.
async function scrapeUpcomingTournaments() {
  let epicGroups = null;
  try {
    epicGroups = await module.exports.scrapeEpicCalendar();
  } catch (err) {
    console.error('❌ Epic calendar discovery threw — falling back to Fortnite Tracker:', err.message);
  }

  if (epicGroups) {
    console.log(`✅ Tournament calendar served by Epic (${epicGroups.length} entries) — Fortnite Tracker calendar scrape skipped this tick`);
    return epicGroups;
  }

  console.log('⚠️ Epic calendar unavailable this tick — falling back to Fortnite Tracker');
  return module.exports.scrapeTrackerCalendar();
}

module.exports = {
  scrapeUpcomingTournaments, buildTournamentGroups, isBareBuildModeLabel, scrapeTrackerCalendar,
  scrapeEpicCalendar, isRankedCupTitle, fetchEventDescriptionRosterSize, enrichWithDescriptionRosterSize,
  enrichWithEpicBuildMode, enrichWithEpicRosterSize, detectConsoleOnlyFromEpic, CONSOLE_ONLY_OVERRIDES,
  PERMANENT_KEYWORDS,
};

// Test run
if (require.main === module) {
  scrapeUpcomingTournaments().then(tournaments => {
    console.log(`Found ${tournaments.length} unique tournaments:\n`);
    tournaments.forEach(t => {
      console.log(
        `${t.name} | ${t.region} | ` +
        `Start: ${t.beginTime} | ` +
        `Last session: ${t.lastBeginTime} | ` +
        `MultiSession: ${t.isMultiSession} | ` +
        `Trios: ${t.isTrios} | ` +
        `Console only: ${t.consoleOnly}`
      );
    });
  });
}
