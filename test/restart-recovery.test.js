// Verifies the restart-recovery fix for the two real in-memory-state risks investigated:
//
// 1. matching.js's pendingMatches (tournament/1v1/2v2 accept/reject window) — genuinely in-memory
//    only before this fix, AND the private channel wasn't registered in channel-lifecycle.js's
//    durable matchChannels until everyone accepted, so a restart mid-accept/reject used to leave a
//    channel with NO durable record anywhere — a true forever-orphan. Now fully restored: this
//    test simulates a restart by busting matching.js's own module cache (so its module-level
//    pendingMatches object is genuinely gone, exactly like a real process restart) while leaving
//    store.js's already-loaded state alone — a real restart's freshly-load()ed store.js would
//    already have this exact data back from disk/Mongo, which is verified separately by reading
//    data.json directly.
//
// 2. team-match-lifecycle.js's matchesById (6s/8s post-formation: team-vote/lock/ready-check/
//    vote-kick) — deliberately NOT restored (too complex/risky to safely reconstruct 5 sub-phases
//    each with independent timers right now — see that file's header comment). The fallback
//    instead detects every matchChannels record tagged 'creative-team' at startup (all of them are
//    orphaned by definition, since matchesById always starts empty) and closes them immediately
//    with a clear explanation, reusing the same cancelChannelDeletion primitive the "Close Channel"
//    button itself already relies on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function readDataFile() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function player(discordId, totalPR = 500) {
  return {
    guildId: 'g1', discordId, discordUsername: discordId, epicUsername: discordId,
    totalPR, matchScore: totalPR, thisSeasonPR: 0, soloModifier: 0, recentEvents: [],
    platform: 'PC', joinedAt: new Date(),
  };
}

function unit(unitId, discordId, tournamentName, region, totalPR = 500) {
  return {
    unitId, guildId: 'g1', queueType: 'duo', members: [player(discordId, totalPR)],
    totalPR, matchScore: totalPR, tournamentName, region, joinedAt: new Date(),
  };
}

// --- 1. matching.js pendingMatches: full restart survival ---------------------------------

test('matching.js: a pending match survives a simulated restart — persisted to disk, then correctly reconstructed by a fresh module instance', async () => {
  const matching = require('../matching');
  const store = require('../store');

  const tournamentName = `Restart Recovery Test ${Math.random()}`;
  const region = 'EU';
  const unitA = unit('unitA-restart', 'restart-p1', tournamentName, region);
  const unitB = unit('unitB-restart', 'restart-p2', tournamentName, region);

  const matchId = matching.createMatch(unitA, unitB, tournamentName, region, { expiryMs: 60000 });
  matching.attachMatchChannels(matchId, new Map([['g1', { channelId: 'chan-1', messageId: 'msg-1' }]]));

  try {
    // The whole point of persisting this: the channel is already real and already has a matchId
    // baked into its Accept/Reject buttons at this point (match-channels.js creates it before
    // this record would otherwise ever be durable) — confirm it's actually on disk, not just
    // held in this process's memory.
    assert.ok(store.pendingMatches[matchId], 'must be in store.pendingMatches immediately');
    const onDisk = readDataFile();
    assert.ok(onDisk.pendingMatches[matchId], 'must actually be written to data.json, not just in-memory');
    assert.equal(onDisk.pendingMatches[matchId].tournamentName, tournamentName);
    assert.deepEqual(onDisk.pendingMatches[matchId].channelsByGuildId, [['g1', { channelId: 'chan-1', messageId: 'msg-1' }]]);

    // Simulate the restart: bust ONLY matching.js's module cache, so a fresh require() re-runs
    // its top-level `const pendingMatches = {}` from scratch — genuinely empty, same as after a
    // real process restart. store.js is deliberately left alone: in a real restart store.js
    // itself would also reload, but from the exact data.json content just verified above, so
    // leaving it in place here is equivalent for what this test is actually checking (matching.js's
    // own restore logic), without re-testing store.js's already-covered load()/hydrate path.
    delete require.cache[require.resolve('../matching')];
    const freshMatching = require('../matching');

    assert.equal(freshMatching.getMatch(matchId), null, 'a genuinely fresh module must have no memory of the match before restoring');

    freshMatching.restorePendingMatches();

    const restored = freshMatching.getMatch(matchId);
    assert.ok(restored, 'the pending match must be restored from the persisted snapshot');
    assert.equal(restored.matchId, matchId);
    assert.equal(restored.tournamentName, tournamentName);
    assert.equal(restored.region, region);
    assert.equal(restored.kind, 'tournament');
    assert.equal(restored.players.length, 2);
    assert.deepEqual(restored.players.map(p => p.discordId).sort(), ['restart-p1', 'restart-p2']);
    assert.equal(restored.acceptedBy.size, 0, 'nobody had accepted yet — must not spuriously appear accepted');
    assert.ok(restored.channelsByGuildId instanceof Map, 'channelsByGuildId must be reconstructed as a real Map, not left as a plain array');
    assert.deepEqual(restored.channelsByGuildId.get('g1'), { channelId: 'chan-1', messageId: 'msg-1' });

    // The actual point of the whole fix: a player clicking Accept on the (already-sent, still
    // valid) button after the restart must work exactly as if the process never went down.
    const acceptResult = freshMatching.acceptMatch(matchId, 'restart-p1');
    assert.equal(acceptResult.status, 'waiting');
    assert.equal(acceptResult.acceptedCount, 1);

    const confirmResult = freshMatching.acceptMatch(matchId, 'restart-p2');
    assert.equal(confirmResult.status, 'confirmed');
    assert.equal(freshMatching.getMatch(matchId), null, 'confirming must clean the match back out');
    assert.equal(store.pendingMatches[matchId], undefined, 'confirming must also clear the persisted snapshot');
  } finally {
    delete require.cache[require.resolve('../matching')];
    // Best-effort cleanup in case an assertion failed before the match was confirmed above.
    delete require('../store').pendingMatches[matchId];
  }
});

