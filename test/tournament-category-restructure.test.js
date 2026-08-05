// Verifies the 3-category tournament restructure (EU/NAC/ME Tournaments, replacing the single
// shared "Tournaments" category that held all 9 region×build-mode forums flat) and, critically, the
// migration for servers that already ran /matchmaker-setup under the old single-category structure:
// guild-config.js's self-heal migration (runGuildConfigMigrations, which runs automatically at
// every bot startup) must create the 3 new categories and reparent the existing 9 forums into them
// — never delete/recreate a forum (which would lose its posts), never duplicate anything.
const test = require('node:test');
const assert = require('node:assert/strict');
const GuildModel = require('../models/Guild');
const { TOURNAMENT_FORUM_SPECS } = require('../matchmaker-setup');

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

// Builds a fake Discord guild whose channels/categories record every call made on them, same
// create-or-fetch shape matchmaker-setup.js's ensureCategory/ensureTournamentForums expect.
// Deliberately gives every channel/category a delete() that throws — reparenting must never delete
// anything; if it ever did, this would fail loudly instead of silently passing.
//
// guildId must be unique per test: guild-config.js's cache is a module-level object that persists
// across tests within this same process (require() only loads a module once), and setGuildConfig
// MERGES into whatever's already cached for that guild ID rather than replacing it — reusing an ID
// across tests would silently let one test's already-migrated state leak into the next.
function makeFakeGuild(guildId, { existingForums = {}, existingCategories = {} } = {}) {
  let idCounter = 0;
  const nextId = (prefix) => `${prefix}-${++idCounter}`;
  const channelsById = new Map();
  const createdChannelNames = [];

  function assertNoDelete(label) {
    return async () => { throw new Error(`unexpected delete() call on ${label} — migration must never delete a forum or category`); };
  }

  // Pre-seed any "already existing" forums/categories (simulating a guild that ran setup before).
  for (const [id, cat] of Object.entries(existingCategories)) {
    channelsById.set(id, { id, name: cat.name, type: 'category', delete: assertNoDelete(`category ${cat.name}`) });
  }
  for (const [id, forum] of Object.entries(existingForums)) {
    channelsById.set(id, {
      id, name: forum.name, parentId: forum.parentId ?? null, type: 'forum',
      setParent: async function (pid) { this.parentId = pid; },
      delete: assertNoDelete(`forum #${forum.name}`),
    });
  }

  const guild = {
    id: guildId,
    channels: {
      fetch: async (id) => channelsById.get(id) ?? null,
      create: async ({ name, type, parent }) => {
        const id = nextId('chan');
        const channel = {
          id, name, type, parentId: parent ?? null,
          setParent: async function (pid) { this.parentId = pid; },
          delete: assertNoDelete(`channel #${name}`),
        };
        channelsById.set(id, channel);
        createdChannelNames.push(name);
        return channel;
      },
    },
  };
  return { guild, channelsById, createdChannelNames };
}

