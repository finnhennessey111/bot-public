// Verifies the real production bug reported live: a brand-new guild showed zero tournament posts
// even though tournaments were already approved and live in other servers. Investigation confirmed
// tournamentApproval.gateTournaments already re-includes every still-'approved' record on EVERY
// scheduled tick regardless of per-guild state (the persistent record system works correctly) — the
// actual gap was that nothing ran that same scrape->gate->create sequence for ONE specific guild
// immediately on join or right after /matchmaker-setup; a new guild just waited for the next
// scheduled tick (up to 4h away). channel-manager.js's new catchUpTournamentsForGuild fixes this by
// reusing the exact same composition (scrapeUpcomingTournaments -> gateTournaments ->
// checkAndCreateChannels) the scheduled tick and /check-tournaments already used, just scoped to one
// guild and run immediately. Same withStubbedGuildConfig/fake-forum precedent as
// test/tournament-channel-visibility.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const DeletedTournamentChannelModel = require('../models/DeletedTournamentChannel');

async function withStubbedGuildConfig(stubExports, fn) {
  const guildConfigPath = require.resolve('../guild-config');
  const dependents = ['../channel-manager', '../permissions'].map(require.resolve);
  const previousGuildConfig = require.cache[guildConfigPath];
  const previousDependents = dependents.map(p => require.cache[p]);
  delete require.cache[guildConfigPath];
  for (const p of dependents) delete require.cache[p];

  require.cache[guildConfigPath] = {
    id: guildConfigPath, filename: guildConfigPath, loaded: true, exports: stubExports,
  };

  const originalFindOne = DeletedTournamentChannelModel.findOne;
  DeletedTournamentChannelModel.findOne = () => ({ lean: async () => null });

  try {
    const channelManager = require('../channel-manager');
    const tournamentApproval = require('../tournament-approval');
    const tournamentScraperModule = require('../tournament-scraper');
    return await fn(channelManager, tournamentApproval, tournamentScraperModule);
  } finally {
    delete require.cache[guildConfigPath];
    for (const p of dependents) delete require.cache[p];
    if (previousGuildConfig) require.cache[guildConfigPath] = previousGuildConfig;
    dependents.forEach((p, i) => { if (previousDependents[i]) require.cache[p] = previousDependents[i]; });
    DeletedTournamentChannelModel.findOne = originalFindOne;
  }
}

function forumId(region, buildMode) {
  return `forum-${region}-${buildMode}`;
}

function getChannelIdStub(g, k) {
  const match = k.match(/^tournamentForum_(EU|NAC|ME)_(battle_royale|zero_build|reload)$/);
  return match ? forumId(match[1], match[2]) : null;
}

function makeFakeForum(id) {
  const createdThreads = [];
  const forum = {
    id, name: id,
    permissionOverwrites: { edit: async () => {} },
    threads: {
      create: async ({ name, message }) => {
        const thread = { id: `${id}-thread-${createdThreads.length + 1}`, name, parentId: id };
        createdThreads.push({ thread, message });
        return thread;
      },
    },
  };
  return { forum, createdThreads };
}

function makeFakeGuild({ withForums = true } = {}) {
  const forums = {};
  const channelsById = new Map();

  if (withForums) {
    for (const region of ['EU', 'NAC', 'ME']) {
      for (const buildMode of ['battle_royale', 'zero_build', 'reload']) {
        const id = forumId(region, buildMode);
        const built = makeFakeForum(id);
        forums[`${region}_${buildMode}`] = built;
        channelsById.set(id, built.forum);
      }
    }
  }

  const guild = {
    id: 'brand-new-guild',
    roles: { everyone: { id: 'everyone-role-id', permissions: { remove: () => ({ bitfield: 0n }), bitfield: 0n }, setPermissions: async () => {} } },
    members: { me: { id: 'bot-id' } },
    client: { user: { id: 'bot-id' } },
    channels: {
      cache: { find: () => undefined },
      fetch: async (id) => channelsById.get(id) ?? null,
    },
  };
  return { guild, forums };
}

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

function approvedTournament(overrides = {}) {
  return {
    name: 'Some Already-Approved Cup', region: 'EU',
    beginTime: futureIso(20), lastBeginTime: futureIso(20),
    isTrios: false, consoleOnly: false, isPermanent: false,
    eventId: 'epicgames_somecup_EU',
    ...overrides,
  };
}

