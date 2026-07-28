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
// Applies identically regardless of which source (official schedule or Fortnite Tracker) produced
// the raw session.
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

// Regions we support — also exactly the fortnite.com/competitive/schedule?region= values for
// these three (confirmed against a live scrape's region-selector footer).
const SUPPORTED_REGIONS = ['EU', 'NAC', 'ME'];

const SCHEDULE_MAX_ATTEMPTS = 3;
const SCHEDULE_RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// Shared grouping/filtering — takes a flat array of raw sessions (one per tournament/window/
// region combination, regardless of which source produced them) and applies the exact same
// blocked-keyword filter, same-day collapse, and past/region filter + final grouping either
// source goes through. Keeping this source-agnostic guarantees the official schedule and Fortnite
// Tracker paths classify isTrios/isMultiSession/isPermanent/consoleOnly identically for the same
// title, rather than each having its own subtly different logic.
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
    // instead. Confirmed against real titles (not slugs): the Last Chance Qualifier's actual title
    // is "FNCS Major 2 Last Chance Qualifier" — a plain 'fncs'+'major' check (the previous version
    // of this logic) wrongly excluded it, since "Major 2" is just part of its real name, not an
    // indicator it's restricted. 'finals' covers the Grand Finals too (whether branded "FNCS Grand
    // Finals" or the fully-spelled-out "Fortnite Championship Series ... Finals") without needing
    // a separate check for that alternate branding.
    const isFncsFinals = session.titleLower.includes('fncs') && session.titleLower.includes('finals');
    const isFncsHeats = session.titleLower.includes('fncs') && session.titleLower.includes('heats');
    if (blockedMatch || isFncsFinals || isFncsHeats) {
      blockedCount++;
      continue;
    }
    // Real scrapes have shown entries whose only visible title text is the build-mode label
    // itself (e.g. a generic "Battle Royale" or "Zero Build" ranked queue with no cup/event name
    // attached) — every 'fncs'/BLOCKED_KEYWORDS check above is title-content-based and lets these
    // straight through, and buildChannelName (channel-manager.js) would turn one into a channel
    // literally named "battle-royale"/"zero-build" with no way for players to tell which
    // tournament it's for. A build-mode label alone is never a valid channel name, so drop these
    // here — the single place both scrape sources funnel through — rather than in each source.
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

// ---------------------------------------------------------------------------------------------
// Source 1 (tried first): fortnite.com/competitive/schedule?region=X — Epic's own official
// calendar. Confirmed via real Puppeteer testing not to be hard-blocked, just inconsistent (some
// rotating-proxy exit IPs get a Cloudflare 403, others get a clean 200) — hence the retry loop.
// The page is a server-rendered React Router app; its embedded loader data is React Router's
// internal "turbo-stream" streaming format (undocumented, tied to the framework's internal
// version — not a stable contract), so this deliberately does NOT attempt to decode that. Instead
// it reads the same rendered text a visitor sees (document.body.innerText), which is what the
// grammar below parses.
// ---------------------------------------------------------------------------------------------

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const isWeekdayLine = l => /^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)$/.test(l);
const isDateLine = l => /^[A-Za-z]+ \d{1,2}, \d{4}$/.test(l);
const isTimeLine = l => /^\d{1,2}:\d{2} (AM|PM)$/i.test(l);
const isRoundLabelLine = l => /^(WEEK|SESSION) \d+( - ROUND \d+)?$/.test(l);

// Combines a "July 13, 2026" + "5:00 PM" pair into an ISO UTC timestamp. Only valid because the
// scraper forces page.emulateTimezone('UTC') before navigating — confirmed via a real 3-way
// comparison (system-default / forced-UTC / forced-America/Los_Angeles) that this page formats
// times client-side using the browser's timezone (LA came back a consistent 7 hours behind UTC on
// every entry), so forcing UTC makes the displayed time a genuine UTC value rather than a guess.
function combineDateAndTime(dateLine, timeLine) {
  const dateMatch = dateLine.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
  const timeMatch = timeLine.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/i);
  if (!dateMatch || !timeMatch) return null;

  const monthIndex = MONTH_NAMES.indexOf(dateMatch[1].toLowerCase());
  if (monthIndex === -1) return null;
  const day = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);

  let hour = Number(timeMatch[1]) % 12;
  if (/pm/i.test(timeMatch[3])) hour += 12;
  const minute = Number(timeMatch[2]);

  return new Date(Date.UTC(year, monthIndex, day, hour, minute)).toISOString();
}

