// Verifies the transparency indicator #6 asks for, combining #3's region transparency and #6's
// platform transparency into ONE consistent signal (not two separate ad-hoc ones, per that task's
// explicit instruction) — embeds.js's buildPrContextNote, and its wiring into the real tournament
// and creative match cards (buildMatchCard -> buildTournamentPlayerFields, buildCreativeMatchCard).
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMatchCard, buildCreativeMatchCard } = require('../embeds');

function basePlayer(overrides = {}) {
  return {
    epicUsername: 'TestPlayer',
    epicId: 'epic-1',
    discordUsername: 'testuser',
    discordTag: 'testuser',
    homeRegion: 'EU',
    totalPR: 500,
    queueType: 'duo',
    ingameRoles: [],
    languages: [],
    ageBracket: null,
    recentEvents: [],
    platform: 'PC',
    ...overrides,
  };
}

function tournamentFields(player) {
  return buildMatchCard(player, 'Some Cup').toJSON().fields;
}

test('buildMatchCard: no PR Context field at all when the player is on their home region + default platform', () => {
  const player = basePlayer({
    prContext: { region: 'EU', platformSegment: 'all', isHomeRegion: true, isHomePlatform: true },
  });
  const fields = tournamentFields(player);
  assert.ok(!fields.some(f => f.name === '📎 PR Context'), 'the overwhelmingly common home-context case must show nothing extra');
});

test('buildMatchCard: no prContext at all (e.g. an older player object) also shows nothing — never throws', () => {
  const player = basePlayer(); // no prContext field
  const fields = tournamentFields(player);
  assert.ok(!fields.some(f => f.name === '📎 PR Context'));
});

test('buildMatchCard: region-only divergence shows the region note, referencing both the shown region and home region', () => {
  const player = basePlayer({
    homeRegion: 'EU',
    prContext: { region: 'NAC', platformSegment: 'all', isHomeRegion: false, isHomePlatform: true },
  });
  const fields = tournamentFields(player);
  const note = fields.find(f => f.name === '📎 PR Context');
  assert.ok(note, 'a region-diverging context must be disclosed');
  assert.match(note.value, /NAC/);
  assert.match(note.value, /EU/, 'must also name the home region for comparison');
});

test('buildMatchCard: platform-only divergence (Console player, PC-tournament PR) discloses their genuine platform', () => {
  const player = basePlayer({
    platform: 'Console',
    prContext: { region: 'EU', platformSegment: 'kbm', isHomeRegion: true, isHomePlatform: false },
  });
  const fields = tournamentFields(player);
  const note = fields.find(f => f.name === '📎 PR Context');
  assert.ok(note);
  assert.match(note.value, /Console/, 'must disclose the player is genuinely Console, per the task\'s exact framing');
});

test('buildMatchCard: gamepad segment note reads as Console (a console-exclusive tournament context)', () => {
  const player = basePlayer({
    platform: 'Console',
    prContext: { region: 'EU', platformSegment: 'gamepad', isHomeRegion: true, isHomePlatform: false },
  });
  const fields = tournamentFields(player);
  const note = fields.find(f => f.name === '📎 PR Context');
  // gamepad IS the player's home platform in spirit (Console/gamepad), so isHomePlatform would
  // realistically be true in this exact combination in real usage — this test only exercises
  // buildPrContextNote's own label mapping, independent of when real callers would produce it.
  assert.match(note.value, /Console/);
});

test('buildMatchCard: BOTH region and platform diverging combine into one note, not two separate fields', () => {
  const player = basePlayer({
    homeRegion: 'EU',
    platform: 'Console',
    prContext: { region: 'NAC', platformSegment: 'kbm', isHomeRegion: false, isHomePlatform: false },
  });
  const fields = tournamentFields(player);
  const contextFields = fields.filter(f => f.name === '📎 PR Context');
  assert.equal(contextFields.length, 1, 'exactly one combined field, never two ad-hoc ones');
  assert.match(contextFields[0].value, /NAC/);
  assert.match(contextFields[0].value, /Console/);
});

test('buildCreativeMatchCard: same combined indicator appears on the creative match card', () => {
  const player = basePlayer({
    mode: '1v1 Realistics',
    region: 'NAC',
    homeRegion: 'EU',
    prContext: { region: 'NAC', platformSegment: 'all', isHomeRegion: false, isHomePlatform: true },
  });
  const embed = buildCreativeMatchCard(player);
  const json = embed.toJSON();
  const note = json.fields.find(f => f.name === '📎 PR Context');
  assert.ok(note, 'creative match card must show the same transparency indicator as the tournament card');
  assert.match(note.value, /NAC/);
});

test('buildCreativeMatchCard: home context shows no PR Context field', () => {
  const player = basePlayer({
    mode: '1v1 Realistics',
    region: 'EU',
    homeRegion: 'EU',
    prContext: { region: 'EU', platformSegment: 'all', isHomeRegion: true, isHomePlatform: true },
  });
  const embed = buildCreativeMatchCard(player);
  const json = embed.toJSON();
  assert.ok(!json.fields.some(f => f.name === '📎 PR Context'));
});
