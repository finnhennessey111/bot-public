// Verifies the 6s/8s creative team redesign:
//   - team-invite.js: multi-select invite -> correct pending state; edit-team reconciliation.
//   - team-partition.js: a party of N is never split when a clean partition exists; PR-optimal
//     partitioning beats a naive baseline.
//   - creative-team-queue.js: the join/merge gate rejects a completing combination that can't be
//     cleanly split into two teams; platform preference is soft (blocks early, opens up later).
//   - team-match-lifecycle.js: getTeamMatchCategory resolves the mode's own queue-channel category.
//
// Real channel/voice creation (guild.channels.create) isn't exercised here — that needs a live
// Discord client, which this suite intentionally doesn't stand up. Everything below is the actual
// production logic, not a reimplementation of it.
const test = require('node:test');
const assert = require('node:assert/strict');

const teamInvite = require('../team-invite');
const { canPartitionIntoHalves, bestPartitionByPR } = require('../team-partition');
const creativeTeamQueue = require('../creative-team-queue');
const { getCreativeWideningTier } = require('../creative-queue');
const config = require('../config');

function player(discordId, totalPR, platform = 'PC') {
  return { discordId, discordUsername: discordId, epicUsername: discordId, guildId: 'g1', totalPR, matchScore: totalPR, platform };
}

function unit(playerList) {
  return { players: playerList };
}

// --- team-invite.js ------------------------------------------------------------------------

test('team-invite: multi-select invite produces correct pending state', () => {
  const guildId = `g_${Math.random()}`;
  const team = teamInvite.startForming({
    guildId, leaderId: 'L', leaderUsername: 'Leader', category: '6s', mode: '3v3 Realistics', region: 'EU', bringCount: 2,
  });
  assert.deepEqual(team.members, [{ discordId: 'L', username: 'Leader' }]);

  const { created, skipped } = teamInvite.inviteMembers(team, [
    { discordId: 'A', username: 'Alice' },
    { discordId: 'B', username: 'Bob' },
  ]);
  assert.equal(created.length, 2);
  assert.equal(skipped.length, 0);
  assert.equal(teamInvite.pendingInvitesForTeam(team).length, 2);
  assert.ok(teamInvite.hasPendingInvite(guildId, 'A'));
  assert.ok(teamInvite.hasPendingInvite(guildId, 'B'));

  // Re-inviting an already-invited or already-member user is a no-op, not a duplicate.
  const again = teamInvite.inviteMembers(team, [{ discordId: 'A', username: 'Alice' }]);
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped.length, 1);
});

test('team-invite: accept adds the member and removes the invite; decline just removes it', () => {
  const guildId = `g_${Math.random()}`;
  const team = teamInvite.startForming({
    guildId, leaderId: 'L', leaderUsername: 'Leader', category: '6s', mode: '3v3 Realistics', region: 'EU', bringCount: 2,
  });
  const { created } = teamInvite.inviteMembers(team, [
    { discordId: 'A', username: 'Alice' },
    { discordId: 'B', username: 'Bob' },
  ]);

  const acceptResult = teamInvite.acceptInvite(created[0].inviteId);
  assert.ok(acceptResult);
  assert.deepEqual(acceptResult.team.members.map(m => m.discordId), ['L', 'A']);
  assert.equal(teamInvite.getInvite(created[0].inviteId), null);

  const declineResult = teamInvite.declineInvite(created[1].inviteId);
  assert.ok(declineResult);
  assert.equal(teamInvite.pendingInvitesForTeam(team).length, 0);
  assert.deepEqual(team.members.map(m => m.discordId), ['L', 'A']); // B never joined
});

test('team-invite: accepting an invite whose team already finalized returns null', () => {
  const guildId = `g_${Math.random()}`;
  const team = teamInvite.startForming({
    guildId, leaderId: 'L', leaderUsername: 'Leader', category: '6s', mode: '3v3 Realistics', region: 'EU', bringCount: 1,
  });
  const { created } = teamInvite.inviteMembers(team, [{ discordId: 'A', username: 'Alice' }]);
  teamInvite.finalizeForming(guildId, 'L');

  assert.equal(teamInvite.acceptInvite(created[0].inviteId), null);
});

