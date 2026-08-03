// Verifies PART 2 — stable tournament identity prevents naming-logic changes from creating
// duplicate posts. Root cause (before this fix): createTournamentChannel's dedupe check was a
// literal Discord channel *name* match — so any naming-logic change (has happened repeatedly)
// made the same real tournament look brand-new, leaving the old, now-incorrectly-named channel to
// sit as an orphaned duplicate until its own deletion timer eventually cleared it, on every server,
// every time.
//
// Also covers item #3 of the forum-post migration directly: findExistingTournamentChannel's
// no-eventId fallback used to match by category membership (one category per region); one shared
// forum now holds every region's posts, so region is disambiguated by an APPLIED TAG instead —
// two same-named tournaments in different regions must never collide with each other.
//
// Exercises the real createTournamentChannel (not a reimplementation) against a lightweight fake
// Discord guild/forum. DeletedTournamentChannelModel.findOne is stubbed (same "stub the Model, not
// the module" precedent as test/store-selective-persistence.test.js) purely to avoid a real
// MongoDB dependency — createTournamentChannel calls it for every tournament that has an eventId,
// which every one of these does.
const test = require('node:test');
const assert = require('node:assert/strict');

const DeletedTournamentChannelModel = require('../models/DeletedTournamentChannel');

const originalFindOne = DeletedTournamentChannelModel.findOne;
test.before(() => { DeletedTournamentChannelModel.findOne = () => ({ lean: async () => null }); });
test.after(() => { DeletedTournamentChannelModel.findOne = originalFindOne; });

const FORUM_ID = 'forum-1';
const REGION_TAG_IDS = { EU: 'tag-eu', NAC: 'tag-nac', ME: 'tag-me' };

// Simulates a real forum post: a thread whose id/name/appliedTags/parentId behave like discord.js's
// real ThreadChannel for exactly what findExistingTournamentChannel/createTournamentChannel read —
// c.name, c.parentId, c.appliedTags, plus setName (rename-in-place).
function makeFakeThread(id, name, appliedTags = []) {
  const thread = {
    id, name, parentId: FORUM_ID, appliedTags,
    setNameCalls: [],
    async setName(newName) {
      thread.setNameCalls.push(newName);
      thread.name = newName;
      return thread;
    },
  };
  return thread;
}

