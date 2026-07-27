const puppeteer = require('puppeteer');

// Skip these entirely when creating queue channels (scrapeUpcomingTournaments) — this (plus the
// separate FNCS-Major compound check below) is the single source of truth for tournament channel
// eligibility. channel-manager.js has no whitelist of its own — anything that survives this
// filter gets a channel, including ranked cups, skin/creator cups (Mongraal Cup, Clix Cup, etc.),
// victory cups, cash cups, reload cups, and FNCS divisions (which additionally get a permanent,
// always-open channel — see PERMANENT_KEYWORDS below).
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
//     "Console Duos". Not independently verified against a live scrape (this dev environment hits
//     the same Cloudflare block described in scrapeUpcomingTournaments' doc comment above) — if
//     the real scraped title differs from this exact phrase, this entry silently never matches
//     rather than erroring; confirm against production logs (channel-manager.js's
//     checkAndCreateChannels logs every surviving tournament's raw `name`) after this ships.
const PERMANENT_KEYWORDS = [
  'fncs division',
  'console duos victory cup',
];

// Regions we support
const SUPPORTED_REGIONS = ['EU', 'NAC', 'ME'];

// Shared page-fetch + extraction: loads the events page and pulls out the raw `imp_calendar`
// JSON blob that both scrape functions parse in their own way.
async function fetchRawCalendar() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
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

// Returns global tournament-calendar data — identical regardless of which guild (if any) asks,
// since it's one shared fortnitetracker.com/events scrape, not scoped to a guild in any way.
// Callers MUST hoist this out of any per-guild loop and fan the single result out to every guild
// instead — calling it once per guild means one full Puppeteer navigation per guild for data
// that's the same every time, which at scale (40+ guilds) is exactly what got this bot's VPS IP
// blocked by Cloudflare. See channel-manager.js's runTournamentCheckTick/runEmbedRefreshTick.
async function scrapeUpcomingTournaments() {
  const rawCalendar = await fetchRawCalendar();

  if (!rawCalendar) {
    console.log('❌ Could not find calendar data');
    return [];
  }

  console.log(`📡 Scraper fetched ${rawCalendar.length} raw calendar entries`);

  // Stage 1: flatten every entry/window/region combination into one raw session record each,
  // applying only the blocked-keyword filter (title-only, doesn't depend on timing). Deliberately
  // NOT yet filtering past sessions or unsupported regions — Stage 2's same-day collapse needs to
  // see a day's full raw session set, including an already-past session, to correctly identify
  // and discard that day's later duplicate regardless of whether the earlier one is itself still
  // upcoming (see Stage 2's comment for why this ordering matters).
  let blockedCount = 0;
  const rawSessions = [];

  for (const entry of rawCalendar) {
    const title = entry.customData?.title?.trim() ?? '';
    const titleLower = title.toLowerCase();
    const windows = entry.customData?.windows ?? [];

    // Skip blocked tournament types
    const blockedMatch = BLOCKED_KEYWORDS.find(k => titleLower.includes(k));
    // FNCS Majors are a compound match — "fncs" and "major" don't work as standalone
    // BLOCKED_KEYWORDS entries without also blocking regular FNCS divisions.
    const isFncsMajor = titleLower.includes('fncs') && titleLower.includes('major');
    if (blockedMatch || isFncsMajor) {
      blockedCount++;
      continue;
    }

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
        });
      }
    }
  }

  // Stage 2: collapse same-title+region raw sessions that fall on the same UTC calendar day down
  // to just the earliest. This is specifically for "Fortnite Performance Evaluation", which
  // scrapes as two same-day sessions under the identical title+region each week: an earlier
  // "Opens" session and a later "Finals" session the same day — confirmed only by each week's
  // pair sharing a calendar day, NOT by any distinguishing text. This dev environment can't reach
  // fortnitetracker.com to inspect the raw JSON directly (same Cloudflare block that got the VPS's
  // IP flagged — confirmed again just now, still a 403), so this could not be verified against a
  // live raw window/entry object; day-only is the sole signal implemented here. If a raw label
  // field turns out to exist, add an explicit check for it on top of this — but don't remove this
  // day-based collapse, since it's what actually guarantees Finals is discarded even once Opens
  // has already started (see below).
  //
  // Ordering matters: this runs BEFORE the past-time filter (Stage 3), using every raw session
  // including already-past ones — so once Opens has started (and would itself get filtered out as
  // "past"), Finals still never surfaces as a fallback "earliest upcoming session for this key".
  // Discarded sessions never touch beginTime, lastBeginTime, or isMultiSession detection for
  // anything. Days with only one raw session (the overwhelming majority) are unaffected, and a
  // genuinely multi-day tournament (FNCS's Fri/Sat/Sun) keeps every day's session since each falls
  // on a different calendar day.
  const earliestPerDay = new Map(); // `${key}|${utcDayKey}` -> rawSession

  for (const session of rawSessions) {
    const dayKey = new Date(session.beginTime).toISOString().slice(0, 10);
    const dedupeKey = `${session.key}|${dayKey}`;
    const existing = earliestPerDay.get(dedupeKey);
    if (!existing || new Date(session.beginTime) < new Date(existing.beginTime)) {
      earliestPerDay.set(dedupeKey, session);
    }
  }
  const sameDayDuplicatesDropped = rawSessions.length - earliestPerDay.size;
  if (sameDayDuplicatesDropped > 0) {
    console.log(`📅 Collapsed ${sameDayDuplicatesDropped} same-day duplicate session(s) to their earliest occurrence (e.g. Performance Evaluation's Opens/Finals pairing)`);
  }

  // Stage 3: apply the past-time and unsupported-region filters to the already-deduplicated
  // survivors, then fold what's left into one group per title+region — same aggregation as
  // before (beginTime = earliest surviving session, lastBeginTime = latest).
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

    const isTrios = session.titleLower.includes('trio');
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
      };
    } else {
      const g = groups[session.key];
      // Track earliest start time (for channel creation)
      if (beginTime < new Date(g.beginTime)) g.beginTime = session.beginTime;
      // Track latest start time (for deletion of multi-session tournaments)
      if (beginTime > new Date(g.lastBeginTime)) g.lastBeginTime = session.beginTime;
    }
  }

  console.log(`📊 Scraper filtering: ${blockedCount} blocked-keyword session(s), ${pastCount} past session(s), ${unsupportedRegionCount} unsupported-region session(s) skipped`);
  console.log(`📋 Grouped into ${Object.keys(groups).length} tournament/region entries`);

  return Object.values(groups);
}

module.exports = { scrapeUpcomingTournaments };

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