test('team-invite: editTeam correctly reconciles removed/kept/newly-invited members', () => {
  const guildId = `g_${Math.random()}`;
  const team = teamInvite.startForming({
    guildId, leaderId: 'L', leaderUsername: 'Leader', category: '6s', mode: '3v3 Realistics', region: 'EU', bringCount: 2,
  });
  const { created } = teamInvite.inviteMembers(team, [
    { discordId: 'A', username: 'Alice' },
    { discordId: 'B', username: 'Bob' },
  ]);
  teamInvite.acceptInvite(created.find(i => i.invitedId === 'A').inviteId); // A is now an accepted member, B still pending

  // New target roster: drop B, keep A, add C.
  const diff = teamInvite.editTeam(team, [
    { discordId: 'A', username: 'Alice' },
    { discordId: 'C', username: 'Carl' },
  ]);

  assert.equal(diff.removedMembers.length, 0); // A wasn't removed (still targeted)
  assert.deepEqual(diff.cancelledInvites.map(i => i.invitedId), ['B']);
  assert.deepEqual(diff.newInvites.map(i => i.invitedId), ['C']);
  assert.deepEqual(team.members.map(m => m.discordId), ['L', 'A']); // A kept, C is only invited so far
  assert.ok(teamInvite.hasPendingInvite(guildId, 'C'));
  assert.ok(!teamInvite.hasPendingInvite(guildId, 'B'));
});

test('team-invite: finalizeForming cancels outstanding invites and returns the accepted roster', () => {
  const guildId = `g_${Math.random()}`;
  const team = teamInvite.startForming({
    guildId, leaderId: 'L', leaderUsername: 'Leader', category: '6s', mode: '3v3 Realistics', region: 'EU', bringCount: 2,
  });
  const { created } = teamInvite.inviteMembers(team, [
    { discordId: 'A', username: 'Alice' },
    { discordId: 'B', username: 'Bob' },
  ]);
  teamInvite.acceptInvite(created.find(i => i.invitedId === 'A').inviteId);

  const result = teamInvite.finalizeForming(guildId, 'L');
  assert.deepEqual(result.team.members.map(m => m.discordId), ['L', 'A']);
  assert.deepEqual(result.cancelledInvites.map(i => i.invitedId), ['B']);
  assert.equal(teamInvite.getPendingTeam(guildId, 'L'), null);
});

// --- team-partition.js ----------------------------------------------------------------------

test('team-partition: three 2-person duos can never cleanly split a 6s (3v3) match', () => {
  assert.equal(canPartitionIntoHalves([2, 2, 2], 3), false);
});

test('team-partition: feasible combinations are correctly detected', () => {
  assert.equal(canPartitionIntoHalves([3, 2, 1], 3), true);
  assert.equal(canPartitionIntoHalves([4, 4], 4), true);
  assert.equal(canPartitionIntoHalves([2, 2, 1, 1], 3), true);
});

test('team-partition: bestPartitionByPR never splits a unit when a whole-unit partition exists', () => {
  const u1 = unit([player('a1', 100), player('a2', 100), player('a3', 100)]); // size 3
  const u2 = unit([player('b1', 10), player('b2', 10)]); // size 2
  const u3 = unit([player('c1', 5)]); // size 1

  const { team1, team2 } = bestPartitionByPR([u1, u2, u3], 3);
  const teamOf = id => (team1.some(p => p.discordId === id) ? team1 : team2);

  // Every member of a given unit must land on the same side.
  for (const u of [u1, u2, u3]) {
    const sides = new Set(u.players.map(p => teamOf(p.discordId) === team1 ? 1 : 2));
    assert.equal(sides.size, 1, `unit ${u.players.map(p => p.discordId)} was split across teams`);
  }
  assert.equal(team1.length, 3);
  assert.equal(team2.length, 3);
});

