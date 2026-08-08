// Verifies the fix for a real bug: Reload Ranked Cups (and, in principle, any Ranked Cup build
// mode) not showing per-rank buttons. Investigation found isRankedCupTitle was ALREADY correct for
// all three variants (confirmed via git history AND a live scrape) — the real gap was
// channel-manager.js's periodic embed-refresh loop, which used to trust pinned.isRankedCup
// (frozen at channel-creation time) forever, never re-checking it. A channel created before
// detection covered its title correctly (or via /setup-tournament, which never checked at all —
// see the /setup-tournament fix covered separately) would keep its generic embed/button forever,
// only ever fixed by the channel's own natural 2h-post-begin delete+recreate.
//
// updateActiveTournamentEmbeds now re-checks isRankedCupTitle fresh every tick and upgrades a
// stale channel in place — but ONLY once it's safe: if anyone already queued via the OLD generic
// button (a DIFFERENT pool, keyed by the plain tournament name, than any rank-scoped pool), ripping
// that button out from under them would leave them stuck forever with no way to leave that queue
// (the leave-queue flow only reappears by re-clicking the exact button they queued with) and
// permanently mismatched against the wrong ranks via queue.js's sweepAllQueues. These tests use the
// REAL queue.js (not mocked) to prove that safety check against a genuinely populated pool, not an
// assumed one.
const test = require('node:test');
const assert = require('node:assert/strict');

const channelManager = require('../channel-manager');
const { joinQueue, removeFromQueueAnywhere, getQueueCount } = require('../queue');

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

function makeFakeMessage(initialComponents) {
  return {
    id: 'msg-1',
    components: initialComponents,
    edits: [],
    async edit(payload) {
      this.edits.push(payload);
      this.components = payload.components;
    },
  };
}

function makeFakeGuildWithChannel(guildId, channelId, message) {
  return {
    id: guildId,
    channels: {
      fetch: async (cid) => (cid === channelId ? { id: channelId, messages: { fetch: async () => message } } : null),
    },
  };
}

function makePlayer(discordId, tournamentName, region) {
  return {
    guildId: 'g1', guildName: 'Test Guild', discordId, discordUsername: discordId, discordTag: discordId,
    epicUsername: discordId, epicId: discordId, tournamentName, homeRegion: region, queueRegion: region,
    queueType: 'duo', platform: 'PC', consoleOnly: false, ingameRoles: [], languages: [],
    totalPR: 500, thisSeasonPR: 0, matchScore: 500, soloModifier: 0, recentEvents: [], joinedAt: new Date(),
  };
}

const OLD_GENERIC_BUTTONS = [{ toJSON: () => ({ components: [{ custom_id: 'queue_duo' }] }) }];

test('updateActiveTournamentEmbeds: a stale Ranked Cup channel (isRankedCup never correctly set) with an EMPTY legacy pool gets upgraded to per-rank buttons + breakdown embed, in place', async () => {
  const guildId = `guild_${Math.random()}`;
  const channelId = 'chan-upgrade-empty';
  const tournamentName = `Duos Ranked Cup (Reload) ${Math.random()}`;
  const region = 'EU';
  const msg = makeFakeMessage(OLD_GENERIC_BUTTONS);
  const guild = makeFakeGuildWithChannel(guildId, channelId, msg);

  const pinnedMessages = {
    [channelId]: {
      messageId: msg.id, guildId, tournamentName, region, isTrios: false,
      isRankedCup: false, // stale — this title genuinely IS a Ranked Cup, but this flag never got set
      beginTime: futureIso(20), deleteAt: Date.now() + 20 * 3600_000,
    },
  };

  assert.equal(getQueueCount(guildId, tournamentName, region), 0, 'sanity check: legacy pool starts empty');

  await channelManager.updateActiveTournamentEmbeds(guild, pinnedMessages);

  assert.equal(pinnedMessages[channelId].isRankedCup, true, 'must be upgraded AND persisted onto the pinnedMessages entry');
  assert.equal(msg.edits.length, 1, 'exactly one edit this tick');

  const allButtons = msg.edits[0].components.flatMap(r => r.toJSON().components);
  assert.equal(allButtons.length, 8, 'must now have all 8 rank buttons (Bronze through Unreal)');
  assert.ok(allButtons.every(b => b.custom_id.startsWith('queue_rank_')), 'every button must be rank-scoped, not the old generic one');

  const embedJson = msg.edits[0].embeds[0].toJSON();
  assert.ok(embedJson.fields.some(f => /queuing.*rank/i.test(f.name)), 'must now render the per-rank breakdown embed, not the plain single-count one');
});

