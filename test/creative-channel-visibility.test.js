// Verifies requirement 1: creative queue channels (1v1/2v2/6s/8s) are visible to @everyone
// regardless of registration state — the progressive-visibility gate that used to hide them behind
// the Registered role is removed, matching how tournament channels already work (see
// test/tournament-channel-visibility.test.js). Queueing itself still requires the Registered role,
// checked independently at click-time (index.js's creative_queue_/team_queue_ handlers) — verified
// here at the source level since index.js can't be required directly in a test (client.login()
// side effect on load, same constraint documented in test/epic-link-gate.test.js).
//
// Exercises the real enforcePermissions (not a reimplementation) against a fake Discord guild.
// guild-config.js is stubbed at the require-cache level (test/tournament-channel-visibility.test.js's
// precedent) purely to control what getRoleId/getChannelId/getCreativeChannelInfo return without
// hitting MongoDB.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function withStubbedGuildConfig(stubExports, fn) {
  const guildConfigPath = require.resolve('../guild-config');
  const permissionsPath = require.resolve('../permissions');
  const previous = require.cache[guildConfigPath];
  delete require.cache[guildConfigPath];
  delete require.cache[permissionsPath];

  require.cache[guildConfigPath] = { id: guildConfigPath, filename: guildConfigPath, loaded: true, exports: stubExports };

  try {
    const permissions = require('../permissions');
    return fn(permissions);
  } finally {
    delete require.cache[guildConfigPath];
    delete require.cache[permissionsPath];
    if (previous) require.cache[guildConfigPath] = previous;
  }
}

function makeFakeChannel(name) {
  const edits = [];
  return {
    name,
    permissionOverwrites: {
      edit: async (targetId, perms) => { edits.push({ targetId, perms }); },
    },
    edits,
  };
}

// guild.roles.everyone is a single object (matching real discord.js, where it's the actual Role
// object) — editOverwrite passes it directly as the overwrite target, and lockGuildBasePermissions
// (unrelated to what this test targets) separately reads its .permissions, so both need to live on
// the same reference rather than one string and one stub replacing it.
function makeFakeGuild(creativeChannels) {
  const channelsById = new Map(Object.entries(creativeChannels).map(([id, name]) => [id, makeFakeChannel(name)]));
  const everyone = {
    id: 'everyone-role-id',
    permissions: { remove: () => ({ bitfield: 0n }), bitfield: 0n },
    setPermissions: async () => {},
  };
  return {
    id: 'guild1',
    members: { me: { id: 'bot-id' } },
    roles: { everyone },
    channels: { fetch: async (id) => channelsById.get(id) ?? null },
    channelsById,
  };
}

test('enforcePermissions: creative channels get @everyone ViewChannel:true even when the Registered role IS configured', async () => {
  await withStubbedGuildConfig(
    {
      getChannelId: () => null,
      getRoleId: (guildId, key) => (key === 'Registered' ? 'registered-role-id' : (key === 'mod' ? 'mod-role-id' : null)),
      getCreativeChannelInfo: (guildId, category) => ({ channelId: `chan-${category}` }),
    },
    async (permissions) => {
      const guild = makeFakeGuild({
        'chan-1v1': 'creative-1v1', 'chan-2v2': 'creative-2v2', 'chan-6s': 'creative-6s', 'chan-8s': 'creative-8s',
      });

      await permissions.enforcePermissions(guild);

      for (const id of ['chan-1v1', 'chan-2v2', 'chan-6s', 'chan-8s']) {
        const channel = guild.channelsById.get(id);
        const everyoneEdit = channel.edits.find(e => e.targetId === guild.roles.everyone);
        assert.ok(everyoneEdit, `#${channel.name} should have an @everyone overwrite applied`);
        assert.equal(everyoneEdit.perms.ViewChannel, true, `#${channel.name} must have ViewChannel explicitly set true for @everyone, not just left unset`);
        assert.equal(everyoneEdit.perms.AttachFiles, false, `#${channel.name} should still block attachments for @everyone`);
        assert.equal(everyoneEdit.perms.EmbedLinks, false, `#${channel.name} should still block embed links for @everyone`);

        const modEdit = channel.edits.find(e => e.targetId === 'mod-role-id');
        assert.ok(modEdit, `#${channel.name} should still get a mod-role overwrite`);
        assert.equal(modEdit.perms.ViewChannel, true);

        // The old Registered-role gate must be gone entirely — no overwrite keyed to it anymore.
        const registeredEdit = channel.edits.find(e => e.targetId === 'registered-role-id');
        assert.equal(registeredEdit, undefined, `#${channel.name} should no longer have a Registered-role overwrite`);
      }
    }
  );
});

test('enforcePermissions: creative channels get @everyone ViewChannel:true even when NO Registered role is configured yet', async () => {
  await withStubbedGuildConfig(
    {
      getChannelId: () => null,
      getRoleId: (guildId, key) => (key === 'mod' ? 'mod-role-id' : null),
      getCreativeChannelInfo: (guildId, category) => ({ channelId: `chan-${category}` }),
    },
    async (permissions) => {
      const guild = makeFakeGuild({ 'chan-1v1': 'creative-1v1' });
      await permissions.enforcePermissions(guild);

      const channel = guild.channelsById.get('chan-1v1');
      const everyoneEdit = channel.edits.find(e => e.targetId === guild.roles.everyone);
      assert.equal(everyoneEdit.perms.ViewChannel, true);
    }
  );
});

test('index.js: the creative queue-join button still requires the Registered role before actually queueing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const handlerMatch = source.match(/customId\.startsWith\('creative_queue_'\)[\s\S]*?\/\/ ── CREATIVE LEAVE QUEUE/);
  assert.ok(handlerMatch, 'could not locate the creative_queue_ button handler in index.js');
  assert.match(handlerMatch[0], /getRoleId\(guild\.id, 'Registered'\)/);
  assert.match(handlerMatch[0], /Complete your profile in.*first \(set your region\)/);
});

test('index.js: the team (6s/8s) queue-join path still requires every member to hold the Registered role', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const handlerMatch = source.match(/async function finalizeTeamQueueJoin[\s\S]{0,1500}/);
  assert.ok(handlerMatch, 'could not locate finalizeTeamQueueJoin in index.js');
  assert.match(handlerMatch[0], /getRoleId\(guild\.id, 'Registered'\)/);
});
