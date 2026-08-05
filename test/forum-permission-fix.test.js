// Verifies the fix for a real production error, repeated across multiple tournaments: "Failed to
// create forum post {name}: Missing Permissions".
//
// Root cause (confirmed by reading permissions.js's enforceTournamentForumChannels): every one of
// the 9 region×build-mode tournament forums gets @everyone's EmbedLinks explicitly DENIED
// (test/tournament-channel-visibility.test.js already covers that half). grantBotAccess — the
// overwrite meant to keep the bot itself able to act in a channel where @everyone is locked down —
// used to grant only ViewChannel+SendMessages, completely silent on EmbedLinks. Per Discord's
// overwrite-resolution model, a member-specific overwrite only overrides the exact bits it
// mentions; anything it's silent on falls through to the role-level result, so the bot inherited
// @everyone's EmbedLinks deny on these forums. Since every tournament forum post includes an embed
// (buildTournamentEmbed/buildRankedCupTournamentEmbed), sending one requires EmbedLinks — hence the
// failure. CreatePublicThreads/SendMessagesInThreads are granted alongside it defensively (Discord
// may require them for forum-thread creation specifically, distinct from plain SendMessages; no
// downside to holding a permission that turns out not to be strictly required).
//
// Also verifies the accompanying diagnostics improvement: Discord's real 403/50013 response body
// never says which permission was missing (confirmed by reading @discordjs/rest's DiscordAPIError
// source — it only flattens error.errors, which Discord doesn't populate for a blanket permission
// failure), so the fix logs err.code/err.status plus a proactive permissionsFor(bot).missing(...)
// diff instead of just err.message.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const DeletedTournamentChannelModel = require('../models/DeletedTournamentChannel');

// Same require-cache-swap precedent as test/tournament-channel-visibility.test.js.
async function withStubbedGuildConfig(stubExports, fn) {
  const guildConfigPath = require.resolve('../guild-config');
  const dependents = ['../channel-manager', '../permissions'].map(require.resolve);
  const previousGuildConfig = require.cache[guildConfigPath];
  const previousDependents = dependents.map(p => require.cache[p]);
  delete require.cache[guildConfigPath];
  for (const p of dependents) delete require.cache[p];

  require.cache[guildConfigPath] = {
    id: guildConfigPath, filename: guildConfigPath, loaded: true, exports: stubExports,
  };

  const originalFindOne = DeletedTournamentChannelModel.findOne;
  DeletedTournamentChannelModel.findOne = () => ({ lean: async () => null });

  try {
    const channelManager = require('../channel-manager');
    const permissions = require('../permissions');
    return await fn(channelManager, permissions);
  } finally {
    delete require.cache[guildConfigPath];
    for (const p of dependents) delete require.cache[p];
    if (previousGuildConfig) require.cache[guildConfigPath] = previousGuildConfig;
    dependents.forEach((p, i) => { if (previousDependents[i]) require.cache[p] = previousDependents[i]; });
    DeletedTournamentChannelModel.findOne = originalFindOne;
  }
}

function forumId(region, buildMode) {
  return `forum-${region}-${buildMode}`;
}

function getChannelIdStub(g, k) {
  const match = k.match(/^tournamentForum_(EU|NAC|ME)_(battle_royale|zero_build|reload)$/);
  return match ? forumId(match[1], match[2]) : null;
}

function makeFakeForum(id, { throwOnCreate } = {}) {
  const capturedOverwrites = {};
  const createdThreads = [];

  const forum = {
    id,
    name: id,
    permissionOverwrites: {
      edit: async (target, perms) => {
        const targetId = typeof target === 'string' ? target : target.id;
        capturedOverwrites[targetId] = { ...capturedOverwrites[targetId], ...perms };
      },
    },
    // Real forum.permissionsFor(member) returns a PermissionsBitField-like object with .missing().
    // Modeled here directly off what's actually granted via capturedOverwrites, so the test proves
    // the fix's diff logic reacts to REAL granted/denied state, not a canned answer.
    // Real discord.js's PermissionsBitField#missing(bits) returns the missing flags as their
    // STRING names (e.g. ['EmbedLinks']), not raw bit values — mirrored here so this fixture
    // matches what channel-manager.js's real .join(', ') call actually receives.
    permissionsFor: (member) => {
      const granted = capturedOverwrites[member.id] || {};
      return {
        missing: (bits) => bits
          .map(bit => Object.keys(PermissionFlagsBits).find(k => PermissionFlagsBits[k] === bit))
          .filter(flagName => granted[flagName] !== true),
      };
    },
    threads: {
      create: async ({ name, message }) => {
        if (throwOnCreate) {
          const err = new Error('Missing Permissions');
          err.code = 50013;
          err.status = 403;
          throw err;
        }
        const thread = { id: `${id}-thread-${createdThreads.length + 1}`, name, parentId: id };
        createdThreads.push({ thread, message });
        return thread;
      },
    },
  };
  return { forum, createdThreads, getCapturedOverwrites: () => capturedOverwrites };
}