test('updateActiveTournamentEmbeds: a stale Ranked Cup channel with players STILL QUEUED in the legacy pool defers the upgrade — old buttons/embed stay exactly as they were, nobody gets stranded', async () => {
  const guildId = `guild_${Math.random()}`;
  const channelId = 'chan-upgrade-deferred';
  const tournamentName = `Duos Ranked Cup (Reload) ${Math.random()}`;
  const region = 'EU';
  const msg = makeFakeMessage(OLD_GENERIC_BUTTONS);
  const guild = makeFakeGuildWithChannel(guildId, channelId, msg);

  const pinnedMessages = {
    [channelId]: {
      messageId: msg.id, guildId, tournamentName, region, isTrios: false,
      isRankedCup: false,
      beginTime: futureIso(20), deleteAt: Date.now() + 20 * 3600_000,
    },
  };

  // A real player already queued via the OLD generic button — lands in the pool keyed by the
  // plain tournament name, exactly as index.js's queue_duo handler does today.
  await joinQueue({ guildId: 'g1', players: [makePlayer('already-queued', tournamentName, region)], tournamentName, region, queueType: 'duo' });

  try {
    await channelManager.updateActiveTournamentEmbeds(guild, pinnedMessages);

    assert.equal(pinnedMessages[channelId].isRankedCup, false, 'must NOT upgrade while the legacy pool still has real players in it');
    assert.equal(msg.edits.length, 1, 'the tick still edits the message (embed refresh happens regardless) — just without upgrading');
    assert.deepEqual(msg.edits[0].components, OLD_GENERIC_BUTTONS, 'buttons must be the exact SAME old generic ones — never swapped out from under a queued player');

    const embedJson = msg.edits[0].embeds[0].toJSON();
    assert.ok(!embedJson.fields.some(f => /queuing.*rank/i.test(f.name)), 'must still render the plain (non-ranked) embed while deferred');

    // Now the legacy pool empties out (the player left, or got matched — either way, queue.js's
    // real removeFromQueueAnywhere is exactly how that happens) — the VERY NEXT tick must upgrade.
    removeFromQueueAnywhere('g1', 'already-queued');
    await channelManager.updateActiveTournamentEmbeds(guild, pinnedMessages);

    assert.equal(pinnedMessages[channelId].isRankedCup, true, 'must upgrade on the next tick once the legacy pool is genuinely empty');
    assert.equal(msg.edits.length, 2);
    const allButtons = msg.edits[1].components.flatMap(r => r.toJSON().components);
    assert.ok(allButtons.every(b => b.custom_id.startsWith('queue_rank_')));
  } finally {
    removeFromQueueAnywhere('g1', 'already-queued');
  }
});

test('updateActiveTournamentEmbeds: a normal (non-Ranked-Cup) pre-existing channel is completely unaffected — no upgrade attempted, same generic embed/buttons every tick', async () => {
  const guildId = `guild_${Math.random()}`;
  const channelId = 'chan-not-ranked';
  const tournamentName = `Mongraal Cup ${Math.random()}`;
  const region = 'EU';
  const msg = makeFakeMessage(OLD_GENERIC_BUTTONS);
  const guild = makeFakeGuildWithChannel(guildId, channelId, msg);

  const pinnedMessages = {
    [channelId]: {
      messageId: msg.id, guildId, tournamentName, region, isTrios: false,
      isRankedCup: false,
      beginTime: futureIso(20), deleteAt: Date.now() + 20 * 3600_000,
    },
  };

  await channelManager.updateActiveTournamentEmbeds(guild, pinnedMessages);

  assert.equal(pinnedMessages[channelId].isRankedCup, false, 'a genuinely non-Ranked-Cup title must never get upgraded');
  assert.deepEqual(msg.edits[0].components, OLD_GENERIC_BUTTONS, 'buttons must be untouched — same array reference carried straight through');
  const embedJson = msg.edits[0].embeds[0].toJSON();
  assert.ok(!embedJson.fields.some(f => /queuing.*rank/i.test(f.name)));
});

test('updateActiveTournamentEmbeds: a channel already correctly marked isRankedCup:true is unaffected by the new upgrade logic — existing behavior preserved exactly', async () => {
  const guildId = `guild_${Math.random()}`;
  const channelId = 'chan-already-ranked';
  const tournamentName = `Duos Ranked Cup (Zero Build) ${Math.random()}`;
  const region = 'EU';
  const existingRankButtons = [{ toJSON: () => ({ components: [{ custom_id: 'queue_rank_duo_gold' }] }) }];
  const msg = makeFakeMessage(existingRankButtons);
  const guild = makeFakeGuildWithChannel(guildId, channelId, msg);

  const pinnedMessages = {
    [channelId]: {
      messageId: msg.id, guildId, tournamentName, region, isTrios: false,
      isRankedCup: true, // already correct from creation
      beginTime: futureIso(20), deleteAt: Date.now() + 20 * 3600_000,
    },
  };

  await channelManager.updateActiveTournamentEmbeds(guild, pinnedMessages);

  assert.equal(pinnedMessages[channelId].isRankedCup, true);
  assert.deepEqual(msg.edits[0].components, existingRankButtons, 'components must be carried through exactly as before — no unnecessary rebuild');
  const embedJson = msg.edits[0].embeds[0].toJSON();
  assert.ok(embedJson.fields.some(f => /queuing.*rank/i.test(f.name)), 'still renders the per-rank embed, as it always did');
});
