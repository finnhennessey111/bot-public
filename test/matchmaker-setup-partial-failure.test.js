// Regression test for a production incident report: an admin re-ran /matchmaker-setup after
// fixing a "Missing Permissions" error, and afterward the server's creative queue channels
// appeared to have vanished.
//
// Investigation (reading every ensureX helper in matchmaker-setup.js, plus permissions.js,
// creative-channel.js, channel-manager.js, and guild-config.js) found matchmaker-setup.js never
// calls channel.delete()/role.delete()/setParent(null) or clears any permission overwrite in a
// way that removes access — the whole flow is create-if-missing, confirmed here by never handing
// the fake guild's roles/channels a working delete() (see assertNoDeletes below: any accidental
// call throws instead of silently succeeding).
//
// But a live run against the pre-fix code (see git history of this file's introduction) showed a
// real, different bug with the same symptom on the outside: matchmaker-setup.js persisted
// roleIds/categoryIds/channelIds to guild-config in a single setGuildConfig() call at the very
// end of the run — AFTER all the starter embeds were posted. A failure at the embed-posting step
// (e.g. Send Messages missing in just one channel, even though Manage Channels/Manage Roles were
// fixed) meant every role/category/channel created during that run was never saved. A retry,
// blind to what already existed on Discord, recreated a full second set — duplicate roles,
// duplicate categories (including a second "Creative" category), duplicate channels — which is a
// very plausible real path to an admin manually deleting what looked like broken duplicates.
//
// The fix: save roleIds/categoryIds/channelIds right after each phase completes (creative channel
// IDs already saved this way, per-channel, via creative-channel.js's postCreativeQueueChannel) so
// a downstream failure can't cause duplicate creation on retry, and log specifically what
// succeeded vs. what's still missing when a run fails partway through.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
// Static data only (not runtime guild-config state) — safe to require at file scope, outside
// withFakeGuildConfig's require-cache stubbing below.
const { TOURNAMENT_FORUM_SPECS } = require('../matchmaker-setup');

function withFakeGuildConfig(fn) {
  const guildConfigPath = require.resolve('../guild-config');
  const dependents = ['../matchmaker-setup', '../permissions', '../creative-channel'].map(require.resolve);
  const previousGuildConfig = require.cache[guildConfigPath];
  const previousDependents = dependents.map(p => require.cache[p]);

  delete require.cache[guildConfigPath];
  for (const p of dependents) delete require.cache[p];

  let current = { channelIds: {}, roleIds: {}, categoryIds: {}, creativeChannels: {}, setupMessageIds: {}, secrets: {} };
  const setGuildConfigCalls = [];
  const stub = {
    getGuildConfig: () => current,
    setGuildConfig: async (guildId, partial) => {
      setGuildConfigCalls.push(JSON.parse(JSON.stringify(partial)));
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
    const { runMatchmakerSetup } = require('../matchmaker-setup');
    return fn(runMatchmakerSetup, () => current, setGuildConfigCalls);
  } finally {
    delete require.cache[guildConfigPath];
    for (const p of dependents) delete require.cache[p];
    if (previousGuildConfig) require.cache[guildConfigPath] = previousGuildConfig;
    dependents.forEach((p, i) => { if (previousDependents[i]) require.cache[p] = previousDependents[i]; });
  }
}

// Builds a fake Discord guild whose channels/roles record every call made on them. Deliberately
// gives every created role/channel a delete() that throws — if matchmaker-setup.js's flow ever
// called it (directly, or indirectly through some helper), the test would fail loudly rather than
// silently passing because a no-op stub happened to swallow the call.
function makeFakeGuild({ failChannelSend = null } = {}) {
  let idCounter = 0;
  const nextId = (prefix) => `${prefix}-${++idCounter}`;
  const rolesById = {};
  const channelsById = {};
  const createdRoleNames = [];
  const createdChannelNames = [];

  function assertNoDelete(label) {
    return async () => { throw new Error(`unexpected delete() call on ${label} — matchmaker-setup must never delete anything`); };
  }

  function makeChannel(name, type) {
    const id = nextId('chan');
    const channel = {
      id, name, type, parentId: null,
      permissionOverwrites: { edit: async () => {} },
      messages: { fetch: async () => { throw new Error('Unknown Message'); } },
      send: async () => {
        if (failChannelSend && name === failChannelSend) throw new Error('Missing Permissions');
        return { id: nextId('msg'), pin: async () => {}, edit: async () => {} };
      },
      setParent: async (pid) => { channel.parentId = pid; },
      delete: assertNoDelete(`channel #${name}`),
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
      create: async ({ name }) => {
        const id = nextId('role');
        const role = { id, name, delete: assertNoDelete(`role ${name}`) };
        rolesById[id] = role;
        createdRoleNames.push(name);
        return role;
      },
    },
    channels: {
      fetch: async (id) => channelsById[id] ?? null,
      create: async ({ name, type }) => {
        const c = makeChannel(name, type);
        channelsById[c.id] = c;
        createdChannelNames.push(name);
        return c;
      },
    },
    client: { channels: { fetch: async (id) => channelsById[id] ?? null } },
  };

  return { guild, rolesById, channelsById, createdRoleNames, createdChannelNames };
}

test('matchmaker-setup: a run that fails posting the #setup embed does not delete or clear anything', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent) => {
    const { guild } = makeFakeGuild({ failChannelSend: 'setup' });
    await assert.rejects(() => runMatchmakerSetup(guild), /Missing Permissions/);
    // No delete() was called (assertNoDelete above would have thrown and failed the test if so).
  });
});