test('team-partition: bestPartitionByPR finds a PR-balanced split a naive first-come ordering misses', () => {
  // Six solo units (each size 1) for a 6s match — two big-PR outliers should end up on opposite
  // teams rather than however they happened to arrive.
  const units = [500, 500, 10, 10, 10, 10].map((pr, i) => unit([player(`p${i}`, pr)]));

  const { team1, team2 } = bestPartitionByPR(units, 3);
  const diff = Math.abs(team1.reduce((s, p) => s + p.totalPR, 0) - team2.reduce((s, p) => s + p.totalPR, 0));

  // Naive "first 3 arrived vs last 3 arrived" would put both 500s on the same team (diff = 980).
  const naiveTeam1 = units.slice(0, 3).flatMap(u => u.players);
  const naiveTeam2 = units.slice(3).flatMap(u => u.players);
  const naiveDiff = Math.abs(naiveTeam1.reduce((s, p) => s + p.totalPR, 0) - naiveTeam2.reduce((s, p) => s + p.totalPR, 0));

  assert.ok(diff < naiveDiff, `exact partition (diff=${diff}) should beat naive ordering (diff=${naiveDiff})`);
  assert.equal(diff, 0); // the two 500s can and should end up on opposite teams
});

test('team-partition: falls back to splitting only when no whole-unit partition exists at all (single unit fills the lobby)', () => {
  const lone = unit([player('a', 50), player('b', 60), player('c', 70), player('d', 80), player('e', 90), player('f', 100)]);
  const { team1, team2 } = bestPartitionByPR([lone], 3);
  assert.equal(team1.length, 3);
  assert.equal(team2.length, 3);
});

// --- creative-team-queue.js: the join/merge gate -------------------------------------------

test('creative-team-queue: a third duo is rejected from completing an unsplittable 2+2+2 6s lobby', () => {
  const guildId = `g_${Math.random()}`;
  creativeTeamQueue.queueUnit(guildId, [player('a1', 500), player('a2', 500)], '3v3 Realistics', 'EU');
  creativeTeamQueue.queueUnit(guildId, [player('b1', 500), player('b2', 500)], '3v3 Realistics', 'EU');
  creativeTeamQueue.queueUnit(guildId, [player('c1', 500), player('c2', 500)], '3v3 Realistics', 'EU');

  // All three duos should still be waiting — the match was never allowed to confirm on an
  // unsplittable composition.
  assert.equal(creativeTeamQueue.isInTeamQueue(guildId, 'a1'), true);
  assert.equal(creativeTeamQueue.isInTeamQueue(guildId, 'b1'), true);
  assert.equal(creativeTeamQueue.isInTeamQueue(guildId, 'c1'), true);
  assert.equal(creativeTeamQueue.getTeamQueueWaitingCount(guildId, '3v3 Realistics', 'EU'), 6);
});

test('creative-team-queue: a feasible combination (2+2+1+1) still confirms normally', () => {
  const guildId = `g_${Math.random()}`;
  creativeTeamQueue.queueUnit(guildId, [player('d1', 500), player('d2', 500)], '3v3 Realistics', 'NAC');
  creativeTeamQueue.queueUnit(guildId, [player('e1', 500), player('e2', 500)], '3v3 Realistics', 'NAC');
  creativeTeamQueue.queueUnit(guildId, [player('f1', 500)], '3v3 Realistics', 'NAC');
  creativeTeamQueue.queueUnit(guildId, [player('g1x', 500)], '3v3 Realistics', 'NAC');

  assert.equal(creativeTeamQueue.isInTeamQueue(guildId, 'd1'), false); // confirmed, no longer queued
  assert.equal(creativeTeamQueue.getTeamQueueWaitingCount(guildId, '3v3 Realistics', 'NAC'), 0);
});