// Visible text alone can't distinguish two entries that render identically but link to different
// events — confirmed real case: "PlayStation Typical Gamer Icon Cup" appears with byte-identical
// visible text for both its Battle Royale and Zero Build variants, and for its Qualifier vs.
// (players-only) Final rounds. The distinguishing info only exists in each entry's <a href>, e.g.:
//   .../events/S41_PSTypicalGamer_ZB?round=S41_PSTypicalGamer_ZB_Qualifier_EU
//   .../events/S41_PSTypicalGamer?round=S41_PSTypicalGamer_Qualifier_EU
//   .../events/S41_PSTypicalGamer?round=S41_PSTypicalGamer_Final_EU
// so fetchOfficialScheduleBodyTextOnce also collects every /events/ anchor's href, in document
// order, alongside the plain rendered text.

// Some entries render TWO anchors for the same visual card (confirmed against a real page:
// whenever a leaderboard player-name sub-line is present, its own text is wrapped in a second,
// identical-href anchor right next to the round's own — the grammar's own note that the player-
// name line is present on some entries and absent on others matches exactly where these
// duplicates show up). Collapsing only *consecutive* duplicates (not all duplicates — a genuinely
// repeated event later in the list, e.g. the same Ranked Cup round appearing again on a different
// day, must stay) is what realigns this array 1:1 with parseScheduleBodyText's text-block count.
// Confirmed on a real EU scrape: 105 raw anchors, 76 after this collapse — exactly matching the 76
// parsed text entries that scrape produced. Without this, hrefs silently correlate to the wrong
// text entry from the first duplicate onward, which is what was causing "PlayStation Typical
// Gamer Icon Cup"'s Battle Royale round to get some unrelated tournament's href (never matching
// the Zero Build detection below) instead of its own.
function dedupeConsecutiveHrefs(hrefs) {
  const deduped = [];
  for (const href of hrefs) {
    if (deduped[deduped.length - 1] !== href) deduped.push(href);
  }
  return deduped;
}