function makeFakeGuild(id, existingThreads = []) {
  const channelsById = new Map(existingThreads.map(c => [c.id, c]));
  let nextId = 1000;
  let createCalls = 0;

  const forum = {
    id: FORUM_ID,
    threads: {
      create: async ({ name, appliedTags }) => {
        createCalls++;
        const thread = makeFakeThread(String(nextId++), name, appliedTags ?? []);
        channelsById.set(thread.id, thread);
        return thread;
      },
    },
  };
  channelsById.set(FORUM_ID, forum);

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

async function withGuildConfigStub(stubExports, fn) {
  const guildConfigPath = require.resolve('../guild-config');
  const channelManagerPath = require.resolve('../channel-manager');
  const previous = require.cache[guildConfigPath];
  delete require.cache[guildConfigPath];
  delete require.cache[channelManagerPath];

  require.cache[guildConfigPath] = { id: guildConfigPath, filename: guildConfigPath, loaded: true, exports: stubExports };

  const freshChannelManager = require('../channel-manager');
  try {
    return await fn(freshChannelManager);
  } finally {
    // Each stubbed call gets its own fresh channel-manager module instance (a fresh require after
    // deleting it from the cache above), so its armDeletionTimer real setTimeouts live on THIS
    // instance's own managedChannels — a different object than the top-level channelManager import
    // this file also holds. Clearing here (not just via the top-level clearAllManagedTimers) is
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

function guildConfigStub() {
  return {
    getChannelId: (g, k) => (k === 'tournamentForum' ? FORUM_ID : null),
    getTagId: (g, region) => REGION_TAG_IDS[region] ?? null,
    getRoleId: () => null,
  };
}

test('a channel tracked under an old name gets renamed in place, not duplicated, when naming logic changes', async () => {
  await withGuildConfigStub(guildConfigStub(), async (cm) => {
    const oldThread = makeFakeThread('ch1', 'old-wrong-name', [REGION_TAG_IDS.EU]);
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
    assert.equal(channelsById.size, 2, 'still exactly one post for this tournament (plus the forum itself)');
    assert.deepEqual(oldThread.setNameCalls, [cm.buildChannelName('New Correct Tournament Name')]);
    assert.equal(pinnedMessages.ch1.tournamentName, 'New Correct Tournament Name');
  });
});

test('a genuinely new tournament (no existing post matches its identity) still creates normally', async () => {
  await withGuildConfigStub(guildConfigStub(), async (cm) => {
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
    assert.equal(channelsById.size, 2); // forum + the one new post
    const created = [...channelsById.values()].find(c => c.id !== FORUM_ID);
    assert.equal(created.name, cm.buildChannelName('Brand New Cup'));
    assert.deepEqual(created.appliedTags, [REGION_TAG_IDS.EU]);

    const pinnedEntry = Object.values(pinnedMessages).find(p => p.tournamentEventId === 'epicgames_brandnew_EU');
    assert.ok(pinnedEntry, 'new post must be tracked under its stable eventId');
    assert.equal(pinnedEntry.tournamentName, 'Brand New Cup');
  });
});

test('re-running with no naming change is a pure no-op: no rename, no new post', async () => {
  await withGuildConfigStub(guildConfigStub(), async (cm) => {
    const correctName = cm.buildChannelName('Already Correctly Named Cup');
    const existingThread = makeFakeThread('ch2', correctName, [REGION_TAG_IDS.EU]);
    const { guild, channelsById, getCreateCalls } = makeFakeGuild('guild1', [existingThread]);

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
    assert.equal(channelsById.size, 2);
    assert.deepEqual(existingThread.setNameCalls, [], 'must not call setName when the name already matches');
    assert.equal(pinnedMessages.ch2.tournamentName, 'Already Correctly Named Cup');
  });
});

test('two different tournaments (different eventIds) never collide even with similar names', async () => {
  await withGuildConfigStub(guildConfigStub(), async (cm) => {
    const { guild, channelsById, getCreateCalls } = makeFakeGuild('guild1', []);
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
    assert.equal(channelsById.size, 3); // forum + 2 posts
  });
});

// Item #3's actual crux: with every region sharing ONE forum now, a same-titled tournament in a
// different region must be disambiguated by its applied TAG, not by category/parent alone — the
// same parentId (the shared forum) is no longer enough on its own. Deliberately has NO eventId (a
// raw, never-before-seen session with the same title in two regions) so this exercises
// findExistingTournamentChannel's name+tag fallback match specifically, not the eventId path.
test('the SAME tournament title in two different regions, with no eventId to disambiguate by, are treated as two separate posts (tag-based match, not the old category-based one)', async () => {
  await withGuildConfigStub(guildConfigStub(), async (cm) => {
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

    assert.equal(getCreateCalls(), 2, 'same title, different region tags — must NOT be treated as the same existing post');
    const posts = [...channelsById.values()].filter(c => c.id !== FORUM_ID);
    assert.equal(posts.length, 2);
    assert.deepEqual(posts.map(p => p.appliedTags).sort(), [[REGION_TAG_IDS.NAC], [REGION_TAG_IDS.EU]].sort());
  });
});

test('re-running the SAME region+title (still no eventId) correctly matches the existing post instead of duplicating it', async () => {
  await withGuildConfigStub(guildConfigStub(), async (cm) => {
    const { guild, channelsById, getCreateCalls } = makeFakeGuild('guild1', []);
    const pinnedMessages = {};

    const tournament = {
      name: 'Weekly Skin Cup', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: null,
    };

    await cm.createTournamentChannel(guild, tournament, pinnedMessages);
    await cm.createTournamentChannel(guild, { ...tournament }, pinnedMessages);

    assert.equal(getCreateCalls(), 1, 'the second call must find and reuse the first call\'s post, not create a duplicate');
    assert.equal([...channelsById.values()].filter(c => c.id !== FORUM_ID).length, 1);
  });
});
