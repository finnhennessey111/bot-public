// Verifies /refresh-all-servers: a genuinely new, separate command from /post-update (which only
// refreshes the live #setup embed) — this re-runs the FULL idempotent runMatchmakerSetup (roles,
// categories, channels, embeds) across every guild the bot is in. Reuses runMatchmakerSetup as-is
// (matchmaker-setup.js), no duplicated setup logic.
//
// Core behaviors tested against matchmaker-setup.js's runMatchmakerSetupForAllGuilds directly (not
// through a real Discord interaction — index.js can't be required directly in a test, client.login()
// side effect on load, same constraint documented in test/epic-link-gate.test.js):
//   - safe to run repeatedly across the same guild set, no duplicate roles/channels/categories
//   - one guild's failure (e.g. a missing permission) doesn't stop the rest from being processed
//   - the summary (buildRefreshAllSummaryMessage) reports succeeded/failed counts and reasons
//     accurately, including a real many-failure case that must truncate under Discord's message cap
// The owner-only gate and command registration are verified at the source level (register-commands.js/
// index.js), same precedent as test/matchmaker-setup-permission.test.js's /matchmaker-setup checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ChangelogModel = require('../models/Changelog');

// runMatchmakerSetup calls changelog.getRecentEntries() on every run (for the #setup embed) — with
// no real MongoDB connection in this test environment, ChangelogModel.find(...) would otherwise hit
// a real ~10s buffering timeout PER runMatchmakerSetup call (confirmed live: a single 2-guild,
// run-it-twice test took over 100s before this stub was added, since 2 guilds × 2 runs = 4 real
// 10s-timeout waits). Stubbed here the same "stub the Model, not the module" way other tests do
// (e.g. test/tournament-channel-visibility.test.js's DeletedTournamentChannelModel.findOne) — this
// file exercises runMatchmakerSetup across MULTIPLE guilds and MULTIPLE full passes per test, so it
// pays this cost far more times than a typical single-guild setup test does.
function withStubbedChangelog(fn) {
  const original = ChangelogModel.find;
  ChangelogModel.find = () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) });
  return Promise.resolve(fn()).finally(() => { ChangelogModel.find = original; });
}

