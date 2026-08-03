// Verifies PART 2 — stable tournament identity prevents naming-logic changes from creating
// duplicate posts. Root cause (before this fix): createTournamentChannel's dedupe check was a
// literal Discord channel *name* match — so any naming-logic change (has happened repeatedly)
// made the same real tournament look brand-new, leaving the old, now-incorrectly-named channel to
// sit as an orphaned duplicate until its own deletion timer eventually cleared it, on every server,
// every time.
//
// Also covers the forum-restructure's core requirement directly: a tournament routes into the
// correct ONE of 9 forums (region × build-mode), and findExistingTournamentChannel's no-eventId
// fallback correctly disambiguates by forum identity (parentId) alone now — there's no longer a
// shared forum + tag to worry about; each of the 9 forums is already region+build-mode-specific by
// construction, the same way the original per-region categories were.
//
// Exercises the real createTournamentChannel (not a reimplementation) against a lightweight fake
// Discord guild with all 9 region×build-mode forums pre-built (deterministic IDs via forumId()
// below, so a test can seed an "already exists" thread under the exact right one without a
// chicken-and-egg problem). DeletedTournamentChannelModel.findOne is stubbed (same "stub the
// Model, not the module" precedent as test/store-selective-persistence.test.js) purely to avoid a
// real MongoDB dependency — createTournamentChannel calls it for every tournament that has an
// eventId, which most of these do.
const test = require('node:test');
const assert = require('node:assert/strict');

const DeletedTournamentChannelModel = require('../models/DeletedTournamentChannel');

const originalFindOne = DeletedTournamentChannelModel.findOne;
test.before(() => { DeletedTournamentChannelModel.findOne = () => ({ lean: async () => null }); });
test.after(() => { DeletedTournamentChannelModel.findOne = originalFindOne; });

const REGIONS = ['EU', 'NAC', 'ME'];
const BUILD_MODE_KEYS = ['battle_royale', 'zero_build', 'reload'];

// Deterministic (not random) so a test can reference "the EU/zero_build forum's id" directly when
// seeding a pre-existing thread, without needing makeFakeGuild to hand the id back first.
function forumId(region, buildMode) {
  return `forum-${region}-${buildMode}`;
}

// Simulates a real forum post: a thread whose id/name/parentId behave like discord.js's real
// ThreadChannel for exactly what findExistingTournamentChannel/createTournamentChannel read —
// c.name, c.parentId, plus setName (rename-in-place). No appliedTags at all — routing is by which
// forum (parentId) the thread lives in now, not a tag.
function makeFakeThread(id, name, parentId) {
  const thread = {
    id, name, parentId,
    setNameCalls: [],
    async setName(newName) {
      thread.setNameCalls.push(newName);
      thread.name = newName;
      return thread;
    },
  };
  return thread;
}

// Pre-builds all 9 region×build-mode forums (real /matchmaker-setup creates exactly these — see
// matchmaker-setup.js's TOURNAMENT_FORUM_SPECS) plus any pre-seeded existing threads.
function makeFakeGuild(id, existingThreads = []) {
  const channelsById = new Map(existingThreads.map(c => [c.id, c]));
  let nextId = 1000;
  let createCalls = 0;

  for (const region of REGIONS) {
    for (const buildMode of BUILD_MODE_KEYS) {
      const fid = forumId(region, buildMode);
      channelsById.set(fid, {
        id: fid,
        threads: {
          create: async ({ name }) => {
            createCalls++;
            const thread = makeFakeThread(String(nextId++), name, fid);
            channelsById.set(thread.id, thread);
            return thread;
          },
        },
      });
    }
  }

  const guild = {
    id,
    roles: { everyone: `everyone-${id}` },
    client: { user: { id: 'bot-id' } },
    channels: {
      cache: { find: predicate => [...channelsById.values()].find(predicate) },
      fetch: async cid => channelsById.get(cid) ?? null,
    },
  };

  return { guild, channelsById, getCreateCalls: () => createCalls };
}

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

