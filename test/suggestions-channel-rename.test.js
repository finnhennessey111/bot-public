// Verifies the #suggestions channel rename migration: ensureChannel (matchmaker-setup.js) only
// ever creates-if-missing/reparents an existing channel, it never corrects an existing one's name —
// so guild-config.js's self-heal migration is what actually renames an already-created channel to
// match the new "suggestions-report-a-bug" spec name, for every existing guild automatically at the
// bot's next startup, not just guilds running /matchmaker-setup fresh. Same GuildModel-stubbing
// precedent as test/tournament-category-restructure.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const GuildModel = require('../models/Guild');
const { CHANNEL_SPECS } = require('../matchmaker-setup');

function withStubbedGuildModel(fn) {
  const originalUpdateOne = GuildModel.updateOne;
  const originalFindOneAndUpdate = GuildModel.findOneAndUpdate;
  GuildModel.updateOne = async () => {};
  GuildModel.findOneAndUpdate = async () => null;
  return fn().finally(() => {
    GuildModel.updateOne = originalUpdateOne;
    GuildModel.findOneAndUpdate = originalFindOneAndUpdate;
  });
}

function makeFakeGuild(guildId, suggestionsChannelName) {
  const channel = {
    id: 'suggestions-chan-1',
    name: suggestionsChannelName,
    setName: async function (newName) { this.name = newName; },
  };
  const guild = {
    id: guildId,
    channels: { fetch: async (id) => (id === channel.id ? channel : null) },
  };
  return { guild, channel };
}

test('runGuildConfigMigrations: renames an existing #suggestions channel from the old "suggestions" name to "suggestions-report-a-bug"', async () => {
  await withStubbedGuildModel(async () => {
    const guildConfig = require('../guild-config');
    const { guild, channel } = makeFakeGuild('guild-rename-1', 'suggestions');

    await guildConfig.setGuildConfig(guild.id, {
      channelIds: { suggestions: channel.id },
      roleIds: { verified: 'fake-verified-role' },
      categoryIds: { tournaments_EU: 'x', tournaments_NAC: 'x', tournaments_ME: 'x' }, // pre-seeded so the unrelated tournament migration is a no-op here
    });

    const fakeClient = { guilds: { cache: new Map([[guild.id, guild]]) } };
    await guildConfig.runGuildConfigMigrations(fakeClient);

    assert.equal(channel.name, 'suggestions-report-a-bug');
  });
});

test('runGuildConfigMigrations: a guild already on the new name is left untouched (setName never called again)', async () => {
  await withStubbedGuildModel(async () => {
    const guildConfig = require('../guild-config');
    const { guild, channel } = makeFakeGuild('guild-rename-2', 'suggestions-report-a-bug');

    let setNameCalls = 0;
    const originalSetName = channel.setName;
    channel.setName = async function (n) { setNameCalls++; return originalSetName.call(this, n); };

    await guildConfig.setGuildConfig(guild.id, {
      channelIds: { suggestions: channel.id },
      roleIds: { verified: 'fake-verified-role' },
      categoryIds: { tournaments_EU: 'x', tournaments_NAC: 'x', tournaments_ME: 'x' },
    });

    const fakeClient = { guilds: { cache: new Map([[guild.id, guild]]) } };
    await guildConfig.runGuildConfigMigrations(fakeClient);

    assert.equal(setNameCalls, 0, 'no rename call should fire when the name already matches');
    assert.equal(channel.name, 'suggestions-report-a-bug');
  });
});

test('runGuildConfigMigrations: a guild with no #suggestions channel configured at all is a safe no-op (nothing to fetch/rename)', async () => {
  await withStubbedGuildModel(async () => {
    const guildConfig = require('../guild-config');
    const guild = { id: 'guild-rename-3', channels: { fetch: async () => { throw new Error('should never be called'); } } };

    await guildConfig.setGuildConfig(guild.id, {
      channelIds: {},
      roleIds: { verified: 'fake-verified-role' },
      categoryIds: { tournaments_EU: 'x', tournaments_NAC: 'x', tournaments_ME: 'x' },
    });

    const fakeClient = { guilds: { cache: new Map([[guild.id, guild]]) } };
    await assert.doesNotReject(() => guildConfig.runGuildConfigMigrations(fakeClient));
  });
});

test('matchmaker-setup.js: CHANNEL_SPECS itself specifies the new name, for any freshly-created guild', () => {
  const spec = CHANNEL_SPECS.find(s => s.key === 'suggestions');
  assert.equal(spec.name, 'suggestions-report-a-bug');
});
