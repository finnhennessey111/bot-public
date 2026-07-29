// Verifies requirement 2: a proposed teammate/match to accept or decline shows region alongside
// name/PR/platform, consistently for both the tournament match confirmation embed (buildMatchCard)
// and the 6s/8s team invite embed (buildTeamInviteEmbed). Real embeds.js functions, not
// reimplementations — .toJSON() is what Discord.js actually sends over the wire.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMatchCard, buildTeamInviteEmbed } = require('../embeds');

function fieldNamed(fields, pattern) {
  return fields.find(f => pattern.test(f.name));
}

test('buildMatchCard (tournament match confirmation): shows the player\'s region', () => {
  const player = {
    epicUsername: 'Ninja', discordUsername: 'ninja#0001', discordTag: 'ninja',
    platform: 'PC', homeRegion: 'NAC', totalPR: 12345, queueType: 'duo',
    ingameRoles: [], languages: [], ageBracket: null, epicId: null,
    recentEvents: [],
  };

  const embed = buildMatchCard(player, 'Some Cup').toJSON();
  const regionField = fieldNamed(embed.fields, /region/i);
  assert.ok(regionField, 'expected a Region field on the tournament match card');
  assert.match(regionField.value, /NAC/);
});

test('buildTeamInviteEmbed: shows each teammate\'s region alongside name/PR/platform', () => {
  const teammatePlayers = [
    { epicUsername: 'Ninja', platform: 'PC', totalPR: 500, region: 'EU' },
    { epicUsername: 'Bugha', platform: 'Console', totalPR: 900, region: 'NAC' },
  ];

  const embed = buildTeamInviteEmbed('Leader', teammatePlayers, 'Invitee', '3v3 Realistics', 'EU').toJSON();

  assert.equal(embed.fields.length, 2);
  assert.match(embed.fields[0].value, /500 PR/);
  assert.match(embed.fields[0].value, /PC/);
  assert.match(embed.fields[0].value, /EU/);
  assert.match(embed.fields[1].value, /900 PR/);
  assert.match(embed.fields[1].value, /Console/);
  assert.match(embed.fields[1].value, /NAC/);
});

test('buildTeamInviteEmbed: a teammate with no registered region yet still renders (no crash, shows "Unknown")', () => {
  const teammatePlayers = [{ epicUsername: 'NewPlayer', platform: 'PC', totalPR: 0, region: null }];
  const embed = buildTeamInviteEmbed('Leader', teammatePlayers, 'Invitee', '3v3 Realistics', 'EU').toJSON();
  assert.match(embed.fields[0].value, /Unknown/);
});
