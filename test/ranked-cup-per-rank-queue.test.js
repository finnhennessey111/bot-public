// Verifies the Ranked Cup per-rank-tier queue feature: Ranked Cup tournaments (Bronze/Silver/
// Gold/Platinum/Diamond/Elite) span one shared Fortnite Tracker event listing but should never let
// players from different ranks match each other. Covers:
//   1. Detection (tournament-scraper.js's isRankedCupTitle) — only matches real "Ranked Cup" titles.
//   2. Genuine pool separation (queue.js, real/unmodified) — a Bronze unit and an Elite unit with
//      near-identical PR (who WOULD match under the normal widening rules) never pair up once
//      they're queued under their own rank's pool name.
//   3. embeds.js's per-rank button/embed builders.
//   4. channel-manager.js's createTournamentChannel: Ranked Cup titles get the per-rank buttons,
//      everything else keeps the single generic button — the non-Ranked-Cup path is unaffected.
const test = require('node:test');
const assert = require('node:assert/strict');

const { isRankedCupTitle } = require('../tournament-scraper');
const { RANK_TIERS, rankedCupPoolName, buildRankedCupQueueButtons, buildRankedCupTournamentEmbed, buildQueueButtons } = require('../embeds');
const { joinQueue, matchEvents, removeFromQueueAnywhere, findUnitByDiscordId, getQueueCount } = require('../queue');
const channelManager = require('../channel-manager');

function clearAllManagedTimers() {
  for (const key of Object.keys(channelManager.managedChannels)) {
    clearTimeout(channelManager.managedChannels[key].deleteTimer);
    delete channelManager.managedChannels[key];
  }
}
test.afterEach(clearAllManagedTimers);

// ── 1. DETECTION ─────────────────────────────────────────────────────────────
test('isRankedCupTitle: matches real Ranked Cup titles, not similarly-named cups', () => {
  assert.equal(isRankedCupTitle('duos ranked cup (battle royale)'), true);
  assert.equal(isRankedCupTitle('duos ranked cup (zero build)'), true);
  assert.equal(isRankedCupTitle('duos ranked cup (reload)'), true);
  assert.equal(isRankedCupTitle('console duos victory cup'), false, 'a different cup entirely must not false-positive');
  assert.equal(isRankedCupTitle('fncs division 2'), false);
  assert.equal(isRankedCupTitle('mongraal cup'), false);
});

// ── 2. GENUINE POOL SEPARATION ────────────────────────────────────────────────
function makePlayer(discordId, tournamentName, region, totalPR) {
  return {
    guildId: 'g1', guildName: 'Test Guild', discordId, discordUsername: discordId, discordTag: discordId,
    epicUsername: discordId, epicId: discordId, tournamentName, homeRegion: region, queueRegion: region,
    queueType: 'duo', platform: 'PC', consoleOnly: false, ingameRoles: [], languages: [], ageBracket: null,
    bio: null, totalPR, thisSeasonPR: 0, matchScore: totalPR, soloModifier: 0, recentEvents: [], joinedAt: new Date(),
  };
}

test('ranked cup queues: a Bronze unit and an Elite unit with matching PR never pair up — separate pools, not just a display difference', async () => {
  const realTournamentName = `Duos Ranked Cup (Battle Royale) ${Math.random()}`;
  const region = 'EU';
  const bronzePool = rankedCupPoolName(realTournamentName, 'bronze');
  const elitePool = rankedCupPoolName(realTournamentName, 'elite');

  assert.notEqual(bronzePool, elitePool, 'rank pool names must differ');

  const found = [];
  const onMatch = e => found.push(e);
  matchEvents.on('matchFound', onMatch);

  try {
    // Same PR on both sides (500) — under the real widening rules these two WOULD be paired if
    // they were ever in the same pool. They must not be, because they're queued under different
    // rank-scoped pool names.
    await joinQueue({ guildId: 'g1', players: [makePlayer('bronze-1', realTournamentName, region, 500)], tournamentName: bronzePool, region, queueType: 'duo' });
    await joinQueue({ guildId: 'g1', players: [makePlayer('elite-1', realTournamentName, region, 500)], tournamentName: elitePool, region, queueType: 'duo' });

    assert.equal(found.length, 0, 'a lone Bronze player and a lone Elite player must never match each other');
    assert.ok(findUnitByDiscordId('g1', 'bronze-1'), 'the Bronze player should still be waiting in their own pool');
    assert.ok(findUnitByDiscordId('g1', 'elite-1'), 'the Elite player should still be waiting in their own pool');

    // Now add a second Bronze player — same-rank matching must still work normally.
    await joinQueue({ guildId: 'g1', players: [makePlayer('bronze-2', realTournamentName, region, 505)], tournamentName: bronzePool, region, queueType: 'duo' });
    assert.equal(found.length, 1, 'two Bronze players with close PR must match each other');
    assert.equal(found[0].tournamentName, bronzePool);
    const matchedIds = [...found[0].unitA.members, ...found[0].unitB.members].map(p => p.discordId).sort();
    assert.deepEqual(matchedIds, ['bronze-1', 'bronze-2'], 'the match must be exactly the two Bronze players — Elite must never be pulled in');

    assert.equal(getQueueCount('g1', bronzePool, region), 0, 'both Bronze players left the pool once matched');
    assert.equal(getQueueCount('g1', elitePool, region), 1, 'the Elite player is completely unaffected, still queued');
  } finally {
    matchEvents.off('matchFound', onMatch);
    removeFromQueueAnywhere('g1', 'bronze-1');
    removeFromQueueAnywhere('g1', 'bronze-2');
    removeFromQueueAnywhere('g1', 'elite-1');
  }
});