async function withGuildConfigStub(fn) {
  const guildConfigPath = require.resolve('../guild-config');
  const channelManagerPath = require.resolve('../channel-manager');
  const previous = require.cache[guildConfigPath];
  delete require.cache[guildConfigPath];
  delete require.cache[channelManagerPath];

  require.cache[guildConfigPath] = {
    id: guildConfigPath, filename: guildConfigPath, loaded: true,
    exports: {
      getRoleId: () => null,
      // Purely deterministic (forumId()), independent of any one makeFakeGuild instance — real
      // guild-config.js's getChannelId is just a flat-map lookup too, this mirrors that shape.
      getChannelId: (g, k) => {
        const match = k.match(/^tournamentForum_(EU|NAC|ME)_(battle_royale|zero_build|reload)$/);
        return match ? forumId(match[1], match[2]) : null;
      },
    },
  };

  const freshChannelManager = require('../channel-manager');
  try {
    return await fn(freshChannelManager);
  } finally {
    // Each stubbed call gets its own fresh channel-manager module instance (a fresh require after
    // deleting it from the cache above), so its armDeletionTimer real setTimeouts live on THIS
    // instance's own managedChannels — a different object than any other test's. Clearing here is
    // what actually stops the process from hanging on real multi-hour timers.
    for (const key of Object.keys(freshChannelManager.managedChannels)) {
      clearTimeout(freshChannelManager.managedChannels[key].deleteTimer);
      delete freshChannelManager.managedChannels[key];
    }
    delete require.cache[guildConfigPath];
    delete require.cache[channelManagerPath];
    if (previous) require.cache[guildConfigPath] = previous;
  }
}

test('a channel tracked under an old name gets renamed in place, not duplicated, when naming logic changes', async () => {
  await withGuildConfigStub(async (cm) => {
    // "New Correct Tournament Name" has no build-mode marker -> defaults to battle_royale.
    const oldThread = makeFakeThread('ch1', 'old-wrong-name', forumId('EU', 'battle_royale'));
    const { guild, channelsById, getCreateCalls } = makeFakeGuild('guild1', [oldThread]);

    const pinnedMessages = {
      ch1: {
        guildId: 'guild1',
        tournamentEventId: 'epicgames_test_EU',
        tournamentName: 'Old Tournament Name',
        region: 'EU',
        beginTime: futureIso(20),
        deleteAt: Date.now() + 999999,
        permanent: false,
      },
    };

    const tournament = {
      name: 'New Correct Tournament Name',
      region: 'EU',
      beginTime: futureIso(20),
      lastBeginTime: futureIso(20),
      isTrios: false,
      consoleOnly: false,
      isPermanent: false,
      eventId: 'epicgames_test_EU', // same underlying event — only the rendered name changed
    };

    await cm.createTournamentChannel(guild, tournament, pinnedMessages);

    assert.equal(getCreateCalls(), 0, 'must not create a second post for the same eventId');
    assert.deepEqual(oldThread.setNameCalls, [cm.buildChannelName('New Correct Tournament Name')]);
    assert.equal(pinnedMessages.ch1.tournamentName, 'New Correct Tournament Name');
  });
});

test('a genuinely new tournament (no existing post matches its identity) creates in the correct region×build-mode forum', async () => {
  await withGuildConfigStub(async (cm) => {
    const { guild, channelsById, getCreateCalls } = makeFakeGuild('guild1', []);
    const pinnedMessages = {};

    const tournament = {
      name: 'Brand New Cup',
      region: 'EU',
      beginTime: futureIso(20),
      lastBeginTime: futureIso(20),
      isTrios: false,
      consoleOnly: false,
      isPermanent: false,
      eventId: 'epicgames_brandnew_EU',
    };

    await cm.createTournamentChannel(guild, tournament, pinnedMessages);

    assert.equal(getCreateCalls(), 1, 'must create exactly one new post');
    const created = [...channelsById.values()].find(c => c.setNameCalls !== undefined);
    assert.equal(created.name, cm.buildChannelName('Brand New Cup'));
    assert.equal(created.parentId, forumId('EU', 'battle_royale'), 'no build-mode marker -> defaults to Battle Royale -> the EU/battle_royale forum');

    const pinnedEntry = Object.values(pinnedMessages).find(p => p.tournamentEventId === 'epicgames_brandnew_EU');
    assert.ok(pinnedEntry, 'new post must be tracked under its stable eventId');
    assert.equal(pinnedEntry.tournamentName, 'Brand New Cup');
    assert.equal(pinnedEntry.buildMode, 'battle_royale', 'buildMode must be stamped on the pinned entry too');
  });
});

test('re-running with no naming change is a pure no-op: no rename, no new post', async () => {
  await withGuildConfigStub(async (cm) => {
    const correctName = cm.buildChannelName('Already Correctly Named Cup');
    const existingThread = makeFakeThread('ch2', correctName, forumId('EU', 'battle_royale'));
    const { guild, getCreateCalls } = makeFakeGuild('guild1', [existingThread]);

    const pinnedMessages = {
      ch2: {
        guildId: 'guild1',
        tournamentEventId: 'epicgames_stable_EU',
        tournamentName: 'Already Correctly Named Cup',
        region: 'EU',
        beginTime: futureIso(20),
        deleteAt: Date.now() + 999999,
        permanent: false,
      },
    };

    const tournament = {
      name: 'Already Correctly Named Cup',
      region: 'EU',
      beginTime: futureIso(20),
      lastBeginTime: futureIso(20),
      isTrios: false,
      consoleOnly: false,
      isPermanent: false,
      eventId: 'epicgames_stable_EU',
    };

    await cm.createTournamentChannel(guild, tournament, pinnedMessages);

    assert.equal(getCreateCalls(), 0);
    assert.deepEqual(existingThread.setNameCalls, [], 'must not call setName when the name already matches');
    assert.equal(pinnedMessages.ch2.tournamentName, 'Already Correctly Named Cup');
  });
});

