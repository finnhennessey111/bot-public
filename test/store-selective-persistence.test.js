// Verifies the store.js persistence fix: save(guildId) used to unconditionally do a synchronous
// full-state fs.writeFileSync+renameSync of EVERY collection (pinnedMessages, queues,
// creativeQueues, matchChannels, across every guild) on every single mutation — even when MongoDB
// was the healthy backend of record — and, separately, persistMatchChannels() re-upserted every
// currently-active match-channel group plus ran a deleteMany reconcile scan on every call, not
// just when match channels actually changed. Net effect: the cost of one unrelated queue join
// scaled with total state across the whole bot, not with the one thing that actually changed.
//
// The fix replaces the single save(guildId) with four purpose-specific functions
// (savePinnedMessages/saveQueues/saveMatchChannel/deleteMatchChannel), each of which: (a) only
// does the expensive full JSON sync-write as a genuine fallback when Mongo isn't the backend of
// record (mongoReady === false), never alongside a healthy Mongo, and (b) when Mongo IS the
// backend, touches only the one collection/document that actually changed.
//
// No real MongoDB is configured in this environment (no MONGODB_URI — confirmed via .env.example)
// so the Mongo-ready branch is exercised by monkey-patching the real Mongoose Model classes'
// persistence methods (GuildModel.updateOne, QueueModel.updateOne, MatchChannelModel.updateOne/
// deleteOne) — same precedent as test/scraper-fresh-browser-per-attempt.test.js's puppeteer.launch
// monkeypatch: the real production save*()/persist*() functions run unmodified, only the actual
// network I/O boundary is stubbed. store.js's __setMongoReadyForTesting is a small, clearly-labeled
// test-only seam (see its own comment in store.js) that flips the same mongoReady flag init()
// would otherwise set after a real successful connection — nothing else about the code path
// changes. The JSON-fallback branch needs no such seam: mongoReady is false by default in this
// environment, exactly like a real deployment with no MongoDB configured.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../store');
const GuildModel = require('../models/Guild');
const QueueModel = require('../models/Queue');
const MatchChannelModel = require('../models/MatchChannel');
const { joinQueue, removeFromQueue } = require('../queue');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function readDataFile() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function trackMongoCalls() {
  const calls = {
    guildUpdateOne: [], queueUpdateOne: [],
    matchChannelUpdateOne: [], matchChannelDeleteOne: [], matchChannelDeleteMany: [],
  };
  const originals = {
    guildUpdateOne: GuildModel.updateOne,
    queueUpdateOne: QueueModel.updateOne,
    matchChannelUpdateOne: MatchChannelModel.updateOne,
    matchChannelDeleteOne: MatchChannelModel.deleteOne,
    matchChannelDeleteMany: MatchChannelModel.deleteMany,
  };

  GuildModel.updateOne = async (filter, update, options) => { calls.guildUpdateOne.push({ filter, update, options }); return {}; };
  QueueModel.updateOne = async (filter, update, options) => { calls.queueUpdateOne.push({ filter, update, options }); return {}; };
  MatchChannelModel.updateOne = async (filter, update, options) => { calls.matchChannelUpdateOne.push({ filter, update, options }); return {}; };
  MatchChannelModel.deleteOne = async (filter) => { calls.matchChannelDeleteOne.push({ filter }); return {}; };
  MatchChannelModel.deleteMany = async (filter) => { calls.matchChannelDeleteMany.push({ filter }); return {}; };

  return {
    calls,
    restore() {
      GuildModel.updateOne = originals.guildUpdateOne;
      QueueModel.updateOne = originals.queueUpdateOne;
      MatchChannelModel.updateOne = originals.matchChannelUpdateOne;
      MatchChannelModel.deleteOne = originals.matchChannelDeleteOne;
      MatchChannelModel.deleteMany = originals.matchChannelDeleteMany;
    },
  };
}

// save*() fires the real Mongo persistence off without awaiting it (fire-and-forget — a queue join
// shouldn't block on a Mongo round trip) — give the microtask queue a tick so the mocked call
// actually lands before asserting on it.
function flushMicrotasks() {
  return new Promise(resolve => setImmediate(resolve));
}

// --- Mongo-ready branch: each save*() touches only its own collection/document -----------------

test('saveQueues (Mongo ready): touches only the global queue document — never pinnedMessages or matchChannels', async () => {
  const tracker = trackMongoCalls();
  store.__setMongoReadyForTesting(true);
  try {
    store.queues['Selective Persistence Test Cup'] = { EU: [{ unitId: 'u1' }] };
    store.saveQueues();
    await flushMicrotasks();

    assert.equal(tracker.calls.queueUpdateOne.length, 1, 'exactly one write to the global queue document');
    assert.equal(tracker.calls.guildUpdateOne.length, 0, 'a queue-only mutation must not touch any guild\'s pinnedMessages document');
    assert.equal(tracker.calls.matchChannelUpdateOne.length, 0, 'a queue-only mutation must not touch matchChannels');
    assert.equal(tracker.calls.matchChannelDeleteMany.length, 0, 'a queue-only mutation must never run the old full-collection reconcile scan');
  } finally {
    store.__setMongoReadyForTesting(false);
    tracker.restore();
    delete store.queues['Selective Persistence Test Cup'];
  }
});

