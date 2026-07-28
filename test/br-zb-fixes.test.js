// Verifies the three production fixes:
//   1. A build-mode-only title (no real tournament name) never survives to become a channel name.
//   2. BR/ZB moves to the FRONT of the generated channel name, not the end.
//   3. "Fortnite Championship Series" (FNCS Grand Finals) is excluded the same way FNCS Majors are.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildChannelName, abbreviateBuildMode } = require('../channel-manager');
const { buildTournamentGroups, isBareBuildModeLabel } = require('../tournament-scraper');

function rawSession(name, region = 'EU', beginTime = new Date(Date.now() + 3600_000).toISOString()) {
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

// --- Issue 1: bare build-mode label never becomes a channel name -------------------------------

test('isBareBuildModeLabel flags a title that is only the build-mode label', () => {
  assert.equal(isBareBuildModeLabel('battle royale'), true);
  assert.equal(isBareBuildModeLabel('zero build'), true);
  assert.equal(isBareBuildModeLabel('(zero build)'), true);
  assert.equal(isBareBuildModeLabel('ZB'), true);
  assert.equal(isBareBuildModeLabel('br'), true);
});

test('isBareBuildModeLabel does not flag a real tournament name that merely mentions a build mode', () => {
  assert.equal(isBareBuildModeLabel('typical gamer icon cup (zero build)'), false);
  assert.equal(isBareBuildModeLabel('solo ranked cup (battle royale)'), false);
  assert.equal(isBareBuildModeLabel('console duos zb cash cup'), false);
});

test('buildTournamentGroups drops raw sessions whose title is just a build-mode label', () => {
  const sessions = [
    rawSession('Battle Royale'),
    rawSession('Zero Build'),
    rawSession('Typical Gamer Icon Cup (Zero Build)'),
  ];
  const groups = buildTournamentGroups(sessions);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'Typical Gamer Icon Cup (Zero Build)');
});

test('end-to-end: a bare build-mode-label session can never produce a channel name with no tournament name', () => {
  const sessions = [rawSession('Battle Royale'), rawSession('Zero Build')];
  const groups = buildTournamentGroups(sessions);
  assert.equal(groups.length, 0, 'bare build-mode-label sessions must never reach channel creation');

  // Defense-in-depth: even if a name like this reached buildChannelName directly, the last-resort
  // guard (isBareBuildModeLabel, used in channel-manager.js's createTournamentChannel) would catch it.
  assert.equal(isBareBuildModeLabel('Battle Royale'.toLowerCase()), true);
  assert.equal(isBareBuildModeLabel('Zero Build'.toLowerCase()), true);
});

// --- Issue 2: BR/ZB prefix ordering -------------------------------------------------------------

test('abbreviateBuildMode moves the build-mode tag to the front', () => {
  assert.equal(abbreviateBuildMode('Typical Gamer Icon Cup (Zero Build)'), 'ZB Typical Gamer Icon Cup');
  assert.equal(abbreviateBuildMode('Solo Ranked Cup (Battle Royale)'), 'BR Solo Ranked Cup');
  assert.equal(abbreviateBuildMode('No Mode Here Cup'), 'No Mode Here Cup');
});

test('buildChannelName renders the tag at the front of the slugified name', () => {
  assert.equal(buildChannelName('Typical Gamer Icon Cup (Zero Build)'), 'zb-typical-gamer-icon-cup');
  assert.equal(buildChannelName('Typical Gamer Icon Cup Battle Royale'), 'br-typical-gamer-icon-cup');
  assert.notEqual(buildChannelName('Typical Gamer Icon Cup (Zero Build)'), 'typical-gamer-icon-cup-zb');
});

// --- Issue 3: FNCS Grand Finals ("Fortnite Championship Series") excluded -----------------------

test('buildTournamentGroups excludes "Fortnite Championship Series" (FNCS Grand Finals)', () => {
  const sessions = [
    rawSession('Fortnite Championship Series'),
    rawSession('FNCS Major 3'),
    rawSession('FNCS Division 1'),
  ];
  const groups = buildTournamentGroups(sessions);
  const names = groups.map(g => g.name);

  assert.ok(!names.includes('Fortnite Championship Series'), 'Grand Finals must be excluded');
  assert.ok(!names.includes('FNCS Major 3'), 'FNCS Majors must stay excluded');
  assert.ok(names.includes('FNCS Division 1'), 'regular FNCS divisions must still survive');
});