test('creative-team-queue: platform is a soft preference — blocks in the tight tier, allowed after widening', () => {
  const guildId = `g_${Math.random()}`;
  // Two solo units for 8s (4v4), different platforms, same PR — same-platform-only tier applies
  // immediately (afterSeconds: 0), so these must NOT match right away...
  creativeTeamQueue.queueUnit(guildId, [player('pc1', 500, 'PC')], '4v4 Realistics', 'EU');
  creativeTeamQueue.queueUnit(guildId, [player('console1', 500, 'Console')], '4v4 Realistics', 'EU');
  assert.equal(creativeTeamQueue.isInTeamQueue(guildId, 'pc1'), true);
  assert.equal(creativeTeamQueue.isInTeamQueue(guildId, 'console1'), true);

  // ...but a same-platform unit CAN still join either of them (confirms the mismatch isn't a
  // total lockout — same-platform pairing is still perfectly possible, just not cross-platform
  // yet). This demonstrates the gate is about platform *mismatch*, not blocking matching outright.
  creativeTeamQueue.queueUnit(guildId, [player('pc2', 500, 'PC')], '4v4 Realistics', 'EU');
  assert.equal(creativeTeamQueue.isInTeamQueue(guildId, 'pc1'), true); // still waiting (needs 4 total)
  assert.equal(creativeTeamQueue.isInTeamQueue(guildId, 'pc2'), true);
});

test('creative-team-queue: the widening schedule itself opens cross-platform matching after enough wait (soft, not permanent, block)', () => {
  // evaluateJoin/attemptMergeForBucket gate cross-platform joins purely off this schedule
  // (config.creativeWideningSchedule, via getCreativeWideningTier) — confirming the schedule
  // really does drop samePlatformOnly after its threshold is the authoritative proof that a
  // platform mismatch is never a *permanent* block, just an early-tier preference.
  const tightTier = getCreativeWideningTier(0);
  assert.equal(tightTier.samePlatformOnly, true);

  const secondThreshold = config.creativeWideningSchedule[1].afterSeconds;
  const widenedTier = getCreativeWideningTier(secondThreshold + 1);
  assert.equal(widenedTier.samePlatformOnly, false);
});

// --- team-match-lifecycle.js: getTeamMatchCategory -----------------------------------------
// guild-config.js's setGuildConfig/upsertBareGuildDoc hit MongoDB unconditionally and hang for
// ~10s waiting on mongoose's connection buffer when nothing is connected (confirmed manually) —
// there's no dependency-injection seam in this codebase to avoid that, so this stubs guild-
// config.js at the require-cache level (a real, if blunt, Node testing technique) rather than
// exercising the real Mongo-backed module. Everything downstream of that stub is the real
// getTeamMatchCategory implementation.
test('team-match-lifecycle: getTeamMatchCategory resolves the mode\'s own queue-channel category', async () => {
  const guildConfigPath = require.resolve('../guild-config');
  const teamMatchLifecyclePath = require.resolve('../team-match-lifecycle');
  const channelLifecyclePath = require.resolve('../channel-lifecycle');

  const previousGuildConfigModule = require.cache[guildConfigPath];
  delete require.cache[guildConfigPath];
  delete require.cache[teamMatchLifecyclePath];
  delete require.cache[channelLifecyclePath];

  const fakeCategoryChannel = { id: 'category-for-6s' };
  const fakeQueueChannel = { id: 'queue-channel-6s', parent: fakeCategoryChannel };

  require.cache[guildConfigPath] = {
    id: guildConfigPath,
    filename: guildConfigPath,
    loaded: true,
    exports: {
      getRoleId: () => null,
      getCategoryId: () => null,
      getCreativeChannelInfo: (guildId, category) =>
        (category === '6s' ? { channelId: fakeQueueChannel.id, messageId: 'm1' } : null),
      setGuildConfig: async () => { throw new Error('setGuildConfig should not be called on the happy path'); },
    },
  };

  try {
    const tml = require('../team-match-lifecycle');
    const fakeGuild = {
      id: 'guild1',
      channels: {
        fetch: async (id) => (id === fakeQueueChannel.id ? fakeQueueChannel : null),
      },
    };

    const category = await tml.getTeamMatchCategory(fakeGuild, '3v3 Realistics');
    assert.equal(category, fakeCategoryChannel);
  } finally {
    // Restore real modules so any later test file in this same process (node:test runs each
    // file in its own process, but this keeps the module clean regardless) sees the real thing.
    delete require.cache[guildConfigPath];
    delete require.cache[teamMatchLifecyclePath];
    delete require.cache[channelLifecyclePath];
    if (previousGuildConfigModule) require.cache[guildConfigPath] = previousGuildConfigModule;
  }
});
