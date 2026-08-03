// Verifies the real fix for a genuine gap found while working on the region/console visibility
// change: channel-manager.js's createTournamentChannel never wrote `consoleOnly` into
// pinnedMessages at all (at creation, or when an already-tracked channel is found again on a later
// scheduler tick) — even though tournament-scraper.js correctly computes it from real scraped
// platform data (platforms.length === 1 && platforms[0] === 'Console', NOT title-text guessing).
// index.js's queue_duo/lf2 handler reads `pinned.consoleOnly`, which was therefore always
// `undefined` -> `false` by the time queue.js's buildPlayer/isCompatiblePlatform saw it, silently
// disabling the console-only platform-compatibility restriction for every real console-only
// tournament (not a graceful degrade — a real, exploitable matching bug: a PC player could get
// matched into a nominally console-only tournament's lobby).
//
// This test drives the REAL functions in the REAL order: channel-manager.js's createTournamentChannel
// (against a fake Discord guild, same precedent as test/tournament-channel-rename.test.js) ->
// exactly what index.js's handler destructures off the resulting pinnedMessages entry ->
// queue.js's real buildPlayer/isCompatiblePlatform. guild-config.js is stubbed at the require-cache
// level purely to avoid hitting MongoDB (test/team-redesign.test.js's established precedent); so is
// players.js's getStatsForContext (avoids a real Puppeteer scrape) — everything downstream of those two
// stubs is the real, unmodified production code path.
const test = require('node:test');
const assert = require('node:assert/strict');
const DeletedTournamentChannelModel = require('../models/DeletedTournamentChannel');

const FORUM_ID = 'forum-1';

// async + awaiting fn(...) (not just returning its promise) matters here: the
// DeletedTournamentChannelModel.findOne stub is a property mutation on a shared singleton, unlike
// the require-cache module swap below (which channel-manager.js captures by destructuring at its
// own require() time — safe to unwind immediately). Restoring findOne before fn's own async body
// actually reaches its createTournamentChannel call would silently put the real, Mongo-backed one
// back before it's needed.
async function withStubbedModule(modPath, stubExports, fn) {
  const resolved = require.resolve(modPath);
  const previous = require.cache[resolved];
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: stubExports };

  const originalFindOne = DeletedTournamentChannelModel.findOne;
  DeletedTournamentChannelModel.findOne = () => ({ lean: async () => null });

  try {
    return await fn();
  } finally {
    delete require.cache[resolved];
    if (previous) require.cache[resolved] = previous;
    DeletedTournamentChannelModel.findOne = originalFindOne;
  }
}