function makeFakeGuild({ throwOnCreate } = {}) {
  const forums = {};
  const channelsById = new Map();

  for (const region of ['EU', 'NAC', 'ME']) {
    for (const buildMode of ['battle_royale', 'zero_build', 'reload']) {
      const id = forumId(region, buildMode);
      const built = makeFakeForum(id, { throwOnCreate });
      forums[`${region}_${buildMode}`] = built;
      channelsById.set(id, built.forum);
    }
  }

  const guild = {
    id: 'guild1',
    roles: {
      everyone: {
        id: 'everyone-role-id',
        permissions: { remove: () => ({ bitfield: 0n }), bitfield: 0n },
        setPermissions: async () => {},
      },
    },
    members: { me: { id: 'bot-id' } },
    client: { user: { id: 'bot-id' } },
    channels: {
      cache: { find: () => undefined },
      fetch: async (id) => channelsById.get(id) ?? null,
    },
  };
  return { guild, forums };
}

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

function baseTournament(overrides = {}) {
  return {
    name: 'Some Cup',
    region: 'EU',
    beginTime: futureIso(20),
    lastBeginTime: futureIso(20),
    isTrios: false,
    consoleOnly: false,
    isPermanent: false,
    eventId: 'epicgames_somecup_EU',
    ...overrides,
  };
}

test('enforceTournamentForumChannels -> grantBotAccess: the bot itself gets EmbedLinks + thread-creation permissions on every one of the 9 forums, not just ViewChannel/SendMessages', async () => {
  await withStubbedGuildConfig(
    { getChannelId: getChannelIdStub, getRoleId: () => null, getCreativeChannelInfo: () => null },
    async (channelManager, permissions) => {
      const { guild, forums } = makeFakeGuild();
      await permissions.enforcePermissions(guild);

      for (const [key, { getCapturedOverwrites }] of Object.entries(forums)) {
        const botOverwrite = getCapturedOverwrites()['bot-id'];
        assert.ok(botOverwrite, `bot must have an explicit overwrite on the ${key} forum`);
        assert.equal(botOverwrite.ViewChannel, true, `${key}: bot must be able to view`);
        assert.equal(botOverwrite.SendMessages, true, `${key}: bot must be able to send`);
        assert.equal(botOverwrite.EmbedLinks, true, `${key}: bot must be able to embed — this was the real production gap (@everyone has EmbedLinks denied on every forum, and the bot's own overwrite used to be silent on it, so the bot inherited that deny)`);
        assert.equal(botOverwrite.CreatePublicThreads, true, `${key}: bot must be able to create forum posts`);
        assert.equal(botOverwrite.SendMessagesInThreads, true, `${key}: bot must be able to send inside a forum post's thread`);
      }
    }
  );
});

test('createTournamentChannel: a 50013 Missing Permissions failure logs err.code/err.status (not just the generic message)', async () => {
  await withStubbedGuildConfig(
    { getChannelId: getChannelIdStub },
    async (channelManager) => {
      const { guild } = makeFakeGuild({ throwOnCreate: true });
      const originalError = console.error;
      const logged = [];
      console.error = (...args) => logged.push(args.join(' '));
      try {
        await channelManager.createTournamentChannel(guild, baseTournament(), {});
      } finally {
        console.error = originalError;
      }

      const failureLine = logged.find(l => l.includes('Failed to create forum post'));
      assert.ok(failureLine, 'expected a "Failed to create forum post" log line');
      assert.match(failureLine, /\[50013\/403\]/, 'must surface DiscordAPIError\'s real code/status, not just err.message');
    }
  );
});

test('createTournamentChannel: when the bot is missing a real permission on the forum (e.g. EmbedLinks denied), the failure is logged with a specific permission diff', async () => {
  await withStubbedGuildConfig(
    { getChannelId: getChannelIdStub },
    async (channelManager) => {
      const { guild, forums } = makeFakeGuild({ throwOnCreate: true });
      // Simulate the real production gap directly: bot has ViewChannel+SendMessages but NOT
      // EmbedLinks on this forum (the exact overwrite shape the old grantBotAccess used to produce).
      await forums.EU_battle_royale.forum.permissionOverwrites.edit(guild.members.me, { ViewChannel: true, SendMessages: true });

      const originalError = console.error;
      const logged = [];
      console.error = (...args) => logged.push(args.join(' '));
      try {
        await channelManager.createTournamentChannel(guild, baseTournament(), {});
      } finally {
        console.error = originalError;
      }

      const diffLine = logged.find(l => l.includes('Missing on #'));
      assert.ok(diffLine, 'expected a specific permission-diff log line, not just the generic Discord error');
      assert.match(diffLine, /EmbedLinks/, 'must name EmbedLinks specifically, since that is the permission actually absent in this scenario');
    }
  );
});