// ── 3. EMBED/BUTTON BUILDERS ──────────────────────────────────────────────────
test('buildRankedCupQueueButtons: 6 rank buttons across 2 rows, correct customIds and emoji, no generic queue button', () => {
  const rows = buildRankedCupQueueButtons(false).map(r => r.toJSON());
  const allButtons = rows.flatMap(r => r.components);

  assert.equal(allButtons.length, 6, 'one button per rank tier');
  assert.equal(rows.length, 2, 'expected 2 rows for 6 buttons at 3 per row');

  for (const tier of RANK_TIERS) {
    const btn = allButtons.find(b => b.custom_id === `queue_rank_duo_${tier.key}`);
    assert.ok(btn, `expected a button with customId queue_rank_duo_${tier.key}`);
    assert.equal(btn.emoji.name, tier.emoji);
    assert.equal(btn.label, tier.label);
  }

  assert.ok(!allButtons.some(b => b.custom_id === 'queue_duo'), 'must not include the generic single queue button');
});

test('buildRankedCupTournamentEmbed: shows a per-rank count breakdown, not one generic count', () => {
  const rankCounts = { bronze: 3, silver: 0, gold: 5, platinum: 1, diamond: 0, elite: 2 };
  const embed = buildRankedCupTournamentEmbed('Duos Ranked Cup (Battle Royale)', 'EU', rankCounts, false).toJSON();

  const field = embed.fields.find(f => /queuing/i.test(f.name));
  assert.ok(field, 'expected a queuing breakdown field');
  assert.match(field.value, /Bronze.*3/);
  assert.match(field.value, /Gold.*5/);
  assert.match(field.value, /Elite.*2/);
  assert.ok(!embed.fields.some(f => f.name === '🟢 Players Queuing'), 'must not use the plain single-count field name');
});

test('buildQueueButtons (non-ranked path) is completely unaffected — still a single generic button', () => {
  const row = buildQueueButtons(false).toJSON();
  assert.equal(row.components.length, 1);
  assert.equal(row.components[0].custom_id, 'queue_duo');
});

// ── 4. channel-manager.js integration ─────────────────────────────────────────
function makeFakeChannel(id, name) {
  const channel = {
    id, name, parentId: null,
    sentPayload: null,
    async setName(n) { channel.name = n; return channel; },
    async send(payload) {
      channel.sentPayload = payload;
      return { id: `msg-${id}`, async pin() {} };
    },
  };
  return channel;
}

function makeFakeGuild(id) {
  const channelsById = new Map();
  let nextId = 5000;
  return {
    guild: {
      id,
      roles: { everyone: `everyone-${id}` },
      client: { user: { id: 'bot-id' } },
      channels: {
        cache: { find: predicate => [...channelsById.values()].find(predicate) },
        fetch: async cid => channelsById.get(cid) ?? null,
        async create({ name }) {
          const channel = makeFakeChannel(String(nextId++), name);
          channelsById.set(channel.id, channel);
          return channel;
        },
      },
    },
    channelsById,
  };
}

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

test('createTournamentChannel: a Ranked Cup title gets the per-rank buttons + breakdown embed', async () => {
  const { guild, channelsById } = makeFakeGuild(`guild_${Math.random()}`);
  const pinnedMessages = {};

  const tournament = {
    name: 'Duos Ranked Cup (Battle Royale)', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
    isTrios: false, consoleOnly: false, isPermanent: false, eventId: 'epicgames_rankedcup_EU', isRankedCup: true,
  };

  await channelManager.createTournamentChannel(guild, tournament, pinnedMessages);

  const created = [...channelsById.values()][0];
  assert.ok(created, 'channel should have been created');
  assert.equal(created.sentPayload.components.length, 2, 'expected 2 button rows for the 6 rank buttons');
  const allButtons = created.sentPayload.components.flatMap(r => r.toJSON().components);
  assert.equal(allButtons.length, 6);
  assert.ok(allButtons.every(b => b.custom_id.startsWith('queue_rank_')), 'every button must be rank-scoped');

  const pinnedEntry = Object.values(pinnedMessages)[0];
  assert.equal(pinnedEntry.isRankedCup, true, 'pinnedMessages entry must record isRankedCup for the embed-refresh loop');
});

test('createTournamentChannel: a normal (non-Ranked-Cup) tournament is completely unaffected — single button, no isRankedCup', async () => {
  const { guild, channelsById } = makeFakeGuild(`guild_${Math.random()}`);
  const pinnedMessages = {};

  const tournament = {
    name: 'Mongraal Cup', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
    isTrios: false, consoleOnly: false, isPermanent: false, eventId: 'epicgames_mongraal_EU', isRankedCup: false,
  };

  await channelManager.createTournamentChannel(guild, tournament, pinnedMessages);

  const created = [...channelsById.values()][0];
  assert.ok(created, 'channel should have been created');
  assert.equal(created.sentPayload.components.length, 1, 'expected exactly 1 row (the normal generic button)');
  const buttons = created.sentPayload.components[0].toJSON().components;
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].custom_id, 'queue_duo');

  const pinnedEntry = Object.values(pinnedMessages)[0];
  assert.equal(pinnedEntry.isRankedCup, false);
});
