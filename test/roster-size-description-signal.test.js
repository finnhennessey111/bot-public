// Verifies the third roster-size signal: a tournament's own Fortnite Tracker event page
// description sometimes states team size in plain text even when the title doesn't. Confirmed
// against real live data — "Champion Aphrodite FNCS Cup"'s title has no team-size word, but its
// page's meta description reads "...Duo up and compete...", while "PlayStation Typical Gamer Icon
// Cup" (already in roster-size.js's manual override map) has no such wording in its description.
//
// buildTournamentGroups itself must stay fully synchronous (unchanged) — 3 existing test files
// (test/br-zb-fixes.test.js, test/console-only-flow.test.js, test/fncs-exclusion.test.js) call it
// directly and assert on an immediate array return; making it async would break all of them. The
// new signal lives entirely in enrichWithDescriptionRosterSize, an async post-processing step only
// scrapeTrackerCalendar (already async) runs.
const test = require('node:test');
const assert = require('node:assert/strict');

const tournamentScraper = require('../tournament-scraper');
const { buildTournamentGroups, enrichWithDescriptionRosterSize } = tournamentScraper;

function rawSession(name, { region = 'EU', eventId = null } = {}) {
  const beginTime = new Date(Date.now() + 3600_000).toISOString();
  return { key: `${name}-${region}`, name, titleLower: name.toLowerCase(), region, beginTime, consoleOnly: false, platforms: ['PC'], eventId };
}

test('buildTournamentGroups stays synchronous and now also carries the raw (possibly-null) rosterSize alongside isTrios', () => {
  const groups = buildTournamentGroups([
    rawSession('Some Duos Cup'),
    rawSession('Champion Aphrodite FNCS Cup', { eventId: 'evt_aphrodite' }),
  ]);

  assert.equal(groups.length, 2, 'must return a plain array synchronously, not a Promise');
  const duos = groups.find(g => g.name === 'Some Duos Cup');
  assert.equal(duos.rosterSize, 2);
  assert.equal(duos.isTrios, false);

  const aphrodite = groups.find(g => g.name === 'Champion Aphrodite FNCS Cup');
  assert.equal(aphrodite.rosterSize, null, 'no team-size keyword in the title and not in the override map — must stay unclassified at this stage');
  assert.equal(aphrodite.isTrios, false);
});

test('enrichWithDescriptionRosterSize: resolves an unclassified group via its description, leaves an already-classified one untouched (no fetch attempted)', async () => {
  const calls = [];
  const original = tournamentScraper.fetchEventDescriptionRosterSize;
  tournamentScraper.fetchEventDescriptionRosterSize = async (eventId) => {
    calls.push(eventId);
    return eventId === 'evt_aphrodite' ? 2 : null; // simulates the real "...Duo up..." description
  };

  try {
    const groups = buildTournamentGroups([
      rawSession('Some Duos Cup', { eventId: 'evt_duos' }),
      rawSession('Champion Aphrodite FNCS Cup', { eventId: 'evt_aphrodite' }),
    ]);

    const enriched = await enrichWithDescriptionRosterSize(groups);

    assert.deepEqual(calls, ['evt_aphrodite'], 'must only fetch a description for the group the title left unclassified — never re-derive one the title already resolved');

    const aphrodite = enriched.find(g => g.name === 'Champion Aphrodite FNCS Cup');
    assert.equal(aphrodite.rosterSize, 2, 'resolved to duos via its description');
    assert.equal(aphrodite.isTrios, false);

    const duos = enriched.find(g => g.name === 'Some Duos Cup');
    assert.equal(duos.rosterSize, 2, 'unchanged — was already resolved by title alone');
  } finally {
    tournamentScraper.fetchEventDescriptionRosterSize = original;
  }
});

test('enrichWithDescriptionRosterSize: a description with no team-size wording (or a fetch that fails) leaves the group unclassified, same as before this signal existed', async () => {
  const original = tournamentScraper.fetchEventDescriptionRosterSize;
  tournamentScraper.fetchEventDescriptionRosterSize = async () => null; // e.g. "PlayStation Typical Gamer Icon Cup"'s real description — no duo/solo/trio/squad wording

  try {
    const groups = buildTournamentGroups([rawSession('Some Unclassified Skin Cup', { eventId: 'evt_skin' })]);
    const enriched = await enrichWithDescriptionRosterSize(groups);

    assert.equal(enriched[0].rosterSize, null);
    assert.equal(enriched[0].isTrios, false, 'stays non-trios (the existing default), never crashes or guesses');
  } finally {
    tournamentScraper.fetchEventDescriptionRosterSize = original;
  }
});

test('enrichWithDescriptionRosterSize: skips groups with no eventId at all — nothing to fetch a description for', async () => {
  let called = false;
  const original = tournamentScraper.fetchEventDescriptionRosterSize;
  tournamentScraper.fetchEventDescriptionRosterSize = async () => { called = true; return 2; };

  try {
    const groups = buildTournamentGroups([rawSession('No Event Id Cup', { eventId: null })]);
    await enrichWithDescriptionRosterSize(groups);
    assert.equal(called, false);
  } finally {
    tournamentScraper.fetchEventDescriptionRosterSize = original;
  }
});

test('enrichWithDescriptionRosterSize: one group\'s fetch throwing is logged and skipped, never aborts the rest of the batch', async () => {
  const original = tournamentScraper.fetchEventDescriptionRosterSize;
  tournamentScraper.fetchEventDescriptionRosterSize = async (eventId) => {
    if (eventId === 'evt_fails') throw new Error('navigation timeout');
    return 3; // second group resolves fine
  };

  try {
    const groups = buildTournamentGroups([
      rawSession('Failing Fetch Cup', { eventId: 'evt_fails' }),
      rawSession('Succeeding Fetch Cup', { eventId: 'evt_succeeds' }),
    ]);
    const enriched = await enrichWithDescriptionRosterSize(groups);

    assert.equal(enriched.find(g => g.name === 'Failing Fetch Cup').rosterSize, null, 'a failed fetch must not crash — just stays unclassified');
    assert.equal(enriched.find(g => g.name === 'Succeeding Fetch Cup').rosterSize, 3, 'the OTHER group in the same batch must still resolve normally');
    assert.equal(enriched.find(g => g.name === 'Succeeding Fetch Cup').isTrios, true);
  } finally {
    tournamentScraper.fetchEventDescriptionRosterSize = original;
  }
});

test('LIVE: fetchEventDescriptionRosterSize against the real Fortnite Tracker page confirms the exact scenario this signal was built for', async () => {
  // Champion Aphrodite FNCS Cup's real eventId (confirmed live, 2026-07-31) — title has no
  // team-size word, but its real page description says "...Duo up and compete...".
  const aphrodite = await tournamentScraper.fetchEventDescriptionRosterSize('epicgames_S41_FNCSCommunityCup_EU');
  assert.equal(aphrodite, 2, 'the real Aphrodite Cup page must resolve to duos via its description');

  // PlayStation Typical Gamer Icon Cup — already in the manual override map specifically because
  // its description has no team-size wording either; confirms this signal correctly finds nothing
  // rather than guessing.
  const typicalGamer = await tournamentScraper.fetchEventDescriptionRosterSize('epicgames_S41_PSTypicalGamer_EU');
  assert.equal(typicalGamer, null, 'the real Typical Gamer Cup description has no duo/solo/trio/squad wording — must resolve to null, not a guess');
});
