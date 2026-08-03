// Verifies requirement 1's channel-visibility half, reworked for the forum-post migration: every
// tournament post (any region, console-only or not) is visible to @everyone — region/console
// Discord roles never gate ViewChannel, even when those roles ARE configured for the guild.
//
// This used to be a per-post permissionOverwrites array passed to guild.channels.create(). A
// forum THREAD can't hold its own overwrites independent of its parent forum channel (confirmed
// via discord.js source: ThreadChannel has no .permissionOverwrites at all, and
// GuildForumThreadManager#create's options don't accept any) — so createTournamentChannel no
// longer sets permissions at all; permissions.js's enforceTournamentForumChannel (part of
// enforcePermissions) sets them ONCE on the shared tournament forum channel instead, which every
// post inherits. Both halves are exercised here: createTournamentChannel creates a post with no
// per-post overwrite logic to break, and enforcePermissions is what actually proves visibility.
//
// Queueing itself still requires the Registered role (unchanged, tested separately by inspecting
// the real index.js source below, since index.js can't be required directly in a test — it calls
// client.login() as a side effect of loading, same constraint documented in
// test/epic-link-gate.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');
const DeletedTournamentChannelModel = require('../models/DeletedTournamentChannel');

const VIEW_CHANNEL = PermissionFlagsBits.ViewChannel;

// async + awaiting fn(...) here (not just returning its promise) matters for a real reason: the
// DeletedTournamentChannelModel.findOne stub below is a property mutation on a shared singleton
// (unlike the guild-config require-cache swap, which channel-manager.js/permissions.js capture by
// destructuring at their own require() time — safe to unwind immediately after). If findOne were
// restored in a finally that ran before fn's own async body actually reached its
// createTournamentChannel call, the real (Mongo-backed) findOne would already be back in place by
// then, silently reintroducing the exact hang this stub exists to avoid.
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

  // createTournamentChannel checks for a prior deletion record before creating — stubbed here
  // (same "stub the Model, not the module" precedent as test/store-selective-persistence.test.js)
  // purely to avoid a real MongoDB dependency; not what these tests are actually about.
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

const FORUM_ID = 'forum-1';