function withFakeGuildConfig(fn) {
  const guildConfigPath = require.resolve('../guild-config');
  const dependents = ['../matchmaker-setup', '../permissions', '../creative-channel'].map(require.resolve);
  const previousGuildConfig = require.cache[guildConfigPath];
  const previousDependents = dependents.map(p => require.cache[p]);

  delete require.cache[guildConfigPath];
  for (const p of dependents) delete require.cache[p];

  // Keyed per guildId (unlike test/matchmaker-setup-partial-failure.test.js's single shared
  // `current`) — this file exercises MULTIPLE guilds at once, which genuinely need independent
  // config state, not one shared object that the second guild would silently clobber.
  const configByGuild = {};
  function forGuild(guildId) {
    if (!configByGuild[guildId]) {
      configByGuild[guildId] = { channelIds: {}, roleIds: {}, categoryIds: {}, creativeChannels: {}, setupMessageIds: {}, secrets: {} };
    }
    return configByGuild[guildId];
  }
  const stub = {
    getGuildConfig: (guildId) => forGuild(guildId),
    setGuildConfig: async (guildId, partial) => {
      const current = forGuild(guildId);
      configByGuild[guildId] = {
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
      return configByGuild[guildId];
    },
    getChannelId: (g, k) => forGuild(g).channelIds?.[k] ?? null,
    getRoleId: (g, k) => forGuild(g).roleIds?.[k] ?? null,
    getCategoryId: (g, k) => forGuild(g).categoryIds?.[k] ?? null,
    getCreativeChannelInfo: (g, c) => forGuild(g).creativeChannels?.[c] ?? null,
  };
  require.cache[guildConfigPath] = { id: guildConfigPath, filename: guildConfigPath, loaded: true, exports: stub };

  try {
    const matchmakerSetup = require('../matchmaker-setup');
    return fn(matchmakerSetup, configByGuild);
  } finally {
    delete require.cache[guildConfigPath];
    for (const p of dependents) delete require.cache[p];
    if (previousGuildConfig) require.cache[guildConfigPath] = previousGuildConfig;
    dependents.forEach((p, i) => { if (previousDependents[i]) require.cache[p] = previousDependents[i]; });
  }
}

// Same fake-guild shape as test/matchmaker-setup-partial-failure.test.js (delete() always throws —
// confirms nothing here ever deletes anything either), parameterized by guildId/guildName so
// multiple distinct fake guilds can exist in the same test.
function makeFakeGuild(guildId, guildName, { failChannelSend = null } = {}) {
  let idCounter = 0;
  const nextId = (prefix) => `${guildId}-${prefix}-${++idCounter}`;
  const rolesById = {};
  const channelsById = {};
  const createdRoleNames = [];
  const createdChannelNames = [];

  function assertNoDelete(label) {
    return async () => { throw new Error(`unexpected delete() call on ${label}`); };
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
      delete: assertNoDelete(`channel #${name} in ${guildId}`),
      availableTags: [],
      setAvailableTags: async (tags) => { channel.availableTags = tags.map(t => ({ id: t.id ?? nextId('tag'), name: t.name })); return channel; },
    };
    return channel;
  }

  const guild = {
    id: guildId,
    name: guildName,
    members: { me: { id: 'bot-id' } },
    roles: {
      everyone: { permissions: { remove: () => ({ bitfield: 0n }), bitfield: 0n }, setPermissions: async () => {} },
      fetch: async (id) => rolesById[id] ?? null,
      create: async ({ name }) => {
        const id = nextId('role');
        const role = { id, name, delete: assertNoDelete(`role ${name} in ${guildId}`) };
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

function makeFakeClient(guilds) {
  return { guilds: { cache: new Map(guilds.map(g => [g.id, g])) } };
}

test('runMatchmakerSetupForAllGuilds: processes every guild the bot is in, all succeeding', async () => {
  await withStubbedChangelog(() => withFakeGuildConfig(async (matchmakerSetup) => {
    const g1 = makeFakeGuild('guild-1', 'Server One');
    const g2 = makeFakeGuild('guild-2', 'Server Two');
    const g3 = makeFakeGuild('guild-3', 'Server Three');
    const client = makeFakeClient([g1.guild, g2.guild, g3.guild]);

    const result = await matchmakerSetup.runMatchmakerSetupForAllGuilds(client, 0);

    assert.equal(result.succeeded.length, 3);
    assert.equal(result.failed.length, 0);
    assert.deepEqual(result.succeeded.map(s => s.guildId).sort(), ['guild-1', 'guild-2', 'guild-3']);
  }));
});

test('runMatchmakerSetupForAllGuilds: one guild failing (missing permissions) does not stop the others from completing', async () => {
  await withStubbedChangelog(() => withFakeGuildConfig(async (matchmakerSetup) => {
    const g1 = makeFakeGuild('guild-1', 'Good Server A');
    const g2 = makeFakeGuild('guild-2', 'Broken Server', { failChannelSend: 'setup' }); // simulates a real Missing Permissions failure
    const g3 = makeFakeGuild('guild-3', 'Good Server B');
    const client = makeFakeClient([g1.guild, g2.guild, g3.guild]);

    const result = await matchmakerSetup.runMatchmakerSetupForAllGuilds(client, 0);

    assert.equal(result.succeeded.length, 2, 'the two working guilds must both still complete');
    assert.deepEqual(result.succeeded.map(s => s.guildId).sort(), ['guild-1', 'guild-3']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].guildId, 'guild-2');
    assert.equal(result.failed[0].guildName, 'Broken Server');
    assert.match(result.failed[0].reason, /Missing Permissions/);
  }));
});

test('runMatchmakerSetupForAllGuilds: safe to run repeatedly across the same guild set — no duplicate roles/channels created on a second pass', async () => {
  await withStubbedChangelog(() => withFakeGuildConfig(async (matchmakerSetup) => {
    const g1 = makeFakeGuild('guild-1', 'Server One');
    const g2 = makeFakeGuild('guild-2', 'Server Two');
    const client = makeFakeClient([g1.guild, g2.guild]);

    const first = await matchmakerSetup.runMatchmakerSetupForAllGuilds(client, 0);
    assert.equal(first.failed.length, 0);

    const roleCountAfterFirst1 = Object.keys(g1.rolesById).length;
    const roleCountAfterFirst2 = Object.keys(g2.rolesById).length;
    const channelCountAfterFirst1 = Object.keys(g1.channelsById).length;
    const channelCountAfterFirst2 = Object.keys(g2.channelsById).length;
    g1.createdRoleNames.length = 0;
    g2.createdRoleNames.length = 0;
    g1.createdChannelNames.length = 0;
    g2.createdChannelNames.length = 0;

    const second = await matchmakerSetup.runMatchmakerSetupForAllGuilds(client, 0);
    assert.equal(second.succeeded.length, 2, 'a second run across the same guilds must still succeed for both');

    assert.equal(Object.keys(g1.rolesById).length, roleCountAfterFirst1, 'no duplicate roles in guild-1 on the second pass');
    assert.equal(Object.keys(g2.rolesById).length, roleCountAfterFirst2, 'no duplicate roles in guild-2 on the second pass');
    assert.equal(Object.keys(g1.channelsById).length, channelCountAfterFirst1, 'no duplicate channels in guild-1 on the second pass');
    assert.equal(Object.keys(g2.channelsById).length, channelCountAfterFirst2, 'no duplicate channels in guild-2 on the second pass');
    assert.deepEqual(g1.createdRoleNames, [], 'no roles (re)created in guild-1 on the second pass');
    assert.deepEqual(g2.createdRoleNames, [], 'no roles (re)created in guild-2 on the second pass');
  }));
});

test('runMatchmakerSetupForAllGuilds: an empty guild list (bot in no servers) resolves cleanly, not a crash', async () => {
  await withFakeGuildConfig(async (matchmakerSetup) => {
    const client = makeFakeClient([]);
    const result = await matchmakerSetup.runMatchmakerSetupForAllGuilds(client, 0);
    assert.deepEqual(result, { succeeded: [], failed: [] });
  });
});

// ── buildRefreshAllSummaryMessage: the DM summary content ────────────────────
test('buildRefreshAllSummaryMessage: all-success summary reports accurate counts and no Failures section', () => {
  const { buildRefreshAllSummaryMessage } = require('../matchmaker-setup');
  const msg = buildRefreshAllSummaryMessage({
    succeeded: [{ guildId: 'g1', guildName: 'A' }, { guildId: 'g2', guildName: 'B' }],
    failed: [],
  });
  assert.match(msg, /Succeeded: 2\/2/);
  assert.match(msg, /Failed: 0\/2/);
  assert.doesNotMatch(msg, /Failures:/);
});

test('buildRefreshAllSummaryMessage: mixed results list each failure with its guild and real reason', () => {
  const { buildRefreshAllSummaryMessage } = require('../matchmaker-setup');
  const msg = buildRefreshAllSummaryMessage({
    succeeded: [{ guildId: 'g1', guildName: 'Good Server' }],
    failed: [{ guildId: 'g2', guildName: 'Broken Server', reason: 'Missing Permissions' }],
  });
  assert.match(msg, /Succeeded: 1\/2/);
  assert.match(msg, /Failed: 1\/2/);
  assert.match(msg, /Failures:/);
  assert.match(msg, /Broken Server \(g2\): Missing Permissions/);
});

test('buildRefreshAllSummaryMessage: a huge number of failures truncates under Discord\'s real 2000-char message cap, with a "...and N more" note', () => {
  const { buildRefreshAllSummaryMessage } = require('../matchmaker-setup');
  const failed = Array.from({ length: 200 }, (_, i) => ({
    guildId: `guild-id-number-${i}`, guildName: `A Fairly Long Server Name Number ${i}`, reason: 'Missing Permissions (Manage Roles required)',
  }));
  const msg = buildRefreshAllSummaryMessage({ succeeded: [], failed });

  assert.ok(msg.length <= 2000, `must stay under Discord's real message cap — got ${msg.length} chars`);
  assert.match(msg, /Failed: 200\/200/, 'the real total must still be reported even though the list itself is truncated');
  assert.match(msg, /\.\.\.and \d+ more/, 'must note that the failure list itself was truncated, not silently cut off');
});

// ── Wiring: command registration + owner-only gate ────────────────────────────
test('register-commands.js: /refresh-all-servers is registered as a real slash command', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'register-commands.js'), 'utf8');
  assert.match(source, /\.setName\('refresh-all-servers'\)/);
});

