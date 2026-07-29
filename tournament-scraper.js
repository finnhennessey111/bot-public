const puppeteer = require('puppeteer');
const { proxyLaunchArgs, authenticatePage, logProxyMode } = require('./proxy-config');
const { resolveRosterSize } = require('./roster-size');

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
    const isTrios = resolveRosterSize(session.titleLower) === 3;
    const isMultiSession = MULTI_SESSION_KEYWORDS.some(k => session.titleLower.includes(k));
    const isPermanent = PERMANENT_KEYWORDS.some(k => session.titleLower.includes(k));

    if (!groups[session.key]) {
      groups[session.key] = {
        name: session.name,
        region: session.region,
        beginTime: session.beginTime,
        lastBeginTime: session.beginTime,
        consoleOnly: session.consoleOnly,
        isTrios,
        isMultiSession,
        isPermanent,
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
// load reduction was the goal), but that's already solved separately (20-min scrape interval
// instead of hourly, one shared scrape fanned out to every guild instead of per-guild, capped
// event history) — and the official schedule's rendered text turned out to be genuinely ambiguous
// (byte-identical visible text for a cup's Battle Royale and Zero Build variants, one generic
// label covering multiple FNCS stages), which was the root cause of nearly every tournament-
// naming bug fixed while it was in use. Fortnite Tracker's own titles don't have that problem —
// confirmed against real data: every build-mode-split cup already spells out "Battle Royale" /
// "Zero Build" / "ZB" plainly in its own title (e.g. "PlayStation Typical Gamer Icon Cup Battle
// Royale" vs "...Zero Build" as genuinely different strings) — so channel-manager.js's existing
// abbreviateBuildMode (a simple keyword check on the title) is sufficient on its own; no href/
// slug-based detection is needed against this source at all.
// ---------------------------------------------------------------------------------------------

// Loads the events page and pulls out the raw `imp_calendar` JSON blob.
async function fetchRawCalendar() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyLaunchArgs()]
  });

  try {
    const page = await browser.newPage();
    await authenticatePage(page);
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto('https://fortnitetracker.com/events', {
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
    await browser.close();
  }
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

  return buildTournamentGroups(rawSessions);
}

// Returns global tournament-calendar data — identical regardless of which guild (if any) asks,
// since it's one shared scrape, not scoped to a guild in any way. Callers MUST hoist this out of
// any per-guild loop and fan the single result out to every guild instead — calling it once per
// guild means one full Puppeteer navigation per guild for data that's the same every time, which
// at scale (40+ guilds) is exactly what got this bot's VPS IP blocked by Cloudflare in the past.
// See channel-manager.js's runTournamentCheckTick/runEmbedRefreshTick.
async function scrapeUpcomingTournaments() {
  return scrapeTrackerCalendar();
}

module.exports = {
  scrapeUpcomingTournaments, buildTournamentGroups, isBareBuildModeLabel, scrapeTrackerCalendar,
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
