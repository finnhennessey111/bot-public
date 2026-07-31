// Verifies the revised 6s/8s handling: /matchmaker-setup creates creative-6s/creative-8s channels
// (unlike the previous version of this change, which skipped creating them entirely), but posts
// embeds.js's buildCreativeComingSoonEmbed — no queue button, nothing to join — instead of the
// real queue embed, since 6s/8s is a planned premium feature not available during the current
// free-for-everyone period. 1v1/2v2 must be completely unaffected (real embed + buttons, as
// always). Same withFakeGuildConfig/makeFakeGuild harness as
// test/matchmaker-category-grouping.test.js, extended so channel.send captures its payload (that
// test only needed create-call tracking, not the actual embeds/components sent).
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
    const { runMatchmakerSetup, CREATIVE_CHANNEL_SPECS } = require('../matchmaker-setup');
    return fn(runMatchmakerSetup, () => current, CREATIVE_CHANNEL_SPECS);
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
  const sentPayloadsByChannelName = {};

  function makeChannel(name, type, parentId) {
    const id = nextId('chan');
    const channel = {
      id, name, type, parentId: parentId ?? null,
      permissionOverwrites: { edit: async () => {} },
      messages: { fetch: async () => { throw new Error('Unknown Message'); } },
      send: async (payload) => {
        sentPayloadsByChannelName[name] = payload;
        return { id: nextId('msg'), pin: async () => {}, edit: async () => {} };
      },
      setParent: async (pid) => { channel.parentId = pid; },
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
      create: async ({ name, type, parent }) => {
        const c = makeChannel(name, type, parent ?? null);
        channelsById[c.id] = c;
        createCalls.push({ name, type, parent: parent ?? null });
        return c;
      },
    },
    client: { channels: { fetch: async (id) => channelsById[id] ?? null } },
  };

  return { guild, rolesById, channelsById, createCalls, sentPayloadsByChannelName };
}

test('matchmaker-setup: CREATIVE_CHANNEL_SPECS includes 6s and 8s again (channels are created, not skipped)', () => {
  withFakeGuildConfig((runMatchmakerSetup, getCurrent, CREATIVE_CHANNEL_SPECS) => {
    const keys = CREATIVE_CHANNEL_SPECS.map(s => s.key);
    assert.ok(keys.includes('6s'), 'creative-6s must be created (not skipped) during /matchmaker-setup');
    assert.ok(keys.includes('8s'), 'creative-8s must be created (not skipped) during /matchmaker-setup');
    assert.ok(keys.includes('1v1'));
    assert.ok(keys.includes('2v2'));
  });
});

test('a fresh /matchmaker-setup run: creative-6s/creative-8s get created with a Coming Soon embed and NO components; creative-1v1/2v2 get the real queue embed with buttons', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent) => {
    const { guild, createCalls, sentPayloadsByChannelName } = makeFakeGuild();

    await runMatchmakerSetup(guild);

    assert.ok(createCalls.some(c => c.name === 'creative-6s'), 'creative-6s channel must actually be created');
    assert.ok(createCalls.some(c => c.name === 'creative-8s'), 'creative-8s channel must actually be created');

    for (const name of ['creative-6s', 'creative-8s']) {
      const payload = sentPayloadsByChannelName[name];
      assert.ok(payload, `expected a message to have been posted in #${name}`);
      assert.equal(payload.components, undefined, `#${name} must have no components (no queue button) — coming soon, nothing to join yet`);
      const embed = payload.embeds[0].toJSON();
      assert.match(embed.title, /coming soon/i, `#${name}'s embed should say Coming Soon`);
      assert.match(embed.description, /premium/i, `#${name}'s embed should explain it's a planned premium feature`);
    }

    for (const name of ['creative-1v1', 'creative-2v2']) {
      const payload = sentPayloadsByChannelName[name];
      assert.ok(payload, `expected a message to have been posted in #${name}`);
      assert.ok(payload.components && payload.components.length > 0, `#${name} must still have real queue components (unaffected by the 6s/8s change)`);
      const embed = payload.embeds[0].toJSON();
      assert.doesNotMatch(embed.title, /coming soon/i, `#${name} must not be treated as coming-soon`);
    }

    // The guild-config record persisted for 6s/8s must still exist (tracked like any other creative
    // channel), so a future launch just has to edit this message in place, not recreate anything.
    const saved = getCurrent();
    assert.ok(saved.creativeChannels['6s']?.channelId && saved.creativeChannels['6s']?.messageId);
    assert.ok(saved.creativeChannels['8s']?.channelId && saved.creativeChannels['8s']?.messageId);
  });
});

test('re-running /matchmaker-setup does not re-post or duplicate the coming-soon embed once it exists', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent) => {
    const { guild, createCalls } = makeFakeGuild();

    await runMatchmakerSetup(guild);
    const firstRunCreateCount = createCalls.filter(c => c.name === 'creative-6s').length;
    assert.equal(firstRunCreateCount, 1);

    await runMatchmakerSetup(guild);
    const secondRunCreateCount = createCalls.filter(c => c.name === 'creative-6s').length;
    assert.equal(secondRunCreateCount, 1, 're-running setup must not create a second creative-6s channel');
  });
});