// Pulls the `round=` query value out of an event href, e.g. "S41_PSTypicalGamer_Qualifier_EU".
function parseRoundSlug(href) {
  if (!href) return null;
  const match = href.match(/[?&]round=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Only "Final"/"Finals" is confirmed restricted-to-qualified-players vocabulary so far. Rather
// than an allowlist of confirmed "open" words (Qualifier is confirmed, but there may be other
// open-round vocabulary — "Opens", numbered "EventNRoundM" — we haven't seen a real example of
// yet), this blocks only the confirmed-restricted case and defaults everything else to open. An
// allowlist would risk silently excluding a legitimate open round using vocabulary we haven't
// observed; this blocklist risks the opposite (a restricted round we haven't seen slips through) —
// if production logs turn up another restricted-round keyword, add it here.
function isFinalRoundSlug(roundSlug) {
  return !!roundSlug && /final/i.test(roundSlug);
}

// "_ZB" appears in both the /events/{slug} path and the round slug for Zero Build variants in the
// confirmed real examples — checking the whole href catches either.
function detectBuildMode(href) {
  if (!href) return null;
  return /_zb(_|\?|$)/i.test(href) ? 'ZB' : null;
}

// True if the visible name already spells out a build mode some other way (e.g. "Duos Ranked Cup
// (Zero Build)", "Console Solo Victory Cup (ZB)") — so the href-derived suffix below is only
// appended when the visible text genuinely has no distinguishing marker of its own.
function hasBuildModeMarker(nameLower) {
  return /battle royale|zero build|\bzb\b/.test(nameLower);
}

// True if, once every build-mode word/abbreviation is stripped out, nothing recognizable is left —
// i.e. the title IS a build-mode label and nothing else (e.g. "Battle Royale", "Zero Build (ZB)"),
// as opposed to a real tournament name that merely mentions a build mode ("Solo Ranked Cup (Battle
// Royale)"). Exported so channel-manager.js can use it as a last-resort guard right before channel
// creation too, in case a future scrape source feeds buildTournamentGroups something this stage-1
// filter didn't catch.
function isBareBuildModeLabel(nameLower) {
  const stripped = nameLower
    .replace(/\(?\s*battle royale\s*\)?/gi, ' ')
    .replace(/\(?\s*zero build\s*\)?/gi, ' ')
    .replace(/\bbr\b|\bzb\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, '');
  return stripped.length === 0;
}

// Grammar (confirmed against real rendered output, not assumed):
//   WEEKDAY_LINE   → "MONDAY" | "TUESDAY" | ...
//   DATE_LINE      → "July 13, 2026"
//   then repeating:
//     TIME_LINE      → "5:00 PM"
//     ROUND_LABEL    → "WEEK 5 - ROUND 1" | "SESSION 2 - ROUND 4" | "SESSION 1" (round-less form)
//     EVENT_NAME     → free text, e.g. "FNCS Division 1", "Solo Ranked Cup (Battle Royale)"
//     [PLAYER_NAME]  → optional leaderboard-name line, present on some entries and absent on
//                      others (seemingly depending on whether leaderboard data exists for that
//                      entry, not on tournament type) — resolved via lookahead, not guessed: a
//                      genuine next entry always starts with another TIME_LINE or a new
//                      WEEKDAY_LINE, so anything else in that slot must be a name line to skip.
//
// eventLinks is the array of {href} for every /events/ anchor on the page, in document order.
// Each successfully-parsed text entry is correlated positionally with the next unused eventLinks
// entry — the Nth entry-shaped text block corresponds to the Nth anchor. This is only trusted when
// the final counts actually line up (checked at the end); a mismatch means the "one anchor per
// entry" assumption didn't hold for this scrape, and mis-attributing hrefs would be worse than
// just not having slug data at all, so it's logged loudly rather than silently trusted.
function parseScheduleBodyText(bodyText, region, eventLinks = []) {
  const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
  const rawSessions = [];
  let i = 0;
  let skippedEntries = 0;
  let droppedFinalCount = 0;
  let linkIndex = 0;

  while (i < lines.length) {
    if (!isWeekdayLine(lines[i])) {
      i++; // stray header/footer/nav content — skip and keep looking for a day block
      continue;
    }
    i++; // consume weekday line — not otherwise needed, the date line has year/month/day

    if (i >= lines.length || !isDateLine(lines[i])) {
      continue; // malformed day header — resync from here rather than aborting the whole parse
    }
    const dateLine = lines[i];
    i++;

    while (i < lines.length && isTimeLine(lines[i])) {
      const timeLine = lines[i];
      i++;

      if (i >= lines.length || !isRoundLabelLine(lines[i])) {
        skippedEntries++;
        break; // malformed entry — stop this day's entries, outer loop resyncs on the next line
      }
      i++; // consume round label — only used here as a grammar anchor, not stored on the session

      if (i >= lines.length) {
        skippedEntries++;
        break;
      }
      const eventName = lines[i];
      i++;

      // Optional trailing player-name line.
      if (i < lines.length && !isTimeLine(lines[i]) && !isWeekdayLine(lines[i])) {
        i++;
      }

      // This text block is entry-shaped regardless of whether beginTime/name end up valid below,
      // so it consumes a link slot now — keeping link correlation in lockstep with "an entry was
      // found" rather than with "an entry was kept".
      const link = eventLinks[linkIndex];
      linkIndex++;

      const beginTime = combineDateAndTime(dateLine, timeLine);
      const baseName = eventName.trim();
      if (!beginTime || !baseName) {
        skippedEntries++;
        continue;
      }

      // Build-mode tagging is deferred to a second pass below (needs every entry's baseName+
      // buildMode collected first) — see that pass's comment for why. Only Final-round filtering
      // happens here, since dropped entries must never count toward "does this name have a ZB
      // sibling" either.
      let buildMode = null;
      if (link) {
        const roundSlug = parseRoundSlug(link.href);
        if (isFinalRoundSlug(roundSlug)) {
          droppedFinalCount++;
          continue; // restricted to already-qualified players — never eligible for a queue channel
        }
        buildMode = detectBuildMode(link.href);
      }

      rawSessions.push({ baseName, buildMode, region, beginTime });
    }
  }

  if (eventLinks.length > 0 && linkIndex !== eventLinks.length) {
    console.warn(`⚠️ [official-schedule:${region}] event-link count (${eventLinks.length}) didn't match parsed-entry count (${linkIndex}) — href correlation may be misaligned this cycle, so Final-round filtering and build-mode detection may be unreliable until this is investigated`);
  }
  if (skippedEntries > 0) {
    console.warn(`⚠️ [official-schedule:${region}] skipped ${skippedEntries} entry/entries that didn't match the expected time/round/name grammar`);
  }
  if (droppedFinalCount > 0) {
    console.log(`🔒 [official-schedule:${region}] excluded ${droppedFinalCount} Final-round session(s) from channel eligibility (restricted to already-qualified players)`);
  }

  // Some tournaments render byte-identical visible text for both their Battle Royale and Zero
  // Build variants (hasBuildModeMarker's doc comment) — detectBuildMode only ever recognizes the
  // ZB one explicitly (its href contains "_ZB"), so a same-named sibling entry with no marker at
  // all used to just stay untagged, producing a genuinely-named but mode-less duplicate channel
  // alongside the correctly-tagged ZB one. Confirmed against a real scrape: "PlayStation Typical
  // Gamer Icon Cup"'s Zero Build round's href has "_ZB"; its Qualifier (Battle Royale) round's
  // href has no build-mode marker whatsoever. The fix: a same-region entry with no marker is only
  // inferred as Battle Royale when a same-named ZB sibling actually exists (proving this name
  // really is mode-split) — every *other* tournament (FNCS, Ranked Cup Duos, etc., which never
  // splits by mode at all) is left exactly as-is, untagged, same as always.
  const namesWithZbSibling = new Set(rawSessions.filter(s => s.buildMode === 'ZB').map(s => s.baseName));

  const finalSessions = rawSessions.map(session => {
    let name = session.baseName;
    const nameLower = name.toLowerCase();

    if (session.buildMode === 'ZB' && !hasBuildModeMarker(nameLower)) {
      // Appended in full-word form so it reads naturally and so buildChannelName's abbreviation
      // step shortens it the same way it would any other organically-worded "(Zero Build)" title.
      name = `${name} (Zero Build)`;
    } else if (session.buildMode !== 'ZB' && namesWithZbSibling.has(session.baseName) && !hasBuildModeMarker(nameLower)) {
      name = `${name} (Battle Royale)`;
      console.log(`🏷️ [official-schedule:${session.region}] "${session.baseName}" has a Zero Build sibling — inferred this entry as Battle Royale (its own href had no build-mode marker)`);
    }

    return {
      key: `${name}-${session.region}`,
      name,
      titleLower: name.toLowerCase(),
      region: session.region,
      beginTime: session.beginTime,
      // No structured platform metadata on this source (unlike Tracker's platformGroups) — the
      // title itself spells out "Console"/"PlayStation" etc. when relevant, so fall back to a
      // keyword check. False (not console-restricted) is the safe default when ambiguous, same
      // as Tracker's own default for anything that isn't a clean single-platform-Console match.
      consoleOnly: /\bconsole\b/i.test(name),
      platforms: null,
    };
  });

  return finalSessions;
}

async function fetchOfficialScheduleBodyTextOnce(region) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyLaunchArgs()],
  });

  try {
    const page = await browser.newPage();
    await authenticatePage(page);
    await page.emulateTimezone('UTC');
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const url = `https://www.fortnite.com/competitive/schedule?region=${region}`;
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const status = response.status();
    const { bodyText, rawHrefs } = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/events/"]'))
        .filter(a => (a.getAttribute('href') || '').includes('round='));
      return {
        bodyText: document.body.innerText,
        rawHrefs: anchors.map(a => a.getAttribute('href') || ''),
      };
    });
    const eventLinks = dedupeConsecutiveHrefs(rawHrefs).map(href => ({ href }));
    return { status, bodyText, eventLinks };
  } finally {
    await browser.close();
  }
}

