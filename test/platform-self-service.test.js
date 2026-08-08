// Verifies the PC/Console self-service feature: #get-roles' new platform select (embeds.js's
// buildPlatformSelectRow) is ADDITIVE (0-2 of PC/Console), not a forced either/or pick — a real
// player can genuinely have both PC and Console history on the same account. players.js's
// resolveQueuePlatform is what turns that additive fact into the single value each real consumer
// still needs, contextually per queue action (console-eligible when it matters, PC as the broad
// cross-play default otherwise) — see that function's own doc comment for the full reasoning.
//
// This also closes a real, confirmed-live gap: Player.platforms (and its predecessor, the dead
// singular Player.platform field it replaces) was never populated by anything before this, which
// meant queue.js's isCompatiblePlatform (requiring platform === 'Console' for every member of a
// console-only match) could NEVER be true for anyone — a console-only tournament could never
// actually produce a match. resolveQueuePlatform returning null (genuinely not eligible) is what
// lets index.js block a join up front with a clear message instead of leaving a player stuck in a
// pool that can never match them.
const test = require('node:test');
const assert = require('node:assert/strict');

const playerStore = require('../players');
const { resolveQueuePlatform } = playerStore;
const { buildPlatformSelectRow, buildPlayerLookupEmbed } = require('../embeds');
const creativeQueue = require('../creative-queue');
const elo = require('../elo');
const PlayerModel = require('../models/Player');

// ── #1: resolveQueuePlatform — the core resolution logic ──────────────────────
test('resolveQueuePlatform: PC only — always PC, eligible for a console-only context only if Console was also checked (it wasn\'t)', () => {
  assert.equal(resolveQueuePlatform(['PC'], false), 'PC');
  assert.equal(resolveQueuePlatform(['PC'], true), null, 'PC-only is genuinely not console-eligible');
});

test('resolveQueuePlatform: Console only — always Console, including for a NON-console-only context (matches the kbm-segment PR a Console-only player has always needed)', () => {
  assert.equal(resolveQueuePlatform(['Console'], false), 'Console');
  assert.equal(resolveQueuePlatform(['Console'], true), 'Console');
});

test('resolveQueuePlatform: the real nuance — a player with BOTH PC and Console is PC by default, but genuinely Console-eligible for a console-only context', () => {
  assert.equal(resolveQueuePlatform(['PC', 'Console'], false), 'PC', 'broad cross-play default for a non-restricted context, unaffected by also having Console');
  assert.equal(resolveQueuePlatform(['PC', 'Console'], true), 'Console', 'having BOTH must not block console-only eligibility — this is the whole point of an additive fact, not a replace-one-with-the-other pick');
  // Order must not matter.
  assert.equal(resolveQueuePlatform(['Console', 'PC'], true), 'Console');
});

test('resolveQueuePlatform: neither set (never touched #get-roles\' platform select) — defaults to PC, same as every caller assumed before self-service existed', () => {
  assert.equal(resolveQueuePlatform([], false), 'PC');
  assert.equal(resolveQueuePlatform(undefined, false), 'PC');
  assert.equal(resolveQueuePlatform(null, false), 'PC');
});

test('resolveQueuePlatform: neither set AND the context is console-only — genuinely not eligible (null), never a guess', () => {
  assert.equal(resolveQueuePlatform([], true), null);
  assert.equal(resolveQueuePlatform(undefined, true), null);
});

// ── #2: embeds.js's buildPlatformSelectRow ─────────────────────────────────────
test('buildPlatformSelectRow: additive multi-select (0-2), PC and Console options, correct customId', () => {
  const row = buildPlatformSelectRow().toJSON();
  const menu = row.components[0];

  assert.equal(menu.custom_id, 'select_platform');
  assert.equal(menu.min_values, 0, 'must be optional — not a forced pick');
  assert.equal(menu.max_values, 2, 'must allow selecting BOTH, not force either/or');

  const values = menu.options.map(o => o.value);
  assert.deepEqual(values.sort(), ['Console', 'PC']);
});

// ── #3: creative-queue.js's buildCreativePlayer — internal resolution ─────────
function withStubbedGetPlayer(returnValue, fn) {
  const original = playerStore.getPlayer;
  playerStore.getPlayer = async () => returnValue;
  return Promise.resolve(fn()).finally(() => { playerStore.getPlayer = original; });
}

function withStubbedGetStatsForContext(fn) {
  const original = playerStore.getStatsForContext;
  playerStore.getStatsForContext = async (guildId, discordId, epicUsername, epicId, ctx) => ({
    stats: { totalPR: 500, thisSeasonPR: 0, recentEvents: [] },
    prContext: { region: ctx.queueRegion ?? ctx.homeRegion, platformSegment: 'all', isHomeRegion: true, isHomePlatform: true },
    __ctx: ctx, // exposed purely so these tests can assert on what buildCreativePlayer actually resolved
  });
  return Promise.resolve(fn()).finally(() => { playerStore.getStatsForContext = original; });
}