test('two different tournaments (different eventIds) never collide even with similar names', async () => {
  await withGuildConfigStub(async (cm) => {
    const { channelsById, guild, getCreateCalls } = makeFakeGuild('guild1', []);
    const pinnedMessages = {};

    const br = {
      name: 'Some Cup Battle Royale', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: 'epicgames_somecup_EU',
    };
    const zb = {
      name: 'Some Cup Zero Build', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: 'epicgames_somecup_ZB_EU',
    };

    await cm.createTournamentChannel(guild, br, pinnedMessages);
    await cm.createTournamentChannel(guild, zb, pinnedMessages);

    assert.equal(getCreateCalls(), 2, 'distinct eventIds must produce two distinct posts');
    const posts = [...channelsById.values()].filter(c => c.setNameCalls !== undefined);
    assert.equal(posts.length, 2);
    // Same region, but genuinely different build modes -> two DIFFERENT forums, not just two
    // different posts in the same one.
    assert.deepEqual(posts.map(p => p.parentId).sort(), [forumId('EU', 'battle_royale'), forumId('EU', 'zero_build')].sort());
  });
});

// The forum-restructure's actual crux: with 9 separate forums now (one per region×build-mode),
// region AND build mode both need to independently route a tournament into the correct one —
// neither dimension alone is enough to reuse the old "one shared thing, disambiguate the rest"
// approach. Deliberately has NO eventId (a raw, never-before-seen session) so this exercises
// findExistingTournamentChannel's name+forum fallback match specifically, not the eventId path.
test('the SAME tournament title in two different regions (same build mode) route into two different forums, never collide', async () => {
  await withGuildConfigStub(async (cm) => {
    const { guild, channelsById, getCreateCalls } = makeFakeGuild('guild1', []);
    const pinnedMessages = {};

    const euVersion = {
      name: 'Weekly Skin Cup', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: null,
    };
    const nacVersion = {
      name: 'Weekly Skin Cup', region: 'NAC', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: null,
    };

    await cm.createTournamentChannel(guild, euVersion, pinnedMessages);
    await cm.createTournamentChannel(guild, nacVersion, pinnedMessages);

    assert.equal(getCreateCalls(), 2, 'same title, different regions — must NOT be treated as the same existing post');
    const posts = [...channelsById.values()].filter(c => c.setNameCalls !== undefined);
    assert.equal(posts.length, 2);
    assert.deepEqual(posts.map(p => p.parentId).sort(), [forumId('EU', 'battle_royale'), forumId('NAC', 'battle_royale')].sort());
  });
});

test('the SAME region+title but a DIFFERENT build mode routes into a different forum, never collides with the other build mode\'s post', async () => {
  await withGuildConfigStub(async (cm) => {
    const { guild, channelsById, getCreateCalls } = makeFakeGuild('guild1', []);
    const pinnedMessages = {};

    const brVersion = {
      name: 'Weekly Skin Cup', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: null,
    };
    const reloadVersion = {
      name: 'Weekly Skin Cup (Reload)', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: null,
    };

    await cm.createTournamentChannel(guild, brVersion, pinnedMessages);
    await cm.createTournamentChannel(guild, reloadVersion, pinnedMessages);

    assert.equal(getCreateCalls(), 2);
    const posts = [...channelsById.values()].filter(c => c.setNameCalls !== undefined);
    assert.deepEqual(posts.map(p => p.parentId).sort(), [forumId('EU', 'battle_royale'), forumId('EU', 'reload')].sort());
  });
});

test('re-running the SAME region+title+build-mode (still no eventId) correctly matches the existing post instead of duplicating it', async () => {
  await withGuildConfigStub(async (cm) => {
    const { guild, channelsById, getCreateCalls } = makeFakeGuild('guild1', []);
    const pinnedMessages = {};

    const tournament = {
      name: 'Weekly Skin Cup', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: null,
    };

    await cm.createTournamentChannel(guild, tournament, pinnedMessages);
    await cm.createTournamentChannel(guild, { ...tournament }, pinnedMessages);

    assert.equal(getCreateCalls(), 1, 'the second call must find and reuse the first call\'s post, not create a duplicate');
    assert.equal([...channelsById.values()].filter(c => c.setNameCalls !== undefined).length, 1);
  });
});