// Retries up to 3 attempts total on 403/timeout/no-parseable-data before giving up on this
// region — a rotating proxy gets a different exit IP each attempt, and some IPs get through
// cleanly. An HTTP 200 with 0 parseable sessions (e.g. a challenge/interstitial page) is treated
// as a failure to retry too, not a false success — otherwise a bad response could silently poison
// this region's data instead of triggering the fallback that's supposed to catch exactly this.
async function fetchOfficialScheduleRegion(region) {
  for (let attempt = 1; attempt <= SCHEDULE_MAX_ATTEMPTS; attempt++) {
    let result;
    try {
      result = await fetchOfficialScheduleBodyTextOnce(region);
    } catch (err) {
      console.log(`  [official-schedule:${region}] attempt ${attempt}/${SCHEDULE_MAX_ATTEMPTS} threw: ${err.message}`);
      if (attempt < SCHEDULE_MAX_ATTEMPTS) {
        await sleep(SCHEDULE_RETRY_DELAY_MS);
        continue;
      }
      throw new Error(`official schedule fetch for ${region} failed after ${SCHEDULE_MAX_ATTEMPTS} attempts (last error: ${err.message})`);
    }

    const sessions = parseScheduleBodyText(result.bodyText, region, result.eventLinks);
    if (result.status === 200 && sessions.length > 0) {
      console.log(`  [official-schedule:${region}] attempt ${attempt}/${SCHEDULE_MAX_ATTEMPTS} succeeded: HTTP 200, ${sessions.length} raw session(s) parsed`);
      return sessions;
    }

    console.log(`  [official-schedule:${region}] attempt ${attempt}/${SCHEDULE_MAX_ATTEMPTS} did not yield usable data (HTTP ${result.status}, ${sessions.length} session(s) parsed)`);
    if (attempt < SCHEDULE_MAX_ATTEMPTS) await sleep(SCHEDULE_RETRY_DELAY_MS);
  }
  throw new Error(`official schedule fetch for ${region} failed after ${SCHEDULE_MAX_ATTEMPTS} attempts to return usable data`);
}

