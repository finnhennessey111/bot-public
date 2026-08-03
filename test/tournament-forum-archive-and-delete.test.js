// Verifies item #4 (permanent-tournament auto-archive risk) and item #5 (deleteManagedChannel
// works with ThreadChannel.delete()) of the forum-post migration.
//
// #4: forum threads auto-archive after inactivity (max 1 week — discord-api-types'
// ThreadAutoArchiveDuration enum only goes up to 10080 minutes). Editing the starter message
// (what the periodic refresh does) does NOT reset that timer — confirmed via discord.js's actual
// Modify Thread semantics, only a genuinely new message (or an explicit un-archive) does. A
// permanent tournament (FNCS Divisionals — never deleted, could plausibly go quiet for over a
// week between real events) would otherwise silently auto-archive with nothing to un-stick it.
// The fix: updateActiveTournamentEmbeds proactively un-archives a permanent tournament's thread
// on every refresh tick (60s) before editing it, so the worst case is well under a minute archived
// before it self-heals.
//
// #5: deleteManagedChannel already just calls channel.delete() — discord.js's own source confirms
// ThreadChannel#delete is implemented identically to GuildChannel#delete (both just call
// guild.channels.delete(this.id)), so no code change was actually needed there. These tests prove
// that against a thread-shaped fake object, not just by reading the source.
const test = require('node:test');
const assert = require('node:assert/strict');

const channelManager = require('../channel-manager');

function clearAllManagedTimers() {
  for (const key of Object.keys(channelManager.managedChannels)) {
    clearTimeout(channelManager.managedChannels[key].deleteTimer);
    delete channelManager.managedChannels[key];
  }
}
test.afterEach(clearAllManagedTimers);

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

function makeFakeMessage() {
  return { id: 'msg-1', edits: [], async edit(payload) { this.edits.push(payload); } };
}

// archived starts as given; setArchivedCalls records every call so tests can assert on both
// whether it was called AND what it was called with.
function makeFakeThread(id, { archived = false } = {}) {
  const msg = makeFakeMessage();
  const thread = {
    id,
    archived,
    setArchivedCalls: [],
    async setArchived(value) {
      thread.setArchivedCalls.push(value);
      thread.archived = value;
      return thread;
    },
    messages: { fetch: async () => msg },
    deleteCalls: 0,
    async delete() { thread.deleteCalls++; },
  };
  return { thread, msg };
}

function makeFakeGuild(guildId, channelsById) {
  return {
    id: guildId,
    channels: { fetch: async (cid) => channelsById.get(cid) ?? null },
  };
}

// ── #4: proactive un-archive for permanent tournaments ───────────────────────
test('updateActiveTournamentEmbeds: a PERMANENT tournament\'s auto-archived thread gets un-archived before its embed is refreshed', async () => {
  const guildId = `guild_${Math.random()}`;
  const channelId = 'chan-1';
  const { thread } = makeFakeThread(channelId, { archived: true });
  const channelsById = new Map([[channelId, thread]]);
  const guild = makeFakeGuild(guildId, channelsById);

  const pinnedMessages = {
    [channelId]: {
      messageId: 'msg-1', guildId, tournamentName: 'FNCS Division 2', region: 'EU', isTrios: true,
      permanent: true, beginTime: futureIso(20),
      // permanent tournaments have no deleteAt — matches real createTournamentChannel behavior.
    },
  };

  await channelManager.updateActiveTournamentEmbeds(guild, pinnedMessages);

  assert.deepEqual(thread.setArchivedCalls, [false], 'must un-archive exactly once, with false');
  assert.equal(thread.archived, false);
});

test('updateActiveTournamentEmbeds: a PERMANENT tournament\'s thread that is NOT archived is left alone — no needless API call', async () => {
  const guildId = `guild_${Math.random()}`;
  const channelId = 'chan-2';
  const { thread } = makeFakeThread(channelId, { archived: false });
  const channelsById = new Map([[channelId, thread]]);
  const guild = makeFakeGuild(guildId, channelsById);

  const pinnedMessages = {
    [channelId]: {
      messageId: 'msg-1', guildId, tournamentName: 'FNCS Division 2', region: 'EU', isTrios: true,
      permanent: true, beginTime: futureIso(20),
    },
  };

  await channelManager.updateActiveTournamentEmbeds(guild, pinnedMessages);

  assert.deepEqual(thread.setArchivedCalls, [], 'nothing to un-archive — setArchived must not be called at all');
});

