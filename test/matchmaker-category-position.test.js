// Verifies requirement: the MatchMaker category (matchmaker-setup.js's CATEGORY_SPECS, key
// 'matchmaker') is pinned to position 0 — both for a fresh /matchmaker-setup run and for an
// existing server re-running it after having been set up before this shipped, where the category
// already exists wherever Discord's default append-at-the-end placement originally put it.
//
// Exercises the real runMatchmakerSetup (not a reimplementation) against a fake Discord guild, same
// require-cache-stub precedent as test/matchmaker-category-grouping.test.js and
// test/matchmaker-setup-partial-failure.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');

function withFakeGuildConfig(fn) {
  const guildConfigPath = require.resolve('../guild-config');
  const dependents = ['../matchmaker-setup', '../permissions', '../creative-channel'].map(require.resolve);
  const previousGuildConfig = require.cache[guildConfigPath];
  const previousDependents = dependents.map(p => require.cache[p]);

  delete require.cache[guildConfigPath];
  for (const p of dependents) delete require.cache[p];

  let current = { channelIds: {}, roleIds: {}, categoryIds: {}, creativeChannels: {}, setupMessageIds: {}, secrets: {} };
  const stub = {
    getGuildConfig: () => current,
    setGuildConfig: async (guildId, partial) => {
      current = {
        channelIds: { ...current.channelIds, ...partial.channelIds },
        roleIds: { ...current.roleIds, ...partial.roleIds },
        categoryIds: { ...current.categoryIds, ...partial.categoryIds },
        creativeChannels: {
          ...current.creativeChannels,
          ...Object.fromEntries(Object.entries(partial.creativeChannels ?? {}).map(([k, v]) => [k, { ...current.creativeChannels?.[k], ...v }])),
        },
        setupMessageIds: { ...current.setupMessageIds, ...partial.setupMessageIds },
        secrets: { ...current.secrets, ...partial.secrets },
      };
      return current;
    },
    getChannelId: (g, k) => current.channelIds?.[k] ?? null,
    getRoleId: (g, k) => current.roleIds?.[k] ?? null,
    getCategoryId: (g, k) => current.categoryIds?.[k] ?? null,
    getCreativeChannelInfo: (g, c) => current.creativeChannels?.[c] ?? null,
  };
  require.cache[guildConfigPath] = { id: guildConfigPath, filename: guildConfigPath, loaded: true, exports: stub };

  try {
    const { runMatchmakerSetup, CATEGORY_SPECS } = require('../matchmaker-setup');
    return fn(runMatchmakerSetup, () => current, CATEGORY_SPECS, stub.setGuildConfig);
  } finally {
    delete require.cache[guildConfigPath];
    for (const p of dependents) delete require.cache[p];
    if (previousGuildConfig) require.cache[guildConfigPath] = previousGuildConfig;
    dependents.forEach((p, i) => { if (previousDependents[i]) require.cache[p] = previousDependents[i]; });
  }
}

function makeFakeGuild() {
  let idCounter = 0;
  let nextPosition = 0;
  const nextId = (prefix) => `${prefix}-${++idCounter}`;
  const rolesById = {};
  const channelsById = {};
  const setPositionCalls = [];

  function makeChannel(name, type, parentId, position) {
    const id = nextId('chan');
    const channel = {
      id, name, type, parentId: parentId ?? null, position,
      permissionOverwrites: { edit: async () => {} },
      messages: { fetch: async () => { throw new Error('Unknown Message'); } },
      send: async () => ({ id: nextId('msg'), pin: async () => {}, edit: async () => {} }),
      setParent: async (pid) => { channel.parentId = pid; },
      setPosition: async (pos) => {
        setPositionCalls.push({ name, from: channel.position, to: pos });
        channel.position = pos;
      },
      delete: async () => { throw new Error('unexpected delete'); },
    };
    return channel;
  }

  const guild = {
    id: 'guild-1',
    members: { me: { id: 'bot-id' } },
    roles: {
      everyone: { permissions: { remove: () => ({ bitfield: 0n }), bitfield: 0n }, setPermissions: async () => {} },
      fetch: async (id) => rolesById[id] ?? null,
      create: async ({ name }) => { const r = { id: nextId('role'), name, delete: async () => {} }; rolesById[r.id] = r; return r; },
    },
    channels: {
      fetch: async (id) => channelsById[id] ?? null,
      create: async ({ name, type, parent, position }) => {
        // Mirrors Discord's real behavior enough for this test: an explicit position is honored as-
        // given; an omitted one just appends (matches discord.js's GuildChannelManager#create,
        // which calls setPosition internally when options.position is provided).
        const resolvedPosition = position !== undefined ? position : nextPosition++;
        const c = makeChannel(name, type, parent ?? null, resolvedPosition);
        channelsById[c.id] = c;
        return c;
      },
    },
    client: { channels: { fetch: async (id) => channelsById[id] ?? null } },
  };

  return { guild, channelsById, setPositionCalls };
}