// Fetches every supported region in turn. Fails fast: if any single region can't be fetched after
// its own 3 attempts, this throws immediately rather than trying the rest — the caller's response
// to that failure is to fall back to Fortnite Tracker for ALL regions, so there's no benefit to
// spending more proxy requests on the remaining regions first.
async function scrapeOfficialSchedule() {
  const allSessions = [];
  for (const region of SUPPORTED_REGIONS) {
    const sessions = await fetchOfficialScheduleRegion(region);
    allSessions.push(...sessions);
  }
  return allSessions;
}

// ---------------------------------------------------------------------------------------------
// Source 2 (fallback): fortnitetracker.com/events — the original source, used only when the
// official schedule can't be fetched for one or more regions after retries.
// ---------------------------------------------------------------------------------------------

// Shared page-fetch + extraction: loads the events page and pulls out the raw `imp_calendar`
// JSON blob.
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
//
// Tries the official fortnite.com schedule first; if it can't be fetched for every supported
// region (each with its own retries), falls back to the Fortnite Tracker scrape entirely — so the
// official source becoming unavailable never means tournaments stop getting picked up.
async function scrapeUpcomingTournaments() {
  try {
    const rawSessions = await scrapeOfficialSchedule();
    console.log(`📡 Using OFFICIAL schedule source (fortnite.com/competitive/schedule) — ${rawSessions.length} raw session(s) across ${SUPPORTED_REGIONS.length} region(s)`);
    return buildTournamentGroups(rawSessions);
  } catch (err) {
    console.log(`⚠️ Official schedule source unavailable (${err.message}) — falling back to FORTNITE TRACKER`);
    return await scrapeTrackerCalendar();
  }
}

module.exports = {
  scrapeUpcomingTournaments, buildTournamentGroups, isBareBuildModeLabel,
  parseScheduleBodyText, dedupeConsecutiveHrefs,
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