const baseArgs = {
  guildId: 'g1', guildName: 'Test Guild', discordId: 'p1', discordUsername: 'p1', discordTag: 'p1',
  epicUsername: 'p1', epicId: 'p1', region: 'EU', mode: '1v1 Realistics',
};

test('buildCreativePlayer: no longer takes an external platform argument — resolves it itself from the player\'s stored platforms', async () => {
  await withStubbedGetPlayer({ region: 'EU', platforms: ['Console'] }, async () => {
    await withStubbedGetStatsForContext(async () => {
      const player = await creativeQueue.buildCreativePlayer({ ...baseArgs, platform: 'PC' }); // deliberately passed, must be ignored
      assert.equal(player.platform, 'Console', 'must resolve from Player.platforms, ignoring any (now-meaningless) caller-supplied platform arg');
    });
  });
});

test('buildCreativePlayer: a player with BOTH PC and Console resolves to PC for creative (no console-only concept there)', async () => {
  await withStubbedGetPlayer({ region: 'EU', platforms: ['PC', 'Console'] }, async () => {
    await withStubbedGetStatsForContext(async () => {
      const player = await creativeQueue.buildCreativePlayer({ ...baseArgs });
      assert.equal(player.platform, 'PC');
    });
  });
});

test('buildCreativePlayer: a player who never touched the platform select defaults to PC', async () => {
  await withStubbedGetPlayer({ region: 'EU' }, async () => {
    await withStubbedGetStatsForContext(async () => {
      const player = await creativeQueue.buildCreativePlayer({ ...baseArgs });
      assert.equal(player.platform, 'PC');
    });
  });
});

// ── #4: elo.js — the dead-field bug this replaces ─────────────────────────────
function stubPlayerFind(players) {
  return (filter) => ({
    lean: async () => {
      if (filter.totalPR) return players.filter(p => p.totalPR != null);
      if (filter.epicUsernameLower) return players.filter(p => p.epicUsernameLower === filter.epicUsernameLower);
      if (filter.epicId) return players.filter(p => p.epicId === filter.epicId);
      if (filter.epicUsername instanceof RegExp) return players.filter(p => filter.epicUsername.test(p.epicUsername));
      return [];
    },
  });
}

test('elo.js: a Console player\'s real cached gamepad-context PR is now actually reachable (player.platform, the old dead field, was never written by anything)', async () => {
  const original = PlayerModel.find;
  const player = {
    epicUsername: 'RealConsolePlayer', epicUsernameLower: 'realconsoleplayer', epicId: 'realconsole1',
    region: 'EU', platforms: ['Console'],
    totalPR: 300, recentEvents: [], lastUpdated: new Date(),
    statsByContext: { 'EU|gamepad': { totalPR: 900, recentEvents: [{ name: 'Console Duos Victory Cup', placement: 3, prPoints: 250, rosterSize: 2 }] } },
  };
  PlayerModel.find = stubPlayerFind([player]);
  try {
    const result = await elo.getPublicElo('RealConsolePlayer');
    const victoryCup = result.tournaments.find(t => t.tournamentType === 'Console Duos Victory Cup');
    assert.equal(victoryCup.components.currentPR, 900, 'must use the real gamepad-context PR now that platforms is a real, populated signal');
  } finally {
    PlayerModel.find = original;
  }
});

test('elo.js: a player who never set a platform still gets the honest PC/"all"-segment default, not a crash', async () => {
  const original = PlayerModel.find;
  const player = {
    epicUsername: 'NoPlatformSet', epicUsernameLower: 'noplatformset', epicId: 'noplat1',
    region: 'EU', totalPR: 400, recentEvents: [], lastUpdated: new Date(),
  };
  PlayerModel.find = stubPlayerFind([player]);
  try {
    const result = await elo.getPublicElo('NoPlatformSet');
    assert.equal(result.creative.components.currentPR, 400);
  } finally {
    PlayerModel.find = original;
  }
});

// ── #5: embeds.js's buildPlayerLookupEmbed — the other dead-field display ────
test('buildPlayerLookupEmbed: shows the real platforms array, not the always-"Unknown" dead singular field', () => {
  const embed = buildPlayerLookupEmbed({ username: 'Someone' }, {
    epicUsername: 'Someone', region: 'EU', platforms: ['PC', 'Console'], totalPR: 500, thisSeasonPR: 10, lastUpdated: new Date(),
  }, { kind: 'new' }).toJSON();

  const field = embed.fields.find(f => /platform/i.test(f.name));
  assert.equal(field.value, 'PC, Console');
});

test('buildPlayerLookupEmbed: a player with no platforms set shows "Unknown", not a crash', () => {
  const embed = buildPlayerLookupEmbed({ username: 'Someone' }, {
    epicUsername: 'Someone', region: 'EU', totalPR: 500, thisSeasonPR: 10, lastUpdated: new Date(),
  }, { kind: 'new' }).toJSON();

  const field = embed.fields.find(f => /platform/i.test(f.name));
  assert.equal(field.value, 'Unknown');
});