test('matchmaker-setup: roles/categories/channels created before a partial failure are persisted immediately, not lost', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent) => {
    const { guild } = makeFakeGuild({ failChannelSend: 'setup' });
    await assert.rejects(() => runMatchmakerSetup(guild));

    const saved = getCurrent();
    assert.equal(Object.keys(saved.roleIds).length, 11, 'all 11 roles should be saved even though the run failed later');
    assert.ok(
      saved.categoryIds.matchmaker && saved.categoryIds.creative
      && saved.categoryIds.tournaments_EU && saved.categoryIds.tournaments_NAC && saved.categoryIds.tournaments_ME,
      'all 5 categories (matchmaker, creative, 3 region tournament categories) should be saved even though the run failed later'
    );
    assert.ok(saved.channelIds.register && saved.channelIds.getRoles,
      'channels created before the failing #setup embed post should be saved');
    assert.ok(
      TOURNAMENT_FORUM_SPECS.every(spec => saved.channelIds[spec.key]),
      'all 9 tournament forums (created before the failing #setup embed post) should be saved too'
    );
  });
});

test('matchmaker-setup: retrying after a partial failure reuses what was already created — no duplicate roles/categories/channels', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent) => {
    const fake = makeFakeGuild({ failChannelSend: 'setup' });
    await assert.rejects(() => runMatchmakerSetup(fake.guild));

    const roleCountAfterFailure = Object.keys(fake.rolesById).length;
    const channelCountAfterFailure = Object.keys(fake.channelsById).length;
    assert.equal(roleCountAfterFailure, 11);

    // "Fix" the permission gap for the retry — #setup can now send successfully.
    fake.createdRoleNames.length = 0;
    fake.createdChannelNames.length = 0;
    const setupChannel = Object.values(fake.channelsById).find(c => c.name === 'setup');
    setupChannel.send = async () => ({ id: 'msg-final', pin: async () => {}, edit: async () => {} });

    const result = await runMatchmakerSetup(fake.guild);
    assert.match(result.summary, /setup complete/i);

    assert.equal(Object.keys(fake.rolesById).length, roleCountAfterFailure,
      `retry must not create duplicate roles — was ${roleCountAfterFailure}, now ${Object.keys(fake.rolesById).length} (created: ${fake.createdRoleNames.join(', ')})`);
    assert.deepEqual(fake.createdRoleNames, [], 'no roles should be (re)created on a successful retry');

    const nonCreativeChannelsCreatedOnRetry = fake.createdChannelNames.filter(n => !n.startsWith('creative-'));
    assert.deepEqual(nonCreativeChannelsCreatedOnRetry, [],
      `retry must not create duplicate categories/channels — created: ${fake.createdChannelNames.join(', ')}`);
  });
});
