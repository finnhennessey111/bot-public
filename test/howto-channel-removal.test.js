// Verifies the removal of the dedicated #how-to-use channel: matchmaker-setup.js no longer creates
// it for a fresh /matchmaker-setup run (see test/matchmaker-category-grouping.test.js for that half),
// and guild-config.js's self-heal migration deletes the real Discord channel (and clears the stale
// channelIds.howto/setupMessageIds.howto) for a guild that ran /matchmaker-setup before this
// shipped. Same GuildModel-stubbing/runGuildConfigMigrations precedent as
// test/suggestions-channel-rename.test.js.
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

function makeFakeGuild(guildId, { channelExists = true, deleteThrows = false } = {}) {
  let deleted = false;
  let deleteCalls = 0;
  const channel = {
    id: 'howto-chan-1',
    name: 'how-to-use',
    delete: async () => {
      deleteCalls++;
      if (deleteThrows) throw new Error('Missing Permissions');
      deleted = true;
    },
  };
  const guild = {
    id: guildId,
    channels: { fetch: async (id) => (channelExists && id === channel.id ? channel : null) },
  };
  return { guild, channel, wasDeleted: () => deleted, deleteCallCount: () => deleteCalls };
}

test('matchmaker-setup.js: CHANNEL_SPECS no longer has a "howto" entry at all', () => {
  assert.equal(CHANNEL_SPECS.find(s => s.key === 'howto'), undefined);
});

test('runGuildConfigMigrations: deletes an existing #how-to-use channel and clears channelIds.howto + setupMessageIds.howto', async () => {
  await withStubbedGuildModel(async () => {
    const guildConfig = require('../guild-config');
    const { guild, channel, wasDeleted } = makeFakeGuild('guild-howto-1');

    await guildConfig.setGuildConfig(guild.id, {
      channelIds: { howto: channel.id },
      setupMessageIds: { howto: 'msg-1' },
      roleIds: { verified: 'fake-verified-role' },
      categoryIds: { tournaments_EU: 'x', tournaments_NAC: 'x', tournaments_ME: 'x' }, // pre-seeded so the unrelated tournament migration is a no-op here
    });

    const fakeClient = { guilds: { cache: new Map([[guild.id, guild]]) } };
    await guildConfig.runGuildConfigMigrations(fakeClient);

    assert.equal(wasDeleted(), true, 'the real Discord channel should have been deleted');
    const saved = guildConfig.getGuildConfig(guild.id);
    assert.equal(saved.channelIds.howto, undefined, 'channelIds.howto must be actually gone, not just falsy');
    assert.equal(saved.setupMessageIds.howto, undefined, 'setupMessageIds.howto must be actually gone too');
    assert.ok(!('howto' in saved.channelIds), 'the key itself must be removed, not left as undefined');
  });
});

test('runGuildConfigMigrations: a guild whose #how-to-use channel was already manually deleted still gets its stale config cleared', async () => {
  await withStubbedGuildModel(async () => {
    const guildConfig = require('../guild-config');
    const { guild, channel, deleteCallCount } = makeFakeGuild('guild-howto-2', { channelExists: false });

    await guildConfig.setGuildConfig(guild.id, {
      channelIds: { howto: channel.id },
      roleIds: { verified: 'fake-verified-role' },
      categoryIds: { tournaments_EU: 'x', tournaments_NAC: 'x', tournaments_ME: 'x' },
    });

    const fakeClient = { guilds: { cache: new Map([[guild.id, guild]]) } };
    await guildConfig.runGuildConfigMigrations(fakeClient);

    assert.equal(deleteCallCount(), 0, 'delete() must never be called on a channel that is already gone');
    const saved = guildConfig.getGuildConfig(guild.id);
    assert.equal(saved.channelIds.howto, undefined, 'stale channelId must still be cleared even though there was nothing to delete');
  });
});

test('runGuildConfigMigrations: a guild with no #how-to-use channel configured at all is a safe no-op (nothing to fetch/delete)', async () => {
  await withStubbedGuildModel(async () => {
    const guildConfig = require('../guild-config');
    const guild = { id: 'guild-howto-3', channels: { fetch: async () => { throw new Error('should never be called'); } } };

    await guildConfig.setGuildConfig(guild.id, {
      channelIds: {},
      roleIds: { verified: 'fake-verified-role' },
      categoryIds: { tournaments_EU: 'x', tournaments_NAC: 'x', tournaments_ME: 'x' },
    });

    const fakeClient = { guilds: { cache: new Map([[guild.id, guild]]) } };
    await assert.doesNotReject(() => guildConfig.runGuildConfigMigrations(fakeClient));
  });
});

test('runGuildConfigMigrations: a failed delete (e.g. missing permission) leaves channelIds.howto in place so the migration retries next startup, rather than silently forgetting the orphaned channel', async () => {
  await withStubbedGuildModel(async () => {
    const guildConfig = require('../guild-config');
    const { guild, channel, deleteCallCount } = makeFakeGuild('guild-howto-4', { deleteThrows: true });

    await guildConfig.setGuildConfig(guild.id, {
      channelIds: { howto: channel.id },
      roleIds: { verified: 'fake-verified-role' },
      categoryIds: { tournaments_EU: 'x', tournaments_NAC: 'x', tournaments_ME: 'x' },
    });

    const fakeClient = { guilds: { cache: new Map([[guild.id, guild]]) } };
    await assert.doesNotReject(() => guildConfig.runGuildConfigMigrations(fakeClient), 'the per-migration try/catch in runGuildConfigMigrations must swallow this, not crash the whole startup pass');

    assert.equal(deleteCallCount(), 1, 'delete() should have been attempted exactly once');
    const saved = guildConfig.getGuildConfig(guild.id);
    assert.equal(saved.channelIds.howto, channel.id, 'channelIds.howto must be UNCHANGED after a failed delete — still "missing" so this retries next startup');
  });
});