test('matchmaker-setup: CATEGORY_SPECS pins the MatchMaker category to position 0', () => {
  withFakeGuildConfig((runMatchmakerSetup, getCurrent, CATEGORY_SPECS) => {
    const matchmakerSpec = CATEGORY_SPECS.find(s => s.key === 'matchmaker');
    assert.ok(matchmakerSpec, 'CATEGORY_SPECS must include the matchmaker category');
    assert.equal(matchmakerSpec.position, 0);
  });
});

test('matchmaker-setup: a fresh run creates the MatchMaker category at position 0', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent) => {
    const { guild, channelsById } = makeFakeGuild();
    await runMatchmakerSetup(guild);

    const saved = getCurrent();
    const matchmakerCategoryId = saved.categoryIds.matchmaker;
    assert.ok(matchmakerCategoryId);
    assert.equal(channelsById[matchmakerCategoryId].position, 0, 'MatchMaker category should be created directly at position 0');
  });
});

test('matchmaker-setup: re-running after an existing setup (category NOT at the top) moves it to position 0', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent, CATEGORY_SPECS, setGuildConfig) => {
    const { guild, channelsById, setPositionCalls } = makeFakeGuild();

    // Simulate an already-set-up server from before this shipped: the MatchMaker category exists,
    // but sitting at the bottom of the list (Discord's old default append placement), same as the
    // real bug report — every other category created "before" it in this fake sequence.
    const euCategory = await guild.channels.create({ name: 'EU Tournaments', type: 4 });
    const nacCategory = await guild.channels.create({ name: 'NAC Tournaments', type: 4 });
    const matchmakerCategory = await guild.channels.create({ name: 'MatchMaker', type: 4 });
    assert.ok(matchmakerCategory.position > euCategory.position, 'sanity check: MatchMaker starts below EU, matching the real bug');

    await setGuildConfig(guild.id, {
      categoryIds: { EU: euCategory.id, NAC: nacCategory.id, matchmaker: matchmakerCategory.id },
    });

    await runMatchmakerSetup(guild);

    const saved = getCurrent();
    assert.equal(saved.categoryIds.matchmaker, matchmakerCategory.id, 'the same, already-existing category should be reused, not recreated');
    assert.equal(matchmakerCategory.position, 0, 'MatchMaker category should have been moved to position 0');
    assert.ok(
      setPositionCalls.some(c => c.name === 'MatchMaker' && c.to === 0),
      'setPosition(0) should have been called on the existing MatchMaker category'
    );
  });
});

test('matchmaker-setup: re-running when the MatchMaker category is already at position 0 does not call setPosition again', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent, CATEGORY_SPECS, setGuildConfig) => {
    const { guild, setPositionCalls } = makeFakeGuild();

    await runMatchmakerSetup(guild);
    const firstRunCalls = setPositionCalls.filter(c => c.name === 'MatchMaker').length;
    assert.equal(firstRunCalls, 0, 'a fresh creation already at position 0 should never need an extra setPosition call');

    setPositionCalls.length = 0;
    await runMatchmakerSetup(guild);
    assert.equal(
      setPositionCalls.filter(c => c.name === 'MatchMaker').length, 0,
      'already correct — a routine re-run should not call setPosition again'
    );
  });
});