test('savePinnedMessages (Mongo ready): touches only this guild\'s document — never queues or matchChannels', async () => {
  const tracker = trackMongoCalls();
  store.__setMongoReadyForTesting(true);
  try {
    store.pinnedMessages['chan-1'] = { guildId: 'guild-1', tournamentName: 'Test Cup', region: 'EU' };
    store.savePinnedMessages('guild-1');
    await flushMicrotasks();

    assert.equal(tracker.calls.guildUpdateOne.length, 1, 'exactly one write to this guild\'s document');
    assert.equal(tracker.calls.guildUpdateOne[0].filter.guildId, 'guild-1');
    assert.equal(tracker.calls.queueUpdateOne.length, 0, 'a pinnedMessages-only mutation must not touch the queue document');
    assert.equal(tracker.calls.matchChannelUpdateOne.length, 0, 'a pinnedMessages-only mutation must not touch matchChannels');
  } finally {
    store.__setMongoReadyForTesting(false);
    tracker.restore();
    delete store.pinnedMessages['chan-1'];
  }
});

test('saveMatchChannel (Mongo ready): upserts only the ONE group that changed, even with other groups present — never queues/pinnedMessages, never a deleteMany scan', async () => {
  const tracker = trackMongoCalls();
  store.__setMongoReadyForTesting(true);
  try {
    // Two groups already exist — proves the fix doesn't just happen to work with a single group.
    store.matchChannels['group-A'] = { groupId: 'group-A', channels: [{ guildId: 'g1', textChannelId: 't1' }], warned: false };
    store.matchChannels['group-B'] = { groupId: 'group-B', channels: [{ guildId: 'g1', textChannelId: 't2' }], warned: false };

    store.saveMatchChannel('group-A');
    await flushMicrotasks();

    assert.equal(tracker.calls.matchChannelUpdateOne.length, 1, 'exactly one match-channel document write — not one per existing group');
    assert.equal(tracker.calls.matchChannelUpdateOne[0].filter.groupId, 'group-A');
    assert.equal(tracker.calls.matchChannelDeleteMany.length, 0, 'an upsert must never trigger the old full-collection reconcile scan');
    assert.equal(tracker.calls.queueUpdateOne.length, 0);
    assert.equal(tracker.calls.guildUpdateOne.length, 0);
  } finally {
    store.__setMongoReadyForTesting(false);
    tracker.restore();
    delete store.matchChannels['group-A'];
    delete store.matchChannels['group-B'];
  }
});

test('deleteMatchChannel (Mongo ready): deletes only the ONE group by a targeted deleteOne — never the old deleteMany scan', async () => {
  const tracker = trackMongoCalls();
  store.__setMongoReadyForTesting(true);
  try {
    store.matchChannels['group-C'] = { groupId: 'group-C', channels: [], warned: false };
    delete store.matchChannels['group-C']; // the real call sites always delete in-memory before calling deleteMatchChannel

    store.deleteMatchChannel('group-C');
    await flushMicrotasks();

    assert.equal(tracker.calls.matchChannelDeleteOne.length, 1, 'exactly one targeted delete');
    assert.equal(tracker.calls.matchChannelDeleteOne[0].filter.groupId, 'group-C');
    assert.equal(tracker.calls.matchChannelDeleteMany.length, 0, 'must never fall back to the old $nin full-collection scan');
    assert.equal(tracker.calls.matchChannelUpdateOne.length, 0);
    assert.equal(tracker.calls.queueUpdateOne.length, 0);
    assert.equal(tracker.calls.guildUpdateOne.length, 0);
  } finally {
    store.__setMongoReadyForTesting(false);
    tracker.restore();
  }
});

// --- Same guarantee through the REAL production call path (queue.js), not just direct store.js calls ---

test('real joinQueue/removeFromQueue (Mongo ready): a single tournament queue join/leave triggers exactly one queue-document write and nothing else', async () => {
  const tracker = trackMongoCalls();
  store.__setMongoReadyForTesting(true);
  const tournamentName = `Selective Persistence Real Join Test ${Math.random()}`;
  try {
    const player = {
      guildId: 'guild-real', discordId: 'player-1', totalPR: 500, matchScore: 500,
      tournamentName, homeRegion: 'EU', queueRegion: 'EU', queueType: 'duo', platform: 'PC',
    };
    await joinQueue({ guildId: 'guild-real', players: [player], tournamentName, region: 'EU', queueType: 'duo' });
    await flushMicrotasks();

    assert.equal(tracker.calls.queueUpdateOne.length, 1, 'joining one tournament queue must write the queue document exactly once');
    assert.equal(tracker.calls.guildUpdateOne.length, 0, 'a queue join must never touch pinnedMessages — this is the actual bug being fixed');
    assert.equal(tracker.calls.matchChannelUpdateOne.length, 0, 'a queue join must never touch matchChannels — this is the actual bug being fixed');
    assert.equal(tracker.calls.matchChannelDeleteMany.length, 0);

    removeFromQueue('guild-real', 'player-1', tournamentName, 'EU');
    await flushMicrotasks();

    assert.equal(tracker.calls.queueUpdateOne.length, 2, 'leaving must also write the queue document exactly once more');
    assert.equal(tracker.calls.guildUpdateOne.length, 0);
    assert.equal(tracker.calls.matchChannelUpdateOne.length, 0);
  } finally {
    store.__setMongoReadyForTesting(false);
    tracker.restore();
    removeFromQueue('guild-real', 'player-1', tournamentName, 'EU');
  }
});

