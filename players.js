// players.js - Guild-scoped player profile storage via models/Player.js. Replaces the old
// database.js, which was a pure in-memory, non-guild-scoped registry whose registerUser() was
// never called and whose updateUser() silently no-op'd on any player who'd never been
// "registered" first — every select-menu-driven profile update was effectively lost. upsertPlayer
// here always creates-or-updates in one atomic call, so that bug can't recur.

const PlayerModel = require('./models/Player');
const { scrapePlayer } = require('./scraper');

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

// A player can hold the "Registered" role (region set) without ever having linked Epic — legacy
// players from before Epic OAuth gating existed, or a manually-granted role — so linking is its
// own, independently-checked condition rather than inferred from Registered. Pure predicate over
// an already-fetched record (not an async DB lookup itself) so callers that already have the
// record on hand don't pay for a second fetch, and so this exact check is trivially unit-testable
// without a live MongoDB connection. Same three-field check index.js's resolveEpicIdentity uses
// internally to decide whether to trust the stored epicId/epicUsername.
function isEpicLinked(playerRecord) {
  return !!(playerRecord?.epicOAuthLinked && playerRecord.epicId && playerRecord.epicUsername);
}

// Clears whatever cached Fortnite Tracker stats are on a record — used whenever the linked Epic
// account changes (a fresh link, a re-link to a *different* account, or an explicit unlink), since
// getPlayerStats' 24h cache (below) keys purely off lastUpdated/discordId+guildId with no check
// that the cached snapshot actually belongs to the currently-linked epicId. Without this, a re-
// link to a different account could keep serving the OLD account's stats — mislabeled as the new
// one's — for up to 24h.
function clearedStatsFields() {
  return { totalPR: null, thisSeasonPR: null, prBand: null, recentEvents: [], lastUpdated: null };
}

// Called by the Epic OAuth callback (webhook-server.js) on every successful link, including a re-
// link to a different Epic account than whatever was linked before — re-triggering the same Link
// Epic Account flow is the existing, already-working way to change accounts (see epic_link_open's
// index.js handler), this just makes it safe: cached stats are only cleared when the epicId
// actually changes, so a same-account re-link (e.g. re-authorizing after a token issue) doesn't
// force a needless re-scrape. Delegates through module.exports (not closed-over local references)
// so a test can stub getPlayer/upsertPlayer without a live MongoDB connection — same pattern
// scraper.js's scrapePlayer uses for scrapePlayerOnce.
async function linkEpicAccount(guildId, discordId, { epicId, epicUsername }) {
  const existing = await module.exports.getPlayer(guildId, discordId);
  const isDifferentAccount = isEpicLinked(existing) && existing.epicId !== epicId;

  return module.exports.upsertPlayer(guildId, discordId, {
    epicId, epicUsername, epicOAuthLinked: true, epicLinkedAt: new Date(),
    ...(isDifferentAccount ? clearedStatsFields() : {}),
  });
}

// Reverts a player to the unlinked state (resolveEpicIdentity's Discord-nickname fallback) — the
// only way to fully unlink today, since re-triggering Link Epic Account only ever replaces the
// link with a new one, never removes it outright (see index.js's /unlink-epic command). Cached
// stats are always cleared here — they belong to the account being unlinked and must never be
// served against whatever gets linked (or not) next.
async function unlinkEpicAccount(guildId, discordId) {
  return module.exports.upsertPlayer(guildId, discordId, {
    epicId: null, epicUsername: null, epicOAuthLinked: false, epicLinkedAt: null,
    ...clearedStatsFields(),
  });
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

// Called by channel-manager.js when a tournament's beginTime passes (upcoming -> past). Used to
// eagerly re-scrape every player registered with this guild+region via a sequential burst of
// Puppeteer launches — a real contributor to the Cloudflare IP block described in
// tournament-scraper.js's doc comment. No scraping happens here anymore: this just expires every
// matching player's cached stats (clears lastUpdated) via one plain Mongo update, so
// getPlayerStats' existing cache-miss path naturally re-scrapes each of them fresh the next time
// they actually queue — spread out one-at-a-time over real usage instead of a synchronous burst,
// and a player who never queues again soon never gets scraped for nothing.
async function rescrapeRegisteredPlayers(guildId, region) {
  const result = await PlayerModel.updateMany(
    { guildId, region },
    { $set: { lastUpdated: null } }
  );

  const matched = result.matchedCount ?? 0;
  if (matched === 0) {
    console.log(`[stats] cache invalidation: no registered players for guild=${guildId} region=${region}`);
    return;
  }

  console.log(`[stats] cache invalidation — expired lastUpdated for ${matched} registered player(s) in guild=${guildId} region=${region} (re-scraped lazily on their next queue, via getPlayerStats)`);
}

module.exports = {
  getPlayer,
  upsertPlayer,
  isRegisteredPlayer,
  isEpicLinked,
  linkEpicAccount,
  unlinkEpicAccount,
  getPlayerStats,
  refreshPlayerStats,
  forceRefreshStats,
  rescrapeRegisteredPlayers,
};
