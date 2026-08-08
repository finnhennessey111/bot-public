// Verifies the severity split for real-time error alerting: a genuine, systemic bug (both Epic
// and Fortnite Tracker failing to scrape in the same tick) must DM an alert, while a routine,
// expected condition (a guild that simply hasn't run /matchmaker-setup yet, so it has no
// tournament forum configured) must NOT — alerting on the routine case would be exactly the "too
// noisy" failure mode this feature is supposed to avoid.
//
// Same require.cache-reset technique as test/guild-tournament-catchup.test.js (guild-config and
// its dependents) — extended here to also reset error-alert.js's cache, since
// BOT_OWNER_DISCORD_ID/JACOB_DISCORD_ID are read into module-level constants at require time (see
// test/error-alert.test.js). scrapeEpicCalendar/scrapeTrackerCalendar are monkey-patched on the
// tournament-scraper module object directly (not the destructured scrapeUpcomingTournaments
// channel-manager.js imports) because scrapeUpcomingTournaments calls them via
// `module.exports.scrapeEpicCalendar()`/`module.exports.scrapeTrackerCalendar()` internally — the
// same indirection test/guild-tournament-catchup.test.js already relies on.
const test = require('node:test');
const assert = require('node:assert/strict');
const DeletedTournamentChannelModel = require('../models/DeletedTournamentChannel');

function makeFakeClient() {
  const sentDMs = [];
  const client = {
    users: {
      async fetch(discordId) {
        return {
          async send(payload) {
            sentDMs.push({ discordId, payload });
            return { id: `dm-${sentDMs.length}`, channelId: `chan-${discordId}` };
          },
        };
      },
    },
    guilds: { cache: new Map() },
  };
  return { client, sentDMs };
}

async function withFreshChannelManager({ guildConfigStub = { getChannelId: () => null } } = {}, fn) {
  const errorAlertPath = require.resolve('../error-alert');
  const guildConfigPath = require.resolve('../guild-config');
  const dependents = ['../channel-manager', '../permissions'].map(require.resolve);

  const previous = {
    errorAlert: require.cache[errorAlertPath],
    guildConfig: require.cache[guildConfigPath],
    dependents: dependents.map(p => require.cache[p]),
  };

  delete require.cache[errorAlertPath];
  delete require.cache[guildConfigPath];
  for (const p of dependents) delete require.cache[p];

  require.cache[guildConfigPath] = {
    id: guildConfigPath, filename: guildConfigPath, loaded: true, exports: guildConfigStub,
  };

  const originalOwner = process.env.BOT_OWNER_DISCORD_ID;
  const originalJacob = process.env.JACOB_DISCORD_ID;
  process.env.BOT_OWNER_DISCORD_ID = 'owner-1';
  process.env.JACOB_DISCORD_ID = 'jacob-1';

  const originalFindOne = DeletedTournamentChannelModel.findOne;
  DeletedTournamentChannelModel.findOne = () => ({ lean: async () => null });

  try {
    const channelManager = require('../channel-manager');
    const tournamentApproval = require('../tournament-approval');
    const tournamentScraperModule = require('../tournament-scraper');
    return await fn(channelManager, tournamentApproval, tournamentScraperModule);
  } finally {
    delete require.cache[errorAlertPath];
    delete require.cache[guildConfigPath];
    for (const p of dependents) delete require.cache[p];
    if (previous.errorAlert) require.cache[errorAlertPath] = previous.errorAlert;
    if (previous.guildConfig) require.cache[guildConfigPath] = previous.guildConfig;
    dependents.forEach((p, i) => { if (previous.dependents[i]) require.cache[p] = previous.dependents[i]; });
    if (originalOwner === undefined) delete process.env.BOT_OWNER_DISCORD_ID; else process.env.BOT_OWNER_DISCORD_ID = originalOwner;
    if (originalJacob === undefined) delete process.env.JACOB_DISCORD_ID; else process.env.JACOB_DISCORD_ID = originalJacob;
    DeletedTournamentChannelModel.findOne = originalFindOne;
  }
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

test('SEVERITY SPLIT — genuine bug: Epic AND Fortnite Tracker both fail in the same tick DMs an error alert', async () => {
  await withFreshChannelManager({}, async (channelManager, tournamentApproval, tournamentScraperModule) => {
    const { client, sentDMs } = makeFakeClient();

    const originalScrapeEpic = tournamentScraperModule.scrapeEpicCalendar;
    const originalScrapeTracker = tournamentScraperModule.scrapeTrackerCalendar;
    tournamentScraperModule.scrapeEpicCalendar = async () => { throw new Error('Epic API down'); };
    tournamentScraperModule.scrapeTrackerCalendar = async () => { throw new Error('Fortnite Tracker unreachable'); };

    try {
      await channelManager.runTournamentCheckTick(client, {});

      assert.equal(sentDMs.length, 2, 'a total scrape failure is a real, systemic problem — both the owner and Jacob must be DMed');
      assert.deepEqual(sentDMs.map(d => d.discordId).sort(), ['jacob-1', 'owner-1']);

      const embed = sentDMs[0].payload.embeds[0];
      assert.match(embed.title, /Tournament Scrape/);
      assert.match(embed.description, /Epic API down|Fortnite Tracker unreachable/);
      assert.doesNotMatch(embed.description, /at .*\(.*:\d+:\d+\)/, 'must be a concise summary, not a raw stack trace');

      assert.equal(channelManager.getLastSuccessfulScrapeAt(), null, 'a failed scrape must never advance the last-successful-scrape timestamp');
    } finally {
      tournamentScraperModule.scrapeEpicCalendar = originalScrapeEpic;
      tournamentScraperModule.scrapeTrackerCalendar = originalScrapeTracker;
    }
  });
});

test('SEVERITY SPLIT — routine condition: a guild with no tournament forum configured yet sends NO error alert', async () => {
  await withFreshChannelManager({ guildConfigStub: { getChannelId: () => null } }, async (channelManager, tournamentApproval, tournamentScraperModule) => {
    const { client, sentDMs } = makeFakeClient();
    const guild = {
      id: 'brand-new-guild',
      channels: { cache: { find: () => undefined }, fetch: async () => null },
    };

    const originalScrapeEpic = tournamentScraperModule.scrapeEpicCalendar;
    const originalGate = tournamentApproval.gateTournaments;
    tournamentScraperModule.scrapeEpicCalendar = async () => [approvedTournament()];
    tournamentApproval.gateTournaments = async (c, tournaments) => tournaments;

    try {
      await assert.doesNotReject(() => channelManager.catchUpTournamentsForGuild(client, guild, {}));
      assert.equal(sentDMs.length, 0, 'a guild simply not having run /matchmaker-setup yet is expected and routine — it must never wake anyone up');

      const stamp = channelManager.getLastSuccessfulScrapeAt();
      assert.ok(stamp instanceof Date, 'the scrape itself still succeeded (only the per-guild forum lookup was routinely empty) — the health timestamp must still advance');
    } finally {
      tournamentScraperModule.scrapeEpicCalendar = originalScrapeEpic;
      tournamentApproval.gateTournaments = originalGate;
    }
  });
});