test('matching.js: a restored match whose accept/reject window already lapsed while the process was down expires immediately and re-queues both units', async () => {
  const store = require('../store');
  const { findUnitByDiscordId, removeFromQueueAnywhere } = require('../queue');

  const tournamentName = `Restart Recovery Expiry Test ${Math.random()}`;
  const region = 'EU';
  // Deliberately far-apart totalPR: requeueUnit re-runs real matching on every push (see queue.js's
  // requeueUnit -> attemptMatchingForQueue), so two units this evenly matched (equal PR) would
  // instantly re-pair with each other the moment both land back in the pool — which is genuinely
  // correct production behavior, but would make it impossible to assert "both units are sitting in
  // the queue" below (they'd already be spliced back out into a fresh match instead).
  const unitA = unit('unitA-expiry', 'expiry-p1', tournamentName, region, 500);
  const unitB = unit('unitB-expiry', 'expiry-p2', tournamentName, region, 5);
  const matchId = `match_expiry_test_${Math.random()}`;

  // Writes the persisted snapshot directly (bypassing createMatch entirely) rather than letting a
  // real short expiryMs race a real setTimeout against this test — createMatch's own timer living
  // on a whole separate module instance isn't the thing under test here (that's an ordinary
  // expiry, already covered by the sibling test above); what's under test is specifically
  // restorePendingMatches' handling of a snapshot whose window had ALREADY lapsed by the time it's
  // loaded — exactly what a real elapsed wall-clock gap across a genuine restart looks like once
  // reloaded from disk/Mongo.
  store.pendingMatches[matchId] = {
    matchId, unitA, unitB, tournamentName, region, kind: 'tournament', expiryMs: 60000,
    createdAt: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago — well past the 60s window
    acceptedBy: [],
    channelsByGuildId: [['g1', { channelId: 'chan-2', messageId: 'msg-2' }]],
  };
  store.savePendingMatch(matchId);

  try {
    delete require.cache[require.resolve('../matching')];
    const freshMatching = require('../matching');

    let expiredEventFired = false;
    freshMatching.matchLifecycleEvents.on('expired', ({ matchId: expiredId }) => {
      if (expiredId === matchId) expiredEventFired = true;
    });

    freshMatching.restorePendingMatches();

    assert.equal(freshMatching.getMatch(matchId), null, 'an already-overdue restored match must be expired immediately, not left pending');
    assert.equal(expiredEventFired, true, 'the expired event must still fire so the caller (index.js) can close the orphaned channel');
    assert.equal(store.pendingMatches[matchId], undefined, 'the persisted snapshot must be cleared too');

    // Both units must have actually landed back in the real queue pool, not just vanished.
    assert.ok(findUnitByDiscordId('g1', 'expiry-p1'), 'unitA must be re-queued');
    assert.ok(findUnitByDiscordId('g1', 'expiry-p2'), 'unitB must be re-queued');
  } finally {
    delete require.cache[require.resolve('../matching')];
    removeFromQueueAnywhere('g1', 'expiry-p1');
    removeFromQueueAnywhere('g1', 'expiry-p2');
    delete require('../store').pendingMatches[matchId];
  }
});

