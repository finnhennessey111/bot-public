const puppeteer = require('puppeteer');

// Skip these entirely when creating queue channels (scrapeUpcomingTournaments) — ranked cups
// still don't get channels even though they now appear on the calendar.
const BLOCKED_KEYWORDS = [
  'ranked cup',
  'mobile series',
  'mobile cup',
  'play-ins',
  'play ins',
  'heats',
  'finals',
];

// These are multi-session — keep one channel alive until last session ends
const MULTI_SESSION_KEYWORDS = [
  'fncs',
  'fortnite performance evaluation',
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

async function scrapeUpcomingTournaments() {
  const rawCalendar = await fetchRawCalendar();

  if (!rawCalendar) {
    console.log('❌ Could not find calendar data');
    return [];
  }

  console.log(`📡 Scraper fetched ${rawCalendar.length} raw calendar entries`);

  // Group by name + region to handle multi-session tournaments
  // groups[name-region] = { ...tournament, allBeginTimes: [] }
  const groups = {};
  let blockedCount = 0;
  let pastCount = 0;
  let unsupportedRegionCount = 0;

  for (const entry of rawCalendar) {
    const title = entry.customData?.title?.trim() ?? '';
    const titleLower = title.toLowerCase();
    const windows = entry.customData?.windows ?? [];

    // Skip blocked tournament types
    const blockedMatch = BLOCKED_KEYWORDS.find(k => titleLower.includes(k));
    if (blockedMatch) {
      blockedCount++;
      continue;
    }

    for (const window of windows) {
      const regions = window.regions ?? [];
      const platforms = window.platformGroups ?? [];
      const beginTime = new Date(window.beginTime);
      const now = new Date();

      // Skip past tournaments
      if (beginTime < now) {
        pastCount++;
        continue;
      }

      for (const region of regions) {
        if (!SUPPORTED_REGIONS.includes(region)) {
          unsupportedRegionCount++;
          continue;
        }

        const key = `${title}-${region}`;
        const consoleOnly = platforms.length === 1 && platforms[0] === 'Console';
        const isTrios = titleLower.includes('trio');
        const isMultiSession = MULTI_SESSION_KEYWORDS.some(k => titleLower.includes(k));

        if (!groups[key]) {
          groups[key] = {
            name: title,
            region,
            beginTime: window.beginTime,
            lastBeginTime: window.beginTime,
            consoleOnly,
            isTrios,
            isMultiSession,
            platforms,
          };
        } else {
          // Track earliest start time (for channel creation)
          if (beginTime < new Date(groups[key].beginTime)) {
            groups[key].beginTime = window.beginTime;
          }
          // Track latest start time (for deletion of multi-session tournaments)
          if (beginTime > new Date(groups[key].lastBeginTime)) {
            groups[key].lastBeginTime = window.beginTime;
          }
        }
      }
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