test('catchUpTournamentsForGuild: a currently-approved tournament gets a real forum post immediately, not on the next scheduled tick', async () => {
  await withStubbedGuildConfig({ getChannelId: getChannelIdStub }, async (channelManager, tournamentApproval, tournamentScraperModule) => {
    const { guild, forums } = makeFakeGuild();

    const originalScrapeEpic = tournamentScraperModule.scrapeEpicCalendar;
    const originalGate = tournamentApproval.gateTournaments;
    tournamentScraperModule.scrapeEpicCalendar = async () => [approvedTournament()];
    // Simulates "this eventId already has an 'approved' record" — gateTournaments' own DB-backed
    // logic is covered separately (tournament-approval tests); this test is specifically about
    // catchUpTournamentsForGuild's composition, so the gate is stubbed to just pass everything
    // through, same as an already-approved record would.
    tournamentApproval.gateTournaments = async (client, tournaments) => tournaments;

    try {
      await channelManager.catchUpTournamentsForGuild({}, guild, {});

      const { createdThreads } = forums.EU_battle_royale;
      assert.equal(createdThreads.length, 1, 'the already-approved tournament should get a real forum post in this brand-new guild immediately');
      clearTimeout(channelManager.managedChannels[createdThreads[0].thread.id]?.deleteTimer);
    } finally {
      tournamentScraperModule.scrapeEpicCalendar = originalScrapeEpic;
      tournamentApproval.gateTournaments = originalGate;
    }
  });
});

test('catchUpTournamentsForGuild: safe to call before /matchmaker-setup has run — no forum configured yet logs and skips, never throws', async () => {
  await withStubbedGuildConfig({ getChannelId: () => null }, async (channelManager, tournamentApproval, tournamentScraperModule) => {
    const { guild } = makeFakeGuild({ withForums: false });

    const originalScrapeEpic = tournamentScraperModule.scrapeEpicCalendar;
    const originalGate = tournamentApproval.gateTournaments;
    tournamentScraperModule.scrapeEpicCalendar = async () => [approvedTournament()];
    tournamentApproval.gateTournaments = async (client, tournaments) => tournaments;

    try {
      await assert.doesNotReject(() => channelManager.catchUpTournamentsForGuild({}, guild, {}));
    } finally {
      tournamentScraperModule.scrapeEpicCalendar = originalScrapeEpic;
      tournamentApproval.gateTournaments = originalGate;
    }
  });
});

test('catchUpTournamentsForGuild: an already-existing post for this guild is not duplicated (same dedupe createTournamentChannel already has)', async () => {
  await withStubbedGuildConfig({ getChannelId: getChannelIdStub }, async (channelManager, tournamentApproval, tournamentScraperModule) => {
    const { guild, forums } = makeFakeGuild();
    const tournament = approvedTournament();

    const originalScrapeEpic = tournamentScraperModule.scrapeEpicCalendar;
    const originalGate = tournamentApproval.gateTournaments;
    tournamentScraperModule.scrapeEpicCalendar = async () => [tournament];
    tournamentApproval.gateTournaments = async (client, tournaments) => tournaments;

    // A real fetchable fake channel — findExistingTournamentChannel's eventId path calls
    // guild.channels.fetch(channelId) and only treats it as a live match if that resolves truthy;
    // without this, the match would silently fall through to the (also-empty) name-based check
    // instead, and this test would pass for the wrong reason (nothing throwing, not the dedupe
    // actually firing). Named to exactly match what buildChannelName would produce, so
    // createTournamentChannel takes the "skip, already exists" branch rather than the rename one.
    const expectedName = channelManager.buildChannelName(tournament.name, null);
    const existingThread = { id: 'existing-thread-1', name: expectedName, setName: async () => {} };
    const originalFetch = guild.channels.fetch;
    guild.channels.fetch = async (id) => (id === 'existing-thread-1' ? existingThread : originalFetch(id));

    const pinnedMessages = {
      'existing-thread-1': { guildId: guild.id, tournamentEventId: tournament.eventId, region: 'EU' },
    };
    forums.EU_battle_royale.forum.threads.create = async () => { throw new Error('should not create a second post'); };

    try {
      await assert.doesNotReject(() => channelManager.catchUpTournamentsForGuild({}, guild, pinnedMessages));
    } finally {
      tournamentScraperModule.scrapeEpicCalendar = originalScrapeEpic;
      tournamentApproval.gateTournaments = originalGate;
    }
  });
});