// --- JSON fallback branch: genuinely still works, and only runs when Mongo isn't the backend ---

test('JSON fallback (Mongo NOT ready — the default in this environment): saveQueues actually writes data.json with the real current state', async () => {
  assert.equal(store.pinnedMessages && true, true); // sanity: store module loaded
  const tournamentName = `Selective Persistence JSON Fallback Test ${Math.random()}`;
  try {
    const player = {
      guildId: 'guild-json', discordId: 'player-json-1', totalPR: 777, matchScore: 777,
      tournamentName, homeRegion: 'EU', queueRegion: 'EU', queueType: 'duo', platform: 'PC',
    };
    await joinQueue({ guildId: 'guild-json', players: [player], tournamentName, region: 'EU', queueType: 'duo' });

    const onDisk = readDataFile();
    assert.ok(onDisk.queues[tournamentName], 'the new tournament queue must actually be on disk');
    assert.equal(onDisk.queues[tournamentName].EU.length, 1);
    assert.equal(onDisk.queues[tournamentName].EU[0].members[0].discordId, 'player-json-1');

    removeFromQueue('guild-json', 'player-json-1', tournamentName, 'EU');
    const onDiskAfterLeave = readDataFile();
    assert.equal(onDiskAfterLeave.queues[tournamentName].EU.length, 0, 'leaving must be reflected on disk too — no data loss under the fallback path');
  } finally {
    removeFromQueue('guild-json', 'player-json-1', tournamentName, 'EU');
  }
});

test('JSON fallback (Mongo NOT ready): savePinnedMessages/saveMatchChannel/deleteMatchChannel all still write data.json correctly', async () => {
  const channelId = `chan-fallback-${Math.random()}`;
  const groupId = `group-fallback-${Math.random()}`;
  try {
    store.pinnedMessages[channelId] = { guildId: 'guild-fb', tournamentName: 'Fallback Cup', region: 'EU' };
    store.savePinnedMessages('guild-fb');
    assert.deepEqual(readDataFile().pinnedMessages[channelId], store.pinnedMessages[channelId]);

    store.matchChannels[groupId] = { groupId, channels: [{ guildId: 'guild-fb', textChannelId: 't1' }], warned: false };
    store.saveMatchChannel(groupId);
    assert.deepEqual(readDataFile().matchChannels[groupId], store.matchChannels[groupId]);

    delete store.matchChannels[groupId];
    store.deleteMatchChannel(groupId);
    assert.equal(readDataFile().matchChannels[groupId], undefined, 'deleted group must actually be gone from disk, not just in memory');
  } finally {
    delete store.pinnedMessages[channelId];
    delete store.matchChannels[groupId];
  }
});

test('Mongo ready: no JSON write happens at all — the full sync write is a genuine fallback, not a write-through cache kept warm alongside a healthy Mongo', async () => {
  const tracker = trackMongoCalls();
  const originalWriteFileSync = fs.writeFileSync;
  let jsonWriteAttempted = false;
  fs.writeFileSync = (...args) => {
    if (String(args[0]).includes('data.json')) jsonWriteAttempted = true;
    return originalWriteFileSync.apply(fs, args);
  };

  store.__setMongoReadyForTesting(true);
  try {
    store.queues['No JSON Write Test Cup'] = { EU: [{ unitId: 'u1' }] };
    store.saveQueues();
    await flushMicrotasks();

    store.pinnedMessages['chan-nowrite'] = { guildId: 'g1', tournamentName: 'x', region: 'EU' };
    store.savePinnedMessages('g1');
    await flushMicrotasks();

    store.matchChannels['group-nowrite'] = { groupId: 'group-nowrite', channels: [], warned: false };
    store.saveMatchChannel('group-nowrite');
    await flushMicrotasks();

    assert.equal(jsonWriteAttempted, false, 'no data.json write should happen at all while Mongo is the healthy backend of record');
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    store.__setMongoReadyForTesting(false);
    tracker.restore();
    delete store.queues['No JSON Write Test Cup'];
    delete store.pinnedMessages['chan-nowrite'];
    delete store.matchChannels['group-nowrite'];
  }
});
