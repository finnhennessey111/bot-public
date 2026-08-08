// Verifies buildTournamentGroups' new endTime tracking — the real, scraped tournament-conclusion
// signal players.js's invalidateStaleAfterEvent (and channel-manager.js's endTime-triggered tick)
// depend on. Same "latest wins" shape as the pre-existing lastBeginTime tracking, for the same
// reason: a multi-session tournament (FNCS) isn't truly over until its LAST round ends.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTournamentGroups } = require('../tournament-scraper');

function rawSession(name, { region = 'EU', hoursFromNow = 24, endHoursFromNow = null } = {}) {
  const beginTime = new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
  return {
    key: `${name}-${region}`,
    name,
    titleLower: name.toLowerCase(),
    region,
    beginTime,
    endTime: endHoursFromNow != null ? new Date(Date.now() + endHoursFromNow * 3600_000).toISOString() : null,
    consoleOnly: false,
    platforms: null,
  };
}

test('a single-session tournament carries its real endTime straight through onto the group', () => {
  const session = rawSession('PlayStation Typical Gamer Icon Cup', { hoursFromNow: 24, endHoursFromNow: 27 });
  const groups = buildTournamentGroups([session]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].endTime, session.endTime);
});

test('a session with no endTime (e.g. Fortnite Tracker fallback that never carried one) leaves the group endTime null — fails soft, not a crash', () => {
  const groups = buildTournamentGroups([rawSession('Some Duos Cup', { endHoursFromNow: null })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].endTime, null);
});

test('a multi-session tournament (FNCS) tracks the LATEST endTime across all its rounds, mirroring lastBeginTime', () => {
  const friday = rawSession('FNCS Major 2', { hoursFromNow: 24, endHoursFromNow: 30 });
  const saturday = rawSession('FNCS Major 2', { hoursFromNow: 48, endHoursFromNow: 54 });
  const sunday = rawSession('FNCS Major 2', { hoursFromNow: 72, endHoursFromNow: 78 }); // real last-round end

  const groups = buildTournamentGroups([friday, saturday, sunday]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].endTime, sunday.endTime, 'must be the LAST round\'s conclusion, not the first round\'s');
  assert.equal(groups[0].lastBeginTime, sunday.beginTime, 'sanity check: mirrors the existing lastBeginTime tracking');
});

test('a multi-session tournament where only some sessions carry a real endTime still picks up the latest one that IS known, rather than being wiped to null', () => {
  const friday = rawSession('FNCS Major 2', { hoursFromNow: 24, endHoursFromNow: 30 });
  const saturday = rawSession('FNCS Major 2', { hoursFromNow: 48, endHoursFromNow: null }); // missing endTime for this round only

  const groups = buildTournamentGroups([friday, saturday]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].endTime, friday.endTime, 'a later session missing endTime must not erase an earlier, already-known one');
});

test('sessions out of chronological order are still tracked correctly (latest endTime wins regardless of input order)', () => {
  const saturday = rawSession('FNCS Major 2', { hoursFromNow: 48, endHoursFromNow: 54 });
  const friday = rawSession('FNCS Major 2', { hoursFromNow: 24, endHoursFromNow: 30 });

  const groups = buildTournamentGroups([saturday, friday]); // saturday (later) processed first
  assert.equal(groups.length, 1);
  assert.equal(groups[0].endTime, saturday.endTime);
});