function freshRequire(modPath) {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

// Tournament posts are forum threads now — this fake guild's forum channel is what
// createTournamentChannel actually calls .threads.create() on (guild-config's getChannelId stub
// below points 'tournamentForum' at FORUM_ID).
function makeFakeGuild() {
  const channelsById = new Map();
  let nextId = 0;

  const forum = {
    id: FORUM_ID,
    threads: {
      async create({ name, appliedTags }) {
        const thread = {
          id: String(1000 + nextId++),
          name,
          parentId: FORUM_ID,
          appliedTags: appliedTags ?? [],
          async setName(n) { thread.name = n; return thread; },
        };
        channelsById.set(thread.id, thread);
        return thread;
      },
    },
  };
  channelsById.set(FORUM_ID, forum);

  const guild = {
    id: 'guild1',
    roles: { everyone: 'everyone-role-id' },
    client: { user: { id: 'bot-id' } },
    channels: {
      cache: { find: predicate => [...channelsById.values()].find(predicate) },
      fetch: async (id) => channelsById.get(id) ?? null,
    },
  };
  return { guild, channelsById };
}

const GUILD_CONFIG_STUB = {
  getRoleId: () => null,
  // Matches any of the 9 region×build-mode forum keys (channel-manager.js's
  // `tournamentForum_${region}_${buildMode}`) to the one fake forum below — this test is about
  // consoleOnly flowing through, not routing itself (tournament-channel-rename.test.js covers
  // that), so one fake forum answering for whichever combo actually gets looked up is enough.
  getChannelId: (g, k) => (k.startsWith('tournamentForum_') ? FORUM_ID : null),
};

test('a known console-only tournament: consoleOnly flows all the way from the scraper-shaped tournament object to pinnedMessages', async () => {
  await withStubbedModule('../guild-config', GUILD_CONFIG_STUB, async () => {
    const channelManager = freshRequire('../channel-manager');
    const { guild } = makeFakeGuild();
    const pinnedMessages = {};

    // Shape channel-manager.js actually receives from tournament-scraper.js's buildTournamentGroups
    // for a real console-only cup (e.g. Fortnite Tracker's calendar reporting a single platformGroup
    // of "Console" for this window) — consoleOnly here is tournament-scraper.js's real, already-
    // computed boolean, not something this test invents independently.
    const consoleOnlyTournament = {
      name: 'Console Duos ZB Cash Cup',
      region: 'EU',
      beginTime: futureIso(20),
      lastBeginTime: futureIso(20),
      isTrios: false,
      consoleOnly: true,
      isPermanent: false,
      eventId: 'epicgames_consolecup_EU',
    };

    await channelManager.createTournamentChannel(guild, consoleOnlyTournament, pinnedMessages);
    clearTimeout(Object.values(channelManager.managedChannels)[0]?.deleteTimer);

    const [pinned] = Object.values(pinnedMessages);
    assert.ok(pinned, 'expected a pinnedMessages entry to have been created');
    assert.equal(pinned.consoleOnly, true, 'consoleOnly must be true on the pinnedMessages entry — this is exactly what was missing before the fix');

    // A second scheduler tick (channel already exists, matched by eventId) must not lose or reset
    // this field — exercises the "found" branch's backfill/sync path, not just first creation.
    await channelManager.createTournamentChannel(guild, consoleOnlyTournament, pinnedMessages);
    assert.equal(Object.values(pinnedMessages)[0].consoleOnly, true, 'consoleOnly must survive a subsequent tick where the channel is found, not re-created');
  });
});

test('an already-tracked channel missing consoleOnly (pre-fix data) gets backfilled on the next tick', async () => {
  await withStubbedModule('../guild-config', GUILD_CONFIG_STUB, async () => {
    const channelManager = freshRequire('../channel-manager');
    const { guild, channelsById } = makeFakeGuild();

    // Simulates a pre-existing forum post — the thread already exists (tracked by eventId in
    // pinnedMessages below), so createTournamentChannel must find and reuse it via the eventId
    // match, not call forum.threads.create() again.
    const existingChannel = { id: 'existing-thread-1', name: 'console-duos-zb-cash-cup', parentId: FORUM_ID, async setName(n) { this.name = n; return this; } };
    channelsById.set(existingChannel.id, existingChannel);

    // Simulates a real pre-fix pinnedMessages entry — created before this fix shipped, so it has
    // every other field but never got consoleOnly written at all (exactly the bug being fixed).
    const pinnedMessages = {
      [existingChannel.id]: {
        guildId: guild.id,
        tournamentEventId: 'epicgames_consolecup_EU',
        tournamentName: 'Console Duos ZB Cash Cup',
        region: 'EU',
        beginTime: futureIso(20),
        deleteAt: Date.now() + 999999,
        permanent: false,
        // consoleOnly deliberately absent here.
      },
    };

    await channelManager.createTournamentChannel(guild, {
      name: 'Console Duos ZB Cash Cup',
      region: 'EU',
      beginTime: futureIso(20),
      lastBeginTime: futureIso(20),
      isTrios: false,
      consoleOnly: true,
      isPermanent: false,
      eventId: 'epicgames_consolecup_EU',
    }, pinnedMessages);

    assert.equal(pinnedMessages[existingChannel.id].consoleOnly, true, 'a pre-existing entry missing consoleOnly should be backfilled, not left undefined forever');
  });
});

test('honest check: queue.js\'s isCompatiblePlatform was NOT gracefully degrading — with consoleOnly undefined it silently allowed PC+Console to match a "console-only" tournament', async () => {
  await withStubbedModule('../players', {
    // queue.js's buildPlayer calls getStatsForContext (not getPlayerStats directly) — see
    // players.js's real implementation. These tests don't exercise region/platform-context
    // resolution itself, just isCompatiblePlatform downstream of it, so a fixed home-context
    // response is enough.
    getStatsForContext: async () => ({
      stats: { totalPR: 100, thisSeasonPR: 0, recentEvents: [] },
      prContext: { region: 'EU', platformSegment: 'all', isHomeRegion: true, isHomePlatform: true },
    }),
    getPlayer: async () => null,
  }, async () => {
    const queue = freshRequire('../queue');

    const consolePlayer = await queue.buildPlayer({
      guildId: 'g1', discordId: 'console1', epicUsername: 'ConsolePlayer', tournamentName: 'Console Duos ZB Cash Cup',
      homeRegion: 'EU', queueRegion: 'EU', queueType: 'duo', platform: 'Console', consoleOnly: undefined,
    });
    const pcPlayer = await queue.buildPlayer({
      guildId: 'g1', discordId: 'pc1', epicUsername: 'PcPlayer', tournamentName: 'Console Duos ZB Cash Cup',
      homeRegion: 'EU', queueRegion: 'EU', queueType: 'duo', platform: 'PC', consoleOnly: undefined,
    });

    // This is the actual bug, demonstrated against the real, unmodified isCompatiblePlatform: with
    // consoleOnly undefined (the pre-fix state for every real console-only tournament), a PC player
    // and a Console player were considered compatible for what should have been a Console-exclusive
    // lobby.
    assert.equal(
      queue.isCompatiblePlatform({ members: [consolePlayer] }, { members: [pcPlayer] }),
      true,
      'confirms the pre-fix bug: PC+Console were silently allowed to match a nominally console-only tournament'
    );
  });
});

test('with the fix: isCompatiblePlatform correctly blocks a PC player from a console-only tournament, once consoleOnly is properly populated', async () => {
  await withStubbedModule('../players', {
    // queue.js's buildPlayer calls getStatsForContext (not getPlayerStats directly) — see
    // players.js's real implementation. These tests don't exercise region/platform-context
    // resolution itself, just isCompatiblePlatform downstream of it, so a fixed home-context
    // response is enough.
    getStatsForContext: async () => ({
      stats: { totalPR: 100, thisSeasonPR: 0, recentEvents: [] },
      prContext: { region: 'EU', platformSegment: 'all', isHomeRegion: true, isHomePlatform: true },
    }),
    getPlayer: async () => null,
  }, async () => {
    const queue = freshRequire('../queue');

    // consoleOnly: true — exactly what a fixed pinnedMessages entry now hands the queue-join
    // handler for a real console-only tournament (see the createTournamentChannel test above).
    const consolePlayer = await queue.buildPlayer({
      guildId: 'g1', discordId: 'console1', epicUsername: 'ConsolePlayer', tournamentName: 'Console Duos ZB Cash Cup',
      homeRegion: 'EU', queueRegion: 'EU', queueType: 'duo', platform: 'Console', consoleOnly: true,
    });
    const anotherConsolePlayer = await queue.buildPlayer({
      guildId: 'g1', discordId: 'console2', epicUsername: 'ConsolePlayer2', tournamentName: 'Console Duos ZB Cash Cup',
      homeRegion: 'EU', queueRegion: 'EU', queueType: 'duo', platform: 'Console', consoleOnly: true,
    });
    const pcPlayer = await queue.buildPlayer({
      guildId: 'g1', discordId: 'pc1', epicUsername: 'PcPlayer', tournamentName: 'Console Duos ZB Cash Cup',
      homeRegion: 'EU', queueRegion: 'EU', queueType: 'duo', platform: 'PC', consoleOnly: true,
    });

    assert.equal(
      queue.isCompatiblePlatform({ members: [consolePlayer] }, { members: [pcPlayer] }),
      false,
      'a PC player must not be matched into a console-only tournament once consoleOnly correctly flows through'
    );
    assert.equal(
      queue.isCompatiblePlatform({ members: [consolePlayer] }, { members: [anotherConsolePlayer] }),
      true,
      'two Console players must still match each other for a console-only tournament'
    );
  });
});