test('updateActiveTournamentEmbeds: a NON-permanent tournament\'s archived thread is left archived — the proactive fix is scoped to permanent tournaments only', async () => {
  const guildId = `guild_${Math.random()}`;
  const channelId = 'chan-3';
  const { thread } = makeFakeThread(channelId, { archived: true });
  const channelsById = new Map([[channelId, thread]]);
  const guild = makeFakeGuild(guildId, channelsById);

  const pinnedMessages = {
    [channelId]: {
      messageId: 'msg-1', guildId, tournamentName: 'Some Cash Cup', region: 'EU', isTrios: false,
      permanent: false, beginTime: futureIso(20), deleteAt: Date.now() + 999999,
    },
  };

  await channelManager.updateActiveTournamentEmbeds(guild, pinnedMessages);

  assert.deepEqual(thread.setArchivedCalls, [], 'a non-permanent tournament is never expected to sit quiet long enough to matter — scoped out deliberately, not an oversight');
});

test('updateActiveTournamentEmbeds: a pre-migration plain-text channel (no .archived property at all) is a safe no-op — never throws', async () => {
  const guildId = `guild_${Math.random()}`;
  const channelId = 'chan-4';
  const msg = makeFakeMessage();
  // No .archived, no .setArchived — exactly what a real (non-thread) TextChannel object looks like.
  const plainChannel = { id: channelId, messages: { fetch: async () => msg } };
  const channelsById = new Map([[channelId, plainChannel]]);
  const guild = makeFakeGuild(guildId, channelsById);

  const pinnedMessages = {
    [channelId]: {
      messageId: 'msg-1', guildId, tournamentName: 'FNCS Division 2', region: 'EU', isTrios: true,
      permanent: true, beginTime: futureIso(20),
    },
  };

  await assert.doesNotReject(() => channelManager.updateActiveTournamentEmbeds(guild, pinnedMessages));
  assert.equal(msg.edits.length, 1, 'the embed refresh itself must still proceed normally');
});

// ── #5: deleteManagedChannel with a real thread-shaped object ────────────────
test('deleteManagedChannel: calls .delete() on a forum-thread-shaped channel exactly the same way it always did on a normal one', async () => {
  const guildId = `guild_${Math.random()}`;
  const channelId = 'chan-5';
  const { thread } = makeFakeThread(channelId);
  const channelsById = new Map([[channelId, thread]]);
  const guild = makeFakeGuild(guildId, channelsById);

  const pinnedMessages = {
    [channelId]: { messageId: 'msg-1', guildId, tournamentName: 'Some Cup', region: 'EU', permanent: false },
  };
  channelManager.managedChannels[channelId] = { tournamentName: 'Some Cup', region: 'EU', deleteTimer: null };

  await channelManager.deleteManagedChannel(guild, channelId, pinnedMessages[channelId], pinnedMessages);

  assert.equal(thread.deleteCalls, 1, 'thread.delete() must be called exactly once — no special-casing needed for a thread');
  assert.equal(pinnedMessages[channelId], undefined, 'pinnedMessages entry must be cleaned up');
  assert.equal(channelManager.managedChannels[channelId], undefined, 'managedChannels tracking must be cleaned up');
});

test('deleteManagedChannel: a thread that\'s already gone (fetch returns null) is a safe no-op, same as a normal channel', async () => {
  const guildId = `guild_${Math.random()}`;
  const channelId = 'chan-6';
  const guild = makeFakeGuild(guildId, new Map()); // fetch always returns null

  const pinnedMessages = {
    [channelId]: { messageId: 'msg-1', guildId, tournamentName: 'Some Cup', region: 'EU', permanent: false },
  };

  await assert.doesNotReject(() => channelManager.deleteManagedChannel(guild, channelId, pinnedMessages[channelId], pinnedMessages));
  assert.equal(pinnedMessages[channelId], undefined);
});
