// players.js - Guild-scoped player profile storage via models/Player.js. Replaces the old
// database.js, which was a pure in-memory, non-guild-scoped registry whose registerUser() was
// never called and whose updateUser() silently no-op'd on any player who'd never been
// "registered" first — every select-menu-driven profile update was effectively lost. upsertPlayer
// here always creates-or-updates in one atomic call, so that bug can't recur.

const PlayerModel = require('./models/Player');
const { scrapePlayer } = require('./scraper');
const { getEpicFromDiscord } = require('./yunite');

// How long a scraped stats snapshot is trusted before a Queue click triggers a fresh FT scrape
// (getPlayerStats), vs. how often a player may force one early via /refresh-stats
// (refreshPlayerStats). Deliberately separate constants — one paces automatic reuse, the other
// paces user-initiated re-scrapes — even though today they're both read off the same
// lastUpdated timestamp.
const STATS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000;

async function getPlayer(guildId, discordId) {
  return PlayerModel.findOne({ guildId, discordId }).lean();
}

async function upsertPlayer(guildId, discordId, fields) {
  return PlayerModel.findOneAndUpdate(
    { guildId, discordId },
    { $set: fields, $setOnInsert: { guildId, discordId, registeredAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  ).lean();
}

async function isRegisteredPlayer(guildId, discordId) {
  return !!(await getPlayer(guildId, discordId));
}

function formatAge(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${(mins / 60).toFixed(1)}h`;
}

function toStatsFields(scraped) {
  return {
    totalPR: scraped.totalPR,
    thisSeasonPR: scraped.thisSeasonPR,
    prBand: scraped.prBand,
    recentEvents: scraped.recentEvents,
    lastUpdated: new Date(),
  };
}

// Called on every Queue click (queue.js's buildPlayer). Reuses a player's MongoDB record if it
// was scraped within STATS_CACHE_TTL_MS — skipping the Puppeteer/FT Tracker round trip entirely
// — otherwise scrapes fresh and persists the result for next time.
async function getPlayerStats(guildId, discordId, epicUsername, epicId, region) {
  const existing = await PlayerModel.findOne({ guildId, discordId });
  const age = existing?.lastUpdated ? Date.now() - existing.lastUpdated.getTime() : null;

  if (existing?.lastUpdated && age < STATS_CACHE_TTL_MS && existing.totalPR != null) {
    console.log(`[stats] cache HIT for ${epicUsername} (${discordId}) — scraped ${formatAge(age)} ago, skipping FT scrape`);
    return {
      totalPR: existing.totalPR,
      thisSeasonPR: existing.thisSeasonPR ?? 0,
      prBand: existing.prBand ?? null,
      recentEvents: existing.recentEvents ?? [],
    };
  }

  console.log(
    `[stats] cache MISS for ${epicUsername} (${discordId}) — `
    + `${existing?.lastUpdated ? `stale (${formatAge(age)} old)` : 'no cached record'}, scraping fresh`
  );
  const fresh = await scrapePlayer(epicUsername, region, epicId);
  await upsertPlayer(guildId, discordId, { epicUsername, epicId, ...toStatsFields(fresh) });
  return fresh;
}

// Called by the /refresh-stats command. Unlike getPlayerStats, this always scrapes fresh unless
// the player already refreshed within the last hour, in which case it reports back when they can
// try again instead of silently reusing the cache.
async function refreshPlayerStats(guildId, discordId, epicUsername, epicId, region) {
  const existing = await PlayerModel.findOne({ guildId, discordId });
  const age = existing?.lastUpdated ? Date.now() - existing.lastUpdated.getTime() : null;

  if (existing?.lastUpdated && age < REFRESH_COOLDOWN_MS) {
    const retryAt = new Date(existing.lastUpdated.getTime() + REFRESH_COOLDOWN_MS);
    console.log(`[stats] manual refresh DENIED for ${epicUsername} (${discordId}) — on cooldown for ${formatAge(REFRESH_COOLDOWN_MS - age)} more`);
    return { limited: true, retryAt };
  }

  console.log(`[stats] manual refresh for ${epicUsername} (${discordId}) — scraping fresh`);
  const fresh = await scrapePlayer(epicUsername, region, epicId);
  await upsertPlayer(guildId, discordId, { epicUsername, epicId, ...toStatsFields(fresh) });
  return { limited: false, stats: fresh };
}

// Called by the mod-only /force-refresh command. Unlike refreshPlayerStats, this ignores both
// the 24h cache and the 1h self-service cooldown entirely — a mod override that always does
// exactly what was asked.
async function forceRefreshStats(guildId, discordId, epicUsername, epicId, region) {
  console.log(`[stats] force refresh for ${epicUsername} (${discordId}) — scraping fresh, ignoring cache`);
  const fresh = await scrapePlayer(epicUsername, region, epicId);
  await upsertPlayer(guildId, discordId, { epicUsername, epicId, ...toStatsFields(fresh) });
  return fresh;
}

// Called by channel-manager.js when a tournament's beginTime passes (upcoming -> past).
// Re-scrapes every player registered with this guild+region so their cached stats reflect the
// event that just happened, instead of waiting for each of them to individually hit the 24h
// cache expiry or the /refresh-stats cooldown. Scrapes are sequential (each launches its own
// headless browser via scrapePlayer) — deliberately not parallelized, so a region with many
// registered players doesn't spike memory with dozens of concurrent Chrome instances.
async function rescrapeRegisteredPlayers(guildId, region) {
  const registered = await PlayerModel.find({ guildId, region }).lean();

  if (registered.length === 0) {
    console.log(`[stats] batch rescrape: no registered players for guild=${guildId} region=${region}`);
    return;
  }

  console.log(`[stats] batch rescrape starting — ${registered.length} registered player(s) in guild=${guildId} region=${region}`);

  for (const player of registered) {
    try {
      // Re-resolve via Yunite rather than trusting the record's stored epicUsername/epicId —
      // that's whatever was current at the last scrape, and a player can re-link a different
      // Epic account in the meantime. Fall back to the stored value if Yunite's unavailable.
      const identity = await getEpicFromDiscord(player.discordId, guildId).catch(() => null);
      const epicUsername = identity?.epicName ?? player.epicUsername;
      const epicId = identity?.epicId ?? player.epicId;

      if (!epicUsername) {
        console.warn(`[stats]   skipping ${player.discordId} — no known Epic username`);
        continue;
      }

      const fresh = await scrapePlayer(epicUsername, region, epicId);
      await upsertPlayer(guildId, player.discordId, { epicUsername, epicId, ...toStatsFields(fresh) });
      console.log(`[stats]   refreshed ${epicUsername} (${player.discordId})`);
    } catch (err) {
      console.error(`[stats]   failed to rescrape ${player.discordId}:`, err.message);
    }
  }

  console.log(`[stats] batch rescrape complete for guild=${guildId} region=${region}`);
}

module.exports = {
  getPlayer,
  upsertPlayer,
  isRegisteredPlayer,
  getPlayerStats,
  refreshPlayerStats,
  forceRefreshStats,
  rescrapeRegisteredPlayers,
};