function makeFakeGuild() {
  const capturedOverwrites = {}; // targetId -> permissions object last set
  const createdThreads = [];

  const forum = {
    id: FORUM_ID,
    name: 'tournaments',
    permissionOverwrites: {
      edit: async (target, perms) => {
        const targetId = typeof target === 'string' ? target : target.id;
        capturedOverwrites[targetId] = { ...capturedOverwrites[targetId], ...perms };
      },
    },
    threads: {
      create: async ({ name, message, appliedTags }) => {
        const thread = {
          id: `thread-${createdThreads.length + 1}`,
          name,
          parentId: FORUM_ID,
          appliedTags: appliedTags ?? [],
        };
        createdThreads.push({ thread, message, appliedTags });
        return thread;
      },
    },
  };

  const guild = {
    id: 'guild1',
    roles: {
      // Full role-shape (not a bare string) — enforcePermissions' lockGuildBasePermissions calls
      // .permissions.remove()/.setPermissions() on it directly, before enforceTournamentForumChannel
      // ever runs.
      everyone: {
        id: 'everyone-role-id',
        permissions: { remove: () => ({ bitfield: 0n }), bitfield: 0n },
        setPermissions: async () => {},
      },
    },
    members: { me: { id: 'bot-id' } },
    client: { user: { id: 'bot-id' } },
    channels: {
      cache: { find: () => undefined }, // no existing post — always the "create new" path
      fetch: async (id) => (id === FORUM_ID ? forum : null),
    },
  };
  return { guild, forum, createdThreads, getCapturedOverwrites: () => capturedOverwrites };
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

test('createTournamentChannel: creates a forum post with no per-post permission logic to break (permissions now live on the forum itself)', async () => {
  await withStubbedGuildConfig(
    { getChannelId: (g, k) => (k === 'tournamentForum' ? FORUM_ID : null), getTagId: () => 'eu-tag-id' },
    async (channelManager) => {
      const { guild, createdThreads } = makeFakeGuild();
      await channelManager.createTournamentChannel(guild, baseTournament(), {});

      assert.equal(createdThreads.length, 1, 'exactly one forum post should be created');
      assert.deepEqual(createdThreads[0].appliedTags, ['eu-tag-id']);

      clearTimeout(channelManager.managedChannels[createdThreads[0].thread.id]?.deleteTimer);
    }
  );
});

test('enforcePermissions -> enforceTournamentForumChannel: @everyone gets ViewChannel allowed + AttachFiles/EmbedLinks denied, even with NO mod role configured', async () => {
  await withStubbedGuildConfig(
    {
      getChannelId: (g, k) => (k === 'tournamentForum' ? FORUM_ID : null),
      getRoleId: () => null,
      getCreativeChannelInfo: () => null,
    },
    async (channelManager, permissions) => {
      const { guild, getCapturedOverwrites } = makeFakeGuild();
      await permissions.enforcePermissions(guild);

      const overwrites = getCapturedOverwrites();
      const everyoneOverwrite = overwrites['everyone-role-id'];
      assert.ok(everyoneOverwrite, '@everyone must have an explicit overwrite on the forum');
      assert.equal(everyoneOverwrite.ViewChannel, true, 'ViewChannel must be allowed for @everyone');
      assert.equal(everyoneOverwrite.AttachFiles, false);
      assert.equal(everyoneOverwrite.EmbedLinks, false);
    }
  );
});

test('enforcePermissions -> enforceTournamentForumChannel: mod role gets ViewChannel+SendMessages on the forum when configured — same for a console-only tournament\'s post (no per-post/per-role Console gate exists anymore)', async () => {
  await withStubbedGuildConfig(
    {
      getChannelId: (g, k) => (k === 'tournamentForum' ? FORUM_ID : null),
      getRoleId: (g, k) => (k === 'mod' ? 'mod-role-id' : (k === 'Console' ? 'console-role-id' : null)),
      getTagId: () => 'eu-tag-id',
      getCreativeChannelInfo: () => null,
    },
    async (channelManager, permissions) => {
      const { guild, forum, createdThreads, getCapturedOverwrites } = makeFakeGuild();

      // A console-only tournament's post is created exactly the same way as any other — no
      // per-role Console overwrite is ever built for it (confirmed by there being no such code
      // path left in createTournamentChannel at all, not just by an absent overwrite here).
      await channelManager.createTournamentChannel(guild, baseTournament({ consoleOnly: true, eventId: 'epicgames_consolecup_EU' }), {});
      assert.equal(createdThreads.length, 1);
      clearTimeout(channelManager.managedChannels[createdThreads[0].thread.id]?.deleteTimer);

      await permissions.enforcePermissions(guild);
      const overwrites = getCapturedOverwrites();

      const everyoneOverwrite = overwrites['everyone-role-id'];
      assert.ok(everyoneOverwrite);
      assert.equal(everyoneOverwrite.ViewChannel, true, '@everyone must see a console-only tournament\'s post too — the forum itself has no per-tournament distinction');

      const modOverwrite = overwrites['mod-role-id'];
      assert.ok(modOverwrite, 'mod role should get an explicit overwrite on the forum');
      assert.equal(modOverwrite.ViewChannel, true);
      assert.equal(modOverwrite.SendMessages, true);

      assert.equal(overwrites['console-role-id'], undefined, 'no per-role Console overwrite should exist anywhere — that gate was removed, not moved');
    }
  );
});

// The Registered-role queue gate (a different thing entirely — requirement 1 keeps this) and the
// removal of the console-role queue-blocking check are both verified at the source level: index.js
// can't be required directly in a test (client.login() side effect on load, same constraint
// test/epic-link-gate.test.js documents), so this greps the real handler source instead of
// re-implementing its control flow.
test('index.js: queue_duo/lf2 handler still requires the Registered role before queueing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(source, /Complete your profile in.*first \(set your region\)/);
  assert.match(source, /getRoleId\(guild\.id, 'Registered'\)/);
});

test('index.js: the console-role queue-blocking check (isPCPlayer/isConsolePlayer) is gone', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.doesNotMatch(source, /isPCPlayer/);
  assert.doesNotMatch(source, /isConsolePlayer/);
  assert.doesNotMatch(source, /console-only tournament\. (PC players cannot|You must have the Console role)/);
});
