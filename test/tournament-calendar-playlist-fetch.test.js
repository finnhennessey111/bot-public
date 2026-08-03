// Verifies #1 (scrape only what's needed) for tournament-scraper.js's calendar fetch: instead of
// one unfiltered fetch of every event/playlist and discarding most of it client-side, it now issues
// one real Tracker-confirmed request per config.ftCalendarPlaylists entry (duos, trios — see
// config.js's doc comment; playlist=trios confirmed against a real, live Tracker profile URL), each
// with competitive=pr, and merges the results — rather than guessing at an unconfirmed value.
//
// Same puppeteer.launch stubbing precedent as test/tournament-scraper-browser-close.test.js — no
// real network/Puppeteer, but the real fetchRawCalendar/scrapeTrackerCalendar code path runs
// unmodified, so this proves the actual URLs constructed and the actual merge behavior, not an
// assumption about them.
const test = require('node:test');
const assert = require('node:assert/strict');

const puppeteer = require('puppeteer');
const config = require('../config');
const tournamentScraper = require('../tournament-scraper');

// fetchRawCalendar fires one playlist fetch per config.ftCalendarPlaylists entry CONCURRENTLY
// (Promise.all — see its own doc comment), so each fake browser instance must track its OWN
// navigated URL in its own closure, not a single object shared across every launch — a shared
// "lastUrl" would race between the concurrent fetches and let one clobber the other.
function fakeBrowser(gotoUrls, calendarByUrl) {
  let pageUrl = null;
  return {
    async newPage() {
      return {
        async setUserAgent() {},
        async authenticate() {},
        async setRequestInterception() {},
        on() {},
        async goto(url) {
          pageUrl = url;
          gotoUrls.push(url);
        },
        async evaluate() {
          return calendarByUrl(pageUrl);
        },
      };
    },
    async close() {},
  };
}

test('fetchRawCalendar (via scrapeTrackerCalendar): issues one request per configured playlist, each with competitive=pr', async () => {
  const originalLaunch = puppeteer.launch;
  const gotoUrls = [];
  puppeteer.launch = async () => fakeBrowser(gotoUrls, () => []); // empty imp_calendar is enough to prove the URLs alone

  try {
    await tournamentScraper.scrapeTrackerCalendar();

    assert.equal(gotoUrls.length, config.ftCalendarPlaylists.length, 'one navigation per configured playlist');
    for (const playlist of config.ftCalendarPlaylists) {
      assert.ok(
        gotoUrls.some(u => u.includes(`playlist=${playlist}`) && u.includes('competitive=pr')),
        `expected a request for playlist=${playlist} with competitive=pr among: ${gotoUrls.join(', ')}`
      );
    }
  } finally {
    puppeteer.launch = originalLaunch;
  }
});

test('fetchRawCalendar (via scrapeTrackerCalendar): merges entries from every playlist fetch into one result set', async () => {
  const originalLaunch = puppeteer.launch;
  const gotoUrls = [];

  const duosEntry = { customData: { title: 'Some Duos Cup', windows: [{ regions: ['EU'], platformGroups: [], beginTime: new Date(Date.now() + 86400000).toISOString(), eventId: 'duos-1' }] } };
  const triosEntry = { customData: { title: 'Some Trios Cup', windows: [{ regions: ['EU'], platformGroups: [], beginTime: new Date(Date.now() + 86400000).toISOString(), eventId: 'trios-1' }] } };

  puppeteer.launch = async () => fakeBrowser(gotoUrls, (pageUrl) => {
    if (pageUrl.includes('playlist=duos')) return [duosEntry];
    if (pageUrl.includes('playlist=trios')) return [triosEntry];
    return [];
  });

  try {
    const groups = await tournamentScraper.scrapeTrackerCalendar();
    const names = groups.map(g => g.name);
    assert.ok(names.includes('Some Duos Cup'), `expected the duos-playlist tournament in the merged result: ${names.join(', ')}`);
    assert.ok(names.includes('Some Trios Cup'), `expected the trios-playlist tournament in the merged result: ${names.join(', ')}`);
  } finally {
    puppeteer.launch = originalLaunch;
  }
});

test('config.js: ftCalendarPlaylists is exactly the confirmed-real values this bot needs (duos, trios) — not solo (irrelevant, blocked anyway) or a guess', () => {
  assert.deepEqual(config.ftCalendarPlaylists.slice().sort(), ['duos', 'trios']);
});
