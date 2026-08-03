// Verifies requirement 1's channel-visibility half, reworked for the forum-restructure: every
// tournament post (any region, build mode, console-only or not) is visible to @everyone — region/
// console Discord roles never gate ViewChannel, even when those roles ARE configured for the guild.
//
// This used to be a per-post permissionOverwrites array passed to guild.channels.create(). A
// forum THREAD can't hold its own overwrites independent of its parent forum channel (confirmed
// via discord.js source: ThreadChannel has no .permissionOverwrites at all, and
// GuildForumThreadManager#create's options don't accept any) — so createTournamentChannel never
// sets permissions at all; permissions.js's enforceTournamentForumChannels (part of
// enforcePermissions) sets them on EACH of the 9 region×build-mode tournament forums instead,
// which every post inherits from its own forum. Both halves are exercised here: createTournamentChannel
// creates a post with no per-post overwrite logic to break, and enforcePermissions is what actually
// proves visibility, across more than one of the 9 forums (not just the one a single test happens
// to create a post in).
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

// Deterministic (not random) so getChannelId's stub below can map a composite key straight to an
// id without needing a live guild instance first — same precedent as
// test/tournament-channel-rename.test.js's forumId().
function forumId(region, buildMode) {
  return `forum-${region}-${buildMode}`;
}

function getChannelIdStub(g, k) {
  const match = k.match(/^tournamentForum_(EU|NAC|ME)_(battle_royale|zero_build|reload)$/);
  return match ? forumId(match[1], match[2]) : null;
}

function makeFakeForum(id) {
  const capturedOverwrites = {}; // targetId -> permissions object last set
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
    threads: {
      create: async ({ name, message }) => {
        const thread = { id: `${id}-thread-${createdThreads.length + 1}`, name, parentId: id };
        createdThreads.push({ thread, message });
        return thread;
      },
    },
  };
  return { forum, createdThreads, getCapturedOverwrites: () => capturedOverwrites };
}

// Builds all 9 region×build-mode forums (real /matchmaker-setup creates exactly these) so
// enforcePermissions' loop over every one of them can be genuinely exercised, not just a single
// stand-in forum.
function makeFakeGuild() {
  const forums = {}; // 'EU_battle_royale' -> {forum, createdThreads, getCapturedOverwrites}
  const channelsById = new Map();

  for (const region of ['EU', 'NAC', 'ME']) {
    for (const buildMode of ['battle_royale', 'zero_build', 'reload']) {
      const id = forumId(region, buildMode);
      const built = makeFakeForum(id);
      forums[`${region}_${buildMode}`] = built;
      channelsById.set(id, built.forum);
    }
  }

  const guild = {
    id: 'guild1',
    roles: {
      // Full role-shape (not a bare string) — enforcePermissions' lockGuildBasePermissions calls
      // .permissions.remove()/.setPermissions() on it directly, before
      // enforceTournamentForumChannels ever runs.
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

test('createTournamentChannel: creates a forum post (in the correct region×build-mode forum) with no per-post permission logic to break', async () => {
  await withStubbedGuildConfig(
    { getChannelId: getChannelIdStub },
    async (channelManager) => {
      const { guild, forums } = makeFakeGuild();
      await channelManager.createTournamentChannel(guild, baseTournament(), {});

      const { createdThreads } = forums.EU_battle_royale; // "Some Cup" has no build-mode marker -> defaults to Battle Royale
      assert.equal(createdThreads.length, 1, 'exactly one forum post should be created, in the EU/battle_royale forum');

      clearTimeout(channelManager.managedChannels[createdThreads[0].thread.id]?.deleteTimer);
    }
  );
});

test('enforcePermissions -> enforceTournamentForumChannels: @everyone gets ViewChannel allowed + AttachFiles/EmbedLinks denied on EVERY one of the 9 forums, even with NO mod role configured', async () => {
  await withStubbedGuildConfig(
    {
      getChannelId: getChannelIdStub,
      getRoleId: () => null,
      getCreativeChannelInfo: () => null,
    },
    async (channelManager, permissions) => {
      const { guild, forums } = makeFakeGuild();
      await permissions.enforcePermissions(guild);

      for (const [key, { getCapturedOverwrites }] of Object.entries(forums)) {
        const overwrites = getCapturedOverwrites();
        const everyoneOverwrite = overwrites['everyone-role-id'];
        assert.ok(everyoneOverwrite, `@everyone must have an explicit overwrite on the ${key} forum`);
        assert.equal(everyoneOverwrite.ViewChannel, true, `ViewChannel must be allowed for @everyone on ${key}`);
        assert.equal(everyoneOverwrite.AttachFiles, false);
        assert.equal(everyoneOverwrite.EmbedLinks, false);
      }
    }
  );
});

test('enforcePermissions -> enforceTournamentForumChannels: mod role gets ViewChannel+SendMessages on the forum when configured — same for a console-only tournament\'s post (no per-post/per-role Console gate exists anymore)', async () => {
  await withStubbedGuildConfig(
    {
      getChannelId: getChannelIdStub,
      getRoleId: (g, k) => (k === 'mod' ? 'mod-role-id' : (k === 'Console' ? 'console-role-id' : null)),
      getCreativeChannelInfo: () => null,
    },
    async (channelManager, permissions) => {
      const { guild, forums } = makeFakeGuild();

      // A console-only tournament's post is created exactly the same way as any other — no
      // per-role Console overwrite is ever built for it (confirmed by there being no such code
      // path left in createTournamentChannel at all, not just by an absent overwrite here).
      await channelManager.createTournamentChannel(guild, baseTournament({ consoleOnly: true, eventId: 'epicgames_consolecup_EU' }), {});
      const { createdThreads } = forums.EU_battle_royale;
      assert.equal(createdThreads.length, 1);
      clearTimeout(channelManager.managedChannels[createdThreads[0].thread.id]?.deleteTimer);

      await permissions.enforcePermissions(guild);

      for (const [key, { getCapturedOverwrites }] of Object.entries(forums)) {
        const overwrites = getCapturedOverwrites();

        const everyoneOverwrite = overwrites['everyone-role-id'];
        assert.ok(everyoneOverwrite);
        assert.equal(everyoneOverwrite.ViewChannel, true, `@everyone must see the ${key} forum too — no per-tournament distinction`);

        const modOverwrite = overwrites['mod-role-id'];
        assert.ok(modOverwrite, `mod role should get an explicit overwrite on the ${key} forum`);
        assert.equal(modOverwrite.ViewChannel, true);
        assert.equal(modOverwrite.SendMessages, true);

        assert.equal(overwrites['console-role-id'], undefined, `no per-role Console overwrite should exist on ${key} — that gate was removed, not moved`);
      }
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
