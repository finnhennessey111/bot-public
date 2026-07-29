// Verifies PART 2 — stable tournament identity prevents naming-logic changes from creating
// duplicate channels. Root cause (before this fix): createTournamentChannel's dedupe check was a
// literal Discord channel *name* match — so any naming-logic change (has happened repeatedly)
// made the same real tournament look brand-new, leaving the old, now-incorrectly-named channel to
// sit as an orphaned duplicate until its own deletion timer eventually cleared it, on every server,
// every time.
//
// Exercises the real createTournamentChannel (not a reimplementation) against a lightweight fake
// Discord guild — channel-manager.js's own dependencies here (guild-config.js's getRoleId/
// getCategoryId, store.js's save) are plain synchronous cache reads / a local data.json write with
// no live MongoDB required, so no stubbing is needed to keep this fast and real.
const test = require('node:test');
const assert = require('node:assert/strict');

const channelManager = require('../channel-manager');

// createTournamentChannel arms a real (multi-hour) setTimeout deletion timer on every successful
// creation (channel-manager.js's armDeletionTimer) — left alone, that keeps the process (and this
// test run) alive well past its actual assertions. managedChannels (already exported) is where
// those timers live; clearing them after each test is cleanup, not something under test itself.
function clearAllManagedTimers() {
  for (const key of Object.keys(channelManager.managedChannels)) {
    clearTimeout(channelManager.managedChannels[key].deleteTimer);
    delete channelManager.managedChannels[key];
  }
}
test.afterEach(clearAllManagedTimers);

function makeFakeChannel(id, name, parentId = null) {
  const channel = {
    id,
    name,
    parentId,
    setNameCalls: [],
    async setName(newName) {
      channel.setNameCalls.push(newName);
      channel.name = newName;
      return channel;
    },
    async send() {
      return { id: `msg-${id}`, async pin() {} };
    },
  };
  return channel;
}

function makeFakeGuild(id, existingChannels = []) {
  const channelsById = new Map(existingChannels.map(c => [c.id, c]));
  let nextId = 1000;
  let createCalls = 0;

  const guild = {
    id,
    roles: { everyone: `everyone-${id}` },
    client: { user: { id: 'bot-id' } },
    channels: {
      cache: { find: predicate => [...channelsById.values()].find(predicate) },
      fetch: async cid => channelsById.get(cid) ?? null,
      async create({ name }) {
        createCalls++;
        const channel = makeFakeChannel(String(nextId++), name);
        channelsById.set(channel.id, channel);
        return channel;
      },
    },
  };

  return { guild, channelsById, getCreateCalls: () => createCalls };
}

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

test('a channel tracked under an old name gets renamed in place, not duplicated, when naming logic changes', async () => {
  const oldChannel = makeFakeChannel('ch1', 'old-wrong-name');
  const { guild, channelsById, getCreateCalls } = makeFakeGuild('guild1', [oldChannel]);

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

  await channelManager.createTournamentChannel(guild, tournament, pinnedMessages);

  assert.equal(getCreateCalls(), 0, 'must not create a second channel for the same eventId');
  assert.equal(channelsById.size, 1, 'still exactly one channel for this tournament');
  assert.deepEqual(oldChannel.setNameCalls, [channelManager.buildChannelName('New Correct Tournament Name')]);
  assert.equal(pinnedMessages.ch1.tournamentName, 'New Correct Tournament Name');
});

test('a genuinely new tournament (no existing channel matches its identity) still creates normally', async () => {
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

  await channelManager.createTournamentChannel(guild, tournament, pinnedMessages);

  assert.equal(getCreateCalls(), 1, 'must create exactly one new channel');
  assert.equal(channelsById.size, 1);
  const created = [...channelsById.values()][0];
  assert.equal(created.name, channelManager.buildChannelName('Brand New Cup'));

  const pinnedEntry = Object.values(pinnedMessages).find(p => p.tournamentEventId === 'epicgames_brandnew_EU');
  assert.ok(pinnedEntry, 'new channel must be tracked under its stable eventId');
  assert.equal(pinnedEntry.tournamentName, 'Brand New Cup');
});

test('re-running with no naming change is a pure no-op: no rename, no new channel', async () => {
  const correctName = channelManager.buildChannelName('Already Correctly Named Cup');
  const existingChannel = makeFakeChannel('ch2', correctName);
  const { guild, channelsById, getCreateCalls } = makeFakeGuild('guild1', [existingChannel]);

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

  await channelManager.createTournamentChannel(guild, tournament, pinnedMessages);

  assert.equal(getCreateCalls(), 0);
  assert.equal(channelsById.size, 1);
  assert.deepEqual(existingChannel.setNameCalls, [], 'must not call setName when the name already matches');
  assert.equal(pinnedMessages.ch2.tournamentName, 'Already Correctly Named Cup');
});

test('two different tournaments (different eventIds) never collide even with similar names', async () => {
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

  await channelManager.createTournamentChannel(guild, br, pinnedMessages);
  await channelManager.createTournamentChannel(guild, zb, pinnedMessages);

  assert.equal(getCreateCalls(), 2, 'distinct eventIds must produce two distinct channels');
  assert.equal(channelsById.size, 2);
});
