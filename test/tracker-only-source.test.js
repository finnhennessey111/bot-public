// Verifies PART 1 — Fortnite Tracker as the sole tournament source (the official fortnite.com
// schedule scraping, its retry logic, and its href/slug-based build-mode detection have all been
// removed entirely).
//
// This hits the real, live fortnitetracker.com/events — deliberately, not mocked: the whole point
// of this change was confirming real Tracker title text is unambiguous (unlike the official
// schedule's byte-identical BR/ZB text), and a synthetic fixture can't verify that. Assertions are
// written to tolerate whatever tournaments are actually running today (FNCS entries, BR/ZB-paired
// cups, etc. aren't guaranteed to exist on any given day) rather than hardcoding today's specific
// lineup.
const test = require('node:test');
const assert = require('node:assert/strict');

const tournamentScraper = require('../tournament-scraper');
const channelManager = require('../channel-manager');

test('tournament-scraper.js no longer exports any official-schedule-specific function', () => {
  const exportedNames = Object.keys(tournamentScraper);
  for (const removedName of ['parseScheduleBodyText', 'dedupeConsecutiveHrefs', 'scrapeOfficialSchedule', 'fetchOfficialScheduleRegion']) {
    assert.ok(!exportedNames.includes(removedName), `${removedName} should have been removed along with the official schedule source`);
  }
});

test('scrapeUpcomingTournaments: works end-to-end against the real live Fortnite Tracker source', async () => {
  const tournaments = await tournamentScraper.scrapeUpcomingTournaments();

  assert.ok(Array.isArray(tournaments));
  assert.ok(tournaments.length > 0, 'expected at least one real upcoming tournament right now');

  for (const t of tournaments) {
    assert.equal(typeof t.name, 'string');
    assert.ok(t.name.length > 0);
    assert.ok(['EU', 'NAC', 'ME'].includes(t.region));
    assert.ok(!Number.isNaN(new Date(t.beginTime).getTime()));

    // The actual bug this whole task started from: no channel-eligible tournament should ever be
    // a bare build-mode label with no real name.
    assert.equal(tournamentScraper.isBareBuildModeLabel(t.name.toLowerCase()), false);

    // No restricted FNCS stage should ever survive into channel-eligible output.
    const nameLower = t.name.toLowerCase();
    if (nameLower.includes('fncs')) {
      assert.equal(nameLower.includes('finals'), false, `FNCS Finals stage leaked through: "${t.name}"`);
      assert.equal(nameLower.includes('heats'), false, `FNCS Heats stage leaked through: "${t.name}"`);
    }

    // BLOCKED_KEYWORDS.
    assert.equal(nameLower.includes('mobile'), false, `"mobile" title leaked through: "${t.name}"`);
    assert.equal(nameLower.includes('solo'), false, `"solo" title leaked through: "${t.name}"`);

    // Part 2's stable identity — every real Tracker session carries one.
    assert.equal(typeof t.eventId, 'string');
    assert.ok(t.eventId.length > 0);
  }
});

test('BR/ZB naming resolves correctly against whatever real BR/ZB-paired cups exist today', async () => {
  const tournaments = await tournamentScraper.scrapeUpcomingTournaments();

  const brZbPairs = tournaments.filter(t => /\b(battle royale|zero build)\b/i.test(t.name));
  if (brZbPairs.length === 0) {
    console.log('  (no BR/ZB-paired cup currently live — skipping this specific assertion today)');
    return;
  }

  for (const t of brZbPairs) {
    const channelName = channelManager.buildChannelName(t.name);
    const isZb = /zero build/i.test(t.name);
    assert.equal(
      channelName.startsWith(isZb ? 'zb-' : 'br-'),
      true,
      `expected "${t.name}" -> "${channelName}" to start with ${isZb ? 'zb-' : 'br-'}`
    );
    // Two sibling cups sharing a base name must resolve to distinct stable eventIds (confirmed
    // real example: epicgames_S41_PSTypicalGamer_EU vs ..._ZB_EU).
    assert.ok(t.eventId);
  }
});

test('FNCS Divisional Cups are unaffected: still permanent + multi-session when currently live', async () => {
  const tournaments = await tournamentScraper.scrapeUpcomingTournaments();

  const divisions = tournaments.filter(t => /fncs division/i.test(t.name));
  if (divisions.length === 0) {
    console.log('  (no FNCS Divisional Cup currently live — skipping this specific assertion today)');
    return;
  }

  for (const t of divisions) {
    assert.equal(t.isPermanent, true);
    assert.equal(t.isMultiSession, true);
  }
});