// --- 2. team-match-lifecycle.js: orphaned 6s/8s channel detection + cleanup fallback ------

test('team-match-lifecycle.js: an orphaned creative-team channel group is detected and closed on startup, with a clear explanation posted first', async () => {
  const teamMatchLifecycle = require('../team-match-lifecycle');
  const store = require('../store');

  const groupId = `orphan-group-${Math.random()}`;
  store.matchChannels[groupId] = {
    groupId,
    channels: [{ guildId: 'g1', textChannelId: 'text-1', voiceChannelId: 'voice-1' }],
    kind: 'creative-team',
    deleteAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    warned: false,
  };

  const sentMessages = [];
  const deletedChannelIds = [];
  const fakeChannel = (id) => ({
    id,
    send: async (content) => { sentMessages.push({ id, content }); },
    delete: async () => { deletedChannelIds.push(id); },
  });

  const fakeClient = {
    channels: {
      fetch: async (id) => fakeChannel(id),
    },
  };

  try {
    await teamMatchLifecycle.cleanupOrphanedMatchesOnStartup(fakeClient);

    // Detected and removed from the durable store immediately — proves this doesn't wait on the
    // deletion timer to eventually notice.
    assert.equal(store.matchChannels[groupId], undefined, 'the orphaned group must be removed from matchChannels immediately');

    assert.equal(sentMessages.length, 1, 'exactly one explanatory message must be posted');
    assert.equal(sentMessages[0].id, 'text-1');
    assert.match(sentMessages[0].content, /restart/i);
    assert.match(sentMessages[0].content, /re-queue/i);

    // Actual channel deletion is scheduled 10s out (same grace-period UX as every other close
    // flow in this codebase) — wait past it and confirm it genuinely happened, not just that a
    // timer was scheduled.
    await new Promise(r => setTimeout(r, 10500));
    assert.deepEqual(deletedChannelIds.sort(), ['text-1', 'voice-1'], 'both the text and voice channel must actually be deleted');
  } finally {
    delete store.matchChannels[groupId];
  }
});

test('team-match-lifecycle.js: startup cleanup only touches creative-team groups — confirmed tournament/1v1/2v2 match channels are left alone', async () => {
  const teamMatchLifecycle = require('../team-match-lifecycle');
  const store = require('../store');

  const untouchedGroupId = `tournament-group-${Math.random()}`;
  store.matchChannels[untouchedGroupId] = {
    groupId: untouchedGroupId,
    channels: [{ guildId: 'g1', textChannelId: 'text-untouched', voiceChannelId: 'voice-untouched' }],
    kind: 'tournament',
    deleteAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    warned: false,
  };

  const fakeClient = { channels: { fetch: async () => { throw new Error('should never be called for a non-creative-team group'); } } };

  try {
    await teamMatchLifecycle.cleanupOrphanedMatchesOnStartup(fakeClient);
    assert.ok(store.matchChannels[untouchedGroupId], 'a confirmed tournament match channel group must be left completely untouched by this cleanup');
  } finally {
    delete store.matchChannels[untouchedGroupId];
  }
});