test('index.js: /refresh-all-servers is gated to BOT_OWNER_DISCORD_ID via an in-handler check, defers immediately, and reports via DM (not editReply) once background work finishes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const handlerMatch = source.match(/commandName === 'refresh-all-servers'\)\s*{[\s\S]*?\n {4}}/);
  assert.ok(handlerMatch, 'could not locate the /refresh-all-servers handler in index.js');
  const body = handlerMatch[0];

  assert.match(body, /interaction\.deferReply/, 'must acknowledge the interaction immediately');
  assert.match(body, /interaction\.user\.id !== BOT_OWNER_DISCORD_ID/, 'must be gated the same way /post-update is — an in-handler identity check, not a Discord-level command-visibility restriction');
  assert.match(body, /runMatchmakerSetupForAllGuilds\(client\)/, 'must reuse the shared orchestration function, not duplicate the guild loop inline');
  assert.match(body, /dmUser\(client, BOT_OWNER_DISCORD_ID, \{ content: buildRefreshAllSummaryMessage\(result\) \}\)/, 'the final result must be reported via a DM, not by editing the original interaction reply');
});

test('index.js: /refresh-all-servers is distinct from /post-update — a separate commandName branch, not folded into the existing handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(source, /commandName === 'post-update'/);
  assert.match(source, /commandName === 'refresh-all-servers'/);
});