test('runGuildConfigMigrations: an already-fully-set-up guild (9 forums under the OLD single "Tournaments" category) gets migrated to 3 region categories, forums reparented in place — not deleted or duplicated', async () => {
  await withStubbedGuildModel(async () => {
    const guildConfig = require('../guild-config');

    const oldCategoryId = 'old-tournaments-category';
    const existingForums = {};
    const channelIds = {};
    for (const spec of TOURNAMENT_FORUM_SPECS) {
      const id = `forum-${spec.key}`;
      existingForums[id] = { name: spec.name, parentId: oldCategoryId };
      channelIds[spec.key] = id;
    }

    const { guild, channelsById, createdChannelNames } = makeFakeGuild('guild-old-single-category', {
      existingForums,
      existingCategories: { [oldCategoryId]: { name: 'Tournaments' } },
    });

    await guildConfig.setGuildConfig(guild.id, {
      channelIds,
      categoryIds: { tournaments: oldCategoryId }, // old single-category key — no tournaments_EU/NAC/ME yet
      roleIds: { verified: 'fake-verified-role' }, // pre-seeded so the unrelated roleIds.verified migration is a no-op here
    });

    const fakeClient = { guilds: { cache: new Map([[guild.id, guild]]) } };
    await guildConfig.runGuildConfigMigrations(fakeClient);

    const saved = guildConfig.getGuildConfig(guild.id);

    // 3 new categories created.
    assert.ok(saved.categoryIds.tournaments_EU, 'EU Tournaments category should be created');
    assert.ok(saved.categoryIds.tournaments_NAC, 'NAC Tournaments category should be created');
    assert.ok(saved.categoryIds.tournaments_ME, 'ME Tournaments category should be created');
    // Old category key is untouched, not cleared or deleted (never auto-deleted, per the codebase's
    // established "never delete what a mod might have touched" precedent).
    assert.equal(saved.categoryIds.tournaments, oldCategoryId);

    // No NEW forum channel objects were created — every one of the 9 forum IDs in guild-config is
    // unchanged (same channel identity, so every existing post/thread inside it is untouched).
    assert.deepEqual(saved.channelIds, channelIds, 'forum channel IDs must be identical before/after — reparented, not recreated');
    assert.deepEqual(createdChannelNames, ['EU Tournaments', 'NAC Tournaments', 'ME Tournaments'], 'only the 3 new categories should be newly created, no forums');

    // Every forum actually moved to ITS OWN region's new category (not just the old one, and not
    // all lumped into one).
    for (const spec of TOURNAMENT_FORUM_SPECS) {
      const forumChannel = channelsById.get(channelIds[spec.key]);
      const expectedCategoryId = saved.categoryIds[`tournaments_${spec.region}`];
      assert.equal(forumChannel.parentId, expectedCategoryId, `${spec.key} should now be parented under its own region's category`);
    }
  });
});

test('runGuildConfigMigrations: a guild with no tournament forums at all yet creates all 9 directly under the correct new region category (no reparent step needed)', async () => {
  await withStubbedGuildModel(async () => {
    const guildConfig = require('../guild-config');
    const { guild, channelsById } = makeFakeGuild('guild-from-scratch'); // nothing pre-existing

    await guildConfig.setGuildConfig(guild.id, { channelIds: {}, categoryIds: {}, roleIds: { verified: 'fake-verified-role' } });

    const fakeClient = { guilds: { cache: new Map([[guild.id, guild]]) } };
    await guildConfig.runGuildConfigMigrations(fakeClient);

    const saved = guildConfig.getGuildConfig(guild.id);
    assert.ok(TOURNAMENT_FORUM_SPECS.every(spec => saved.channelIds[spec.key]), 'all 9 forums should be created');

    for (const spec of TOURNAMENT_FORUM_SPECS) {
      const forumChannel = channelsById.get(saved.channelIds[spec.key]);
      assert.equal(forumChannel.parentId, saved.categoryIds[`tournaments_${spec.region}`]);
    }
  });
});

test('runGuildConfigMigrations: an already-migrated guild (3 new categories + all 9 forums correctly placed) is a complete no-op — nothing created or moved again', async () => {
  await withStubbedGuildModel(async () => {
    const guildConfig = require('../guild-config');

    const categoryIds = { tournaments_EU: 'cat-eu', tournaments_NAC: 'cat-nac', tournaments_ME: 'cat-me' };
    const existingForums = {};
    const channelIds = {};
    for (const spec of TOURNAMENT_FORUM_SPECS) {
      const id = `forum-${spec.key}`;
      existingForums[id] = { name: spec.name, parentId: categoryIds[`tournaments_${spec.region}`] };
      channelIds[spec.key] = id;
    }
    const existingCategories = Object.fromEntries(
      Object.entries(categoryIds).map(([key, id]) => [id, { name: key }])
    );

    const { guild, createdChannelNames } = makeFakeGuild('guild-already-migrated', { existingForums, existingCategories });
    await guildConfig.setGuildConfig(guild.id, { channelIds, categoryIds, roleIds: { verified: 'fake-verified-role' } });

    const fakeClient = { guilds: { cache: new Map([[guild.id, guild]]) } };
    await guildConfig.runGuildConfigMigrations(fakeClient);

    assert.deepEqual(createdChannelNames, [], 'nothing should be created — everything already exists in the right place');

    const saved = guildConfig.getGuildConfig(guild.id);
    assert.deepEqual(saved.channelIds, channelIds);
    assert.deepEqual(saved.categoryIds, categoryIds);
  });
});
