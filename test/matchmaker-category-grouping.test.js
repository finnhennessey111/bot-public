// Verifies requirement 2: register/get-roles/how-to-use/access are created inside a dedicated
// "MatchMaker" category instead of at server root, where generic names like "register" or
// "how-to-use" are more likely to collide with a channel a server already has for its own purposes.
// #setup is deliberately excluded (mod-only, permissions.js's MOD_ONLY_CHANNEL_KEYS — see
// matchmaker-setup.js's CHANNEL_SPECS comment).
//
// Exercises the real runMatchmakerSetup (not a reimplementation) against a fake Discord guild.
// guild-config.js is stubbed at the require-cache level, same precedent as
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
    const { runMatchmakerSetup, CATEGORY_SPECS, CHANNEL_SPECS } = require('../matchmaker-setup');
    // Passed through explicitly (not re-required inside fn) — the require-cache stub above is only
    // live for fn's synchronous prefix; finally below restores the real module as soon as fn hits
    // its first await, so a fresh require('../guild-config') from inside fn's later async
    // continuations would resolve to the real, Mongo-backed module instead of this stub.
    return fn(runMatchmakerSetup, () => current, CATEGORY_SPECS, CHANNEL_SPECS, stub.setGuildConfig);
  } finally {
    delete require.cache[guildConfigPath];
    for (const p of dependents) delete require.cache[p];
    if (previousGuildConfig) require.cache[guildConfigPath] = previousGuildConfig;
    dependents.forEach((p, i) => { if (previousDependents[i]) require.cache[p] = previousDependents[i]; });
  }
}

function makeFakeGuild() {
  let idCounter = 0;
  const nextId = (prefix) => `${prefix}-${++idCounter}`;
  const rolesById = {};
  const channelsById = {};
  const createCalls = [];
  const setParentCalls = [];

  function makeChannel(name, type, parentId) {
    const id = nextId('chan');
    const channel = {
      id, name, type, parentId: parentId ?? null,
      permissionOverwrites: { edit: async () => {} },
      messages: { fetch: async () => { throw new Error('Unknown Message'); } },
      send: async () => ({ id: nextId('msg'), pin: async () => {}, edit: async () => {} }),
      setParent: async (pid) => { setParentCalls.push({ name, pid }); channel.parentId = pid; },
      delete: async () => { throw new Error('unexpected delete'); },
      // Forum-channel shape (matchmaker-setup.js's ensureTournamentForum) — every fake channel gets
      // this, not just the one actually created as a forum, since it's harmless on the others and
      // this file's tests aren't about the forum itself.
      availableTags: [],
      setAvailableTags: async (tags) => {
        channel.availableTags = tags.map(t => ({ id: t.id ?? nextId('tag'), name: t.name }));
        return channel;
      },
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
      create: async ({ name, type, parent }) => {
        const c = makeChannel(name, type, parent ?? null);
        channelsById[c.id] = c;
        createCalls.push({ name, type, parent: parent ?? null });
        return c;
      },
    },
    client: { channels: { fetch: async (id) => channelsById[id] ?? null } },
  };

  return { guild, rolesById, channelsById, createCalls, setParentCalls };
}

test('matchmaker-setup: CATEGORY_SPECS includes a MatchMaker category, and register/getRoles/howto are marked for it (access too, when access gating is enabled)', () => {
  withFakeGuildConfig((runMatchmakerSetup, getCurrent, CATEGORY_SPECS, CHANNEL_SPECS) => {
    assert.ok(CATEGORY_SPECS.some(s => s.key === 'matchmaker' && s.name === 'MatchMaker'));

    const byKey = Object.fromEntries(CHANNEL_SPECS.map(s => [s.key, s]));
    assert.equal(byKey.register.category, 'matchmaker');
    assert.equal(byKey.getRoles.category, 'matchmaker');
    assert.equal(byKey.howto.category, 'matchmaker');
    if (byKey.access) assert.equal(byKey.access.category, 'matchmaker');

    // #setup is deliberately excluded — mod-only, not part of the member-facing collision concern.
    assert.equal(byKey.setup.category, undefined);
  });
});

test('matchmaker-setup: a fresh run creates register/getRoles/howto directly under the new MatchMaker category (not at root)', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent) => {
    const { guild, createCalls } = makeFakeGuild();
    await runMatchmakerSetup(guild);

    const saved = getCurrent();
    const matchmakerCategoryId = saved.categoryIds.matchmaker;
    assert.ok(matchmakerCategoryId, 'a MatchMaker category should have been created and saved');

    for (const name of ['register', 'get-roles', 'how-to-use']) {
      const call = createCalls.find(c => c.name === name);
      assert.ok(call, `#${name} should have been created`);
      assert.equal(call.parent, matchmakerCategoryId, `#${name} should be created under the MatchMaker category, not at root`);
    }

    // #setup stays at root, unaffected.
    const setupCall = createCalls.find(c => c.name === 'setup');
    assert.equal(setupCall.parent, null, '#setup should stay at server root');
  });
});

test('matchmaker-setup: re-running after an existing (pre-category) setup moves register/getRoles/howto into the new MatchMaker category', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent, CATEGORY_SPECS, CHANNEL_SPECS, setGuildConfig) => {
    const { guild, createCalls } = makeFakeGuild();

    // Simulate an already-set-up server from before the MatchMaker category existed: create the
    // channels manually at root and seed config to look like a completed prior run.
    const registerChannel = await guild.channels.create({ name: 'register', type: 0 });
    const getRolesChannel = await guild.channels.create({ name: 'get-roles', type: 0 });
    const howtoChannel = await guild.channels.create({ name: 'how-to-use', type: 0 });
    const setupChannel = await guild.channels.create({ name: 'setup', type: 0 });
    createCalls.length = 0; // only care about calls made during the actual setup run below

    await setGuildConfig(guild.id, {
      channelIds: { setup: setupChannel.id, register: registerChannel.id, getRoles: getRolesChannel.id, howto: howtoChannel.id },
    });

    await runMatchmakerSetup(guild);

    const saved = getCurrent();
    const matchmakerCategoryId = saved.categoryIds.matchmaker;
    assert.ok(matchmakerCategoryId);

    assert.equal(registerChannel.parentId, matchmakerCategoryId, '#register should have been reparented into MatchMaker');
    assert.equal(getRolesChannel.parentId, matchmakerCategoryId, '#get-roles should have been reparented into MatchMaker');
    assert.equal(howtoChannel.parentId, matchmakerCategoryId, '#how-to-use should have been reparented into MatchMaker');
    assert.equal(setupChannel.parentId, null, '#setup should NOT be reparented');

    // No duplicate channels were created for the ones that already existed.
    assert.equal(createCalls.some(c => ['register', 'get-roles', 'how-to-use', 'setup'].includes(c.name)), false,
      'no duplicate channels should be created for ones that already existed and were just reparented');
  });
});
