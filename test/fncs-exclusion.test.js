// Verifies the FNCS restricted-stage exclusion rewrite.
//
// Real finding (confirmed from actual scraped title text, not slugs): the Last Chance Qualifier's
// real title is "FNCS Major 2 Last Chance Qualifier" — the previous isFncsMajor check ('fncs' +
// 'major') wrongly excluded it, since "Major 2" is just part of its real name, not an indicator
// it's restricted. That check (and the separate, unconfirmed isFncsGrandFinals "Fortnite
// Championship Series" check) is replaced entirely by two simpler, confirmed-correct rules:
// 'fncs'+'finals' and 'fncs'+'heats'. 'mobile'/'solo' were already present in BLOCKED_KEYWORDS
// (confirmed by reading the file — nothing to add there).
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTournamentGroups } = require('../tournament-scraper');

function rawSession(name, region = 'EU', hoursFromNow = 24) {
  const beginTime = new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
  return {
    key: `${name}-${region}`,
    name,
    titleLower: name.toLowerCase(),
    region,
    beginTime,
    consoleOnly: false,
    platforms: null,
  };
}

test('FNCS Major 2 Last Chance Qualifier: survives (the actual bug this fixes) and keeps its real name', () => {
  const groups = buildTournamentGroups([rawSession('FNCS Major 2 Last Chance Qualifier')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'FNCS Major 2 Last Chance Qualifier');
});

test('an FNCS title containing "finals" is excluded (covers Grand Finals under any branding)', () => {
  const groups = buildTournamentGroups([
    rawSession('FNCS Grand Finals'),
    rawSession('FNCS Major 2 Finals'),
  ]);
  assert.equal(groups.length, 0);
});

test('an FNCS title containing "heats" is excluded', () => {
  const groups = buildTournamentGroups([rawSession('FNCS Major 2 Heats')]);
  assert.equal(groups.length, 0);
});

test('a title containing "mobile" is excluded', () => {
  const groups = buildTournamentGroups([rawSession('Mobile Series Open')]);
  assert.equal(groups.length, 0);
});

test('a title containing "solo" is excluded', () => {
  const groups = buildTournamentGroups([rawSession('Solo Victory Cup')]);
  assert.equal(groups.length, 0);
});

test('FNCS Divisional Cup handling is unaffected: survives, multi-session, and permanent', () => {
  const groups = buildTournamentGroups([rawSession('FNCS Division 1')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'FNCS Division 1');
  assert.equal(groups[0].isMultiSession, true); // MULTI_SESSION_KEYWORDS: 'fncs'
  assert.equal(groups[0].isPermanent, true); // PERMANENT_KEYWORDS: 'fncs division'
});

test('a regular FNCS Major stage that is neither Finals nor Heats (e.g. Last Chance Qualifier) is not caught by an overly broad rule', () => {
  // Regression guard for the exact old bug: plain "fncs"+"major" must no longer exclude anything.
  const groups = buildTournamentGroups([rawSession('FNCS Major 3 Last Chance Qualifier')]);
  assert.equal(groups.length, 1);
});
