// players.js - Guild-scoped player profile storage via models/Player.js. Replaces the old
// database.js, which was a pure in-memory, non-guild-scoped registry whose registerUser() was
// never called and whose updateUser() silently no-op'd on any player who'd never been
// "registered" first — every select-menu-driven profile update was effectively lost. upsertPlayer
// here always creates-or-updates in one atomic call, so that bug can't recur.

const PlayerModel = require('./models/Player');
const config = require('./config');
const { scrapePlayer } = require('./scraper');

// How long a scraped stats snapshot is trusted before a Queue click triggers a fresh FT scrape
// (getPlayerStats), vs. how often a player may force one early via /refresh-stats
// (refreshPlayerStats). Deliberately separate constants — one paces automatic reuse, the other
// paces user-initiated re-scrapes — even though today they're both read off the same
// lastUpdated timestamp.
const RECENT_ACTIVITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000;

// Old tournament results never change once they're over — re-scraping a player whose most recent
// recorded activity is already old can't turn up anything different, so such a player gets a much
// longer TTL than one who's actively competing (where a fresh event, or Fortnite Tracker's own
// continuous PR decay, could genuinely have moved the numbers since yesterday). ~90 days is a
// conservative floor for "more than a Fortnite competitive season has passed" (real seasons run
// roughly 10-14 weeks) — used only to pick a cache TTL, never to hide/discard any event data
// itself (recentEvents is stored and returned exactly as scraped either way).
const SETTLED_ACTIVITY_WINDOW_DAYS = 90;

// Not literally permanent: totalPR is Fortnite Tracker's own continuously-decaying figure (see
// scraper.js/elo.js's doc comments on totalPR) — it can still drift slowly even for a player with
// zero new events, so treating a "settled" player as cached forever would eventually go stale in
// a way nothing would ever notice or correct. 30 days is a large reduction from the 24h recent-
// activity TTL (the actual goal — meaningfully cut redundant re-scraping of data that can't have
// meaningfully changed) without claiming a permanence this data doesn't really have.
const SETTLED_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// A player with NO recorded events at all (brand new, or never actually competed) is deliberately
// NOT "settled" — they could start playing any day, and there's no history to judge recency from,
// so they stay on the short TTL rather than risking a month-stale zero after their first real
// event. Only a player with genuine history whose MOST RECENT entry (recentEvents is stored
// newest-first — see scraper.js's parseProfileData) is already old counts as settled.
function cacheTtlMsFor(recentEvents) {
  const newestDate = recentEvents?.[0]?.date ? new Date(recentEvents[0].date).getTime() : null;
  if (newestDate == null) return RECENT_ACTIVITY_CACHE_TTL_MS;

  const ageDays = (Date.now() - newestDate) / (24 * 60 * 60 * 1000);
  return ageDays > SETTLED_ACTIVITY_WINDOW_DAYS ? SETTLED_CACHE_TTL_MS : RECENT_ACTIVITY_CACHE_TTL_MS;
}

async function getPlayer(guildId, discordId) {
  return PlayerModel.findOne({ guildId, discordId }).lean();
}

// Auto-derives epicUsernameLower from epicUsername whenever the latter is part of this update
// (including clearing it to null on unlink) — every call site that ever sets epicUsername
// (linkEpicAccount, getPlayerStats/refreshPlayerStats/forceRefreshStats, unlinkEpicAccount) goes
// through this one function, so none of them need to remember to keep it in sync themselves. See
// models/Player.js's doc comment on epicUsernameLower for why it exists.
async function upsertPlayer(guildId, discordId, fields) {
  const derived = 'epicUsername' in fields
    ? { epicUsernameLower: fields.epicUsername ? fields.epicUsername.toLowerCase() : null }
    : {};

  return PlayerModel.findOneAndUpdate(
    { guildId, discordId },
    { $set: { ...fields, ...derived }, $setOnInsert: { guildId, discordId, registeredAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  ).lean();
}

// Public, unauthenticated lookup (elo.js's GET /api/elo/:epicUsername) — the same real person can
// be registered under multiple guilds (one Player doc each), so this resolves via the stable
// epicId (never the guild-scoped discordId+guildId key every other function here uses) to always
// land on one consistent result regardless of which guild's record happened to match the searched
// username. Case-insensitive exact match against the indexed epicUsernameLower field — fast enough
// for a public, repeatedly-hammerable endpoint without needing a regex scan.
async function findCanonicalByEpicUsername(epicUsername) {
  const trimmed = String(epicUsername ?? '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  let candidates = await PlayerModel.find({ epicUsernameLower: lower }).lean();

  // Fallback for a record written before epicUsernameLower existed (upsertPlayer only sets it on
  // a write that touches epicUsername — see that function's doc comment) and never re-saved since
  // — confirmed against real production data: every pre-existing Player document has epicUsername
  // populated but epicUsernameLower genuinely missing. Without this, a real, linked, previously-
  // scraped player incorrectly reports as "not found" until their record happens to get rewritten.
  // Slower (an unindexed, case-insensitive regex scan) but only ever reached for a record this gap
  // actually affects — backfill-epic-username-lower.js is the real fix for the general case, this
  // is what keeps correctness from depending on whether that script has been run yet.
  if (candidates.length === 0) {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    candidates = await PlayerModel.find({ epicUsername: new RegExp(`^${escaped}$`, 'i') }).lean();
  }

  if (candidates.length === 0) return null;

  const epicId = candidates.find(c => c.epicId)?.epicId;
  const sameAccount = epicId ? await PlayerModel.find({ epicId }).lean() : candidates;

  // Freshest scraped snapshot wins — different guilds' copies of the same real account can have
  // drifted lastUpdated timestamps depending on when each last actually queued.
  return sameAccount.reduce((freshest, doc) => {
    if (!freshest) return doc;
    const a = doc.lastUpdated ? new Date(doc.lastUpdated).getTime() : 0;
    const b = freshest.lastUpdated ? new Date(freshest.lastUpdated).getTime() : 0;
    return a > b ? doc : freshest;
  }, null);
}

async function isRegisteredPlayer(guildId, discordId) {
  return !!(await getPlayer(guildId, discordId));
}

// Public autocomplete (elo.js's GET /api/elo/search) — up to `limit` registered Epic usernames
// whose lowercased name STARTS WITH the (also lowercased) query. Prefix-anchored on purpose, not a
// bare substring: a bare substring regex can't use a standard ascending index at all, while an
// anchored prefix regex against the already-lowercased epicUsernameLower field can — same index
// findCanonicalByEpicUsername's own doc comment already relies on, reused here rather than an
// unindexed scan. "Registered" here means exactly what findCanonicalByEpicUsername already treats
// it as: has epicUsernameLower set at all (set once a player links an Epic username — see
// models/Player.js's doc comment on that field) — an account that never registered through the bot
// has no Player doc, so it's structurally impossible for one to appear here. Deliberately NOT
// additionally gated on epicOAuthLinked, for the same reason: the corresponding single-username
// lookup (findCanonicalByEpicUsername) doesn't gate on it either, and an autocomplete that suggests
// a name the exact-match endpoint then can't find would be a confusing mismatch.
//
// Deduped by epicId, same freshest-by-lastUpdated tie-break as findCanonicalByEpicUsername — the
// same real account registered under N guilds must only ever fill ONE of the `limit` slots, never N
// copies of itself crowding out other distinct players. Over-fetches (limit * 20, still a bounded
// cap, not a full scan) before deduping, since naively taking the first `limit` raw docs could
// under-fill the final list even when enough distinct accounts genuinely match. Sorted
// alphabetically by the same indexed field the query itself filters on — the cheapest order to
// fetch in, and a reasonable, deterministic "closest match" ordering for a prefix search; not a
// relevance/popularity ranking.
async function searchEpicUsernames(query, limit = 5) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return [];

  const lower = trimmed.toLowerCase();
  const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const candidates = await PlayerModel.find({ epicUsernameLower: new RegExp(`^${escaped}`) })
    .sort({ epicUsernameLower: 1 })
    .limit(limit * 20)
    .lean();

  const byAccount = new Map(); // epicId (or _id fallback for a legacy record with none) -> freshest doc
  for (const doc of candidates) {
    const key = doc.epicId ?? `_id:${doc._id}`;
    const age = doc.lastUpdated ? new Date(doc.lastUpdated).getTime() : 0;
    const existing = byAccount.get(key);
    const existingAge = existing?.lastUpdated ? new Date(existing.lastUpdated).getTime() : -1;
    if (!existing || age > existingAge) byAccount.set(key, doc);
  }

  return [...byAccount.values()].slice(0, limit).map(doc => doc.epicUsername);
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
// getPlayerStats' cache (below) keys purely off lastUpdated/discordId+guildId with no check that
// the cached snapshot actually belongs to the currently-linked epicId. Without this, a re-link to
// a different account could keep serving the OLD account's stats — mislabeled as the new one's —
// for as long as that cache entry's TTL happens to be (up to SETTLED_CACHE_TTL_MS for a settled
// snapshot, not just the shorter recent-activity one).
function clearedStatsFields() {
  // statsByContext included: those per-(region, platform) snapshots (getContextualPlayerStats)
  // belong to the OLD epicId just as much as the home-context fields do — leaving them behind on
  // a re-link would keep serving the old account's region/platform-specific PR indefinitely
  // whenever a future queue join happens to need a non-home context.
  return { totalPR: null, thisSeasonPR: null, prBand: null, recentEvents: [], lastUpdated: null, statsByContext: {} };
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
// was scraped within its recency-based TTL (cacheTtlMsFor — short for a player with recent/
// current-season activity, much longer for one whose history is already settled) — skipping the
// Puppeteer/FT Tracker round trip entirely — otherwise scrapes fresh and persists the result for
// next time. This is always the player's HOME region, default-platform snapshot — see
// getStatsForContext below for a queue-region/platform-specific fetch.
async function getPlayerStats(guildId, discordId, epicUsername, epicId, region) {
  const existing = await PlayerModel.findOne({ guildId, discordId });
  const age = existing?.lastUpdated ? Date.now() - existing.lastUpdated.getTime() : null;

  if (existing?.lastUpdated && age < cacheTtlMsFor(existing.recentEvents) && existing.totalPR != null) {
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
// the passive TTL cache and the 1h self-service cooldown entirely — a mod override that always
// does exactly what was asked.
async function forceRefreshStats(guildId, discordId, epicUsername, epicId, region) {
  console.log(`[stats] force refresh for ${epicUsername} (${discordId}) — scraping fresh, ignoring cache`);
  const fresh = await scrapePlayer(epicUsername, region, epicId);
  await upsertPlayer(guildId, discordId, { epicUsername, epicId, ...toStatsFields(fresh) });
  return fresh;
}

// Region/platform-segment key for Player.statsByContext — see models/Player.js's doc comment on
// that field.
function contextKey(region, platformSegment) {
  return `${region}|${platformSegment}`;
}

// A player's PR for a SPECIFIC (region, platform-segment) context that genuinely differs from
// their home-context snapshot (getPlayerStats' top-level fields) — used when someone queues
// somewhere their cached home stats don't actually represent (a different region per #3, or a
// different Fortnite Tracker input segment for a Console player per #6). Additive: never touches
// or overwrites the home-context fields, and — same principle as getPlayerStats — only ever
// fetches the ONE context actually asked for, never every region/platform combo up front.
async function getContextualPlayerStats(guildId, discordId, epicUsername, epicId, region, platformSegment) {
  const key = contextKey(region, platformSegment);
  const existing = await PlayerModel.findOne({ guildId, discordId });
  const cached = existing?.statsByContext?.get(key);
  const age = cached?.lastUpdated ? Date.now() - new Date(cached.lastUpdated).getTime() : null;

  if (cached?.lastUpdated && age < cacheTtlMsFor(cached.recentEvents) && cached.totalPR != null) {
    console.log(`[stats] contextual cache HIT for ${epicUsername} (${discordId}) context=${key} — scraped ${formatAge(age)} ago`);
    return {
      totalPR: cached.totalPR,
      thisSeasonPR: cached.thisSeasonPR ?? 0,
      prBand: cached.prBand ?? null,
      recentEvents: cached.recentEvents ?? [],
    };
  }

  console.log(
    `[stats] contextual cache MISS for ${epicUsername} (${discordId}) context=${key} — `
    + `${cached?.lastUpdated ? `stale (${formatAge(age)} old)` : 'never fetched for this context'}, scraping fresh`
  );
  const fresh = await scrapePlayer(epicUsername, region, epicId, platformSegment);
  await PlayerModel.updateOne(
    { guildId, discordId },
    { $set: { [`statsByContext.${key}`]: toStatsFields(fresh) } }
  );
  return fresh;
}

// Single entry point queue.js's buildPlayer and creative-queue.js's buildCreativePlayer both call:
// resolves WHICH (region, platform-segment) context actually applies to this queue attempt, then
// fetches it (reusing the existing home-context cache when it's already the right context, so
// nothing behaves differently for the overwhelmingly common case of a player queueing in their own
// home region on their registered platform's default segment).
//
// Region (#3): always the region actually being queued for, not homeRegion — that's the whole
// point, a player's genuine standing is wherever they're actually about to play.
// Platform (#6): only ever overridden for a Console player — gamepad for a console-exclusive
// tournament, kbm otherwise — per config.ftPlatformSegments. tournamentConsoleOnly is a caller-
// supplied boolean (false for creative queue, which has no console-exclusive-mode concept the way
// tournaments' consoleOnly flag does) rather than this function inferring it.
//
// Returns both the stats AND prContext — the single indicator #6 asks for combining #3's region
// transparency and #6's platform transparency, rather than two separate ad-hoc signals (embeds.js's
// buildPrContextNote renders it).
async function getStatsForContext(guildId, discordId, epicUsername, epicId, { homeRegion, queueRegion, platform, tournamentConsoleOnly }) {
  const region = queueRegion ?? homeRegion;
  const platformSegment = platform === 'Console'
    ? (tournamentConsoleOnly ? config.ftPlatformSegments.Console : config.ftPlatformSegments.PC)
    : 'all';

  const isHomeRegion = region === homeRegion;
  const isHomePlatform = platformSegment === 'all';

  const stats = (isHomeRegion && isHomePlatform)
    ? await getPlayerStats(guildId, discordId, epicUsername, epicId, homeRegion)
    : await getContextualPlayerStats(guildId, discordId, epicUsername, epicId, region, platformSegment);

  return { stats, prContext: { region, platformSegment, isHomeRegion, isHomePlatform } };
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

// Powers elo.js's percentile ranking — needs "every OTHER player with a real recorded score",
// not just one guild's registrants, so this is deliberately NOT guild-scoped (unlike every other
// function here). Deduped down to one entry per real account using the SAME freshest-by-
// lastUpdated rule findCanonicalByEpicUsername uses for a single lookup — without this, a player
// registered under N guilds (a normal, already-supported situation — see that function's doc
// comment) would occupy N slots in the comparison pool and skew everyone else's percentile.
// Projected to only the fields the score formula actually needs, to keep the payload small.
//
// Full, unindexed collection scan (totalPR has no index) — fine at this bot's current scale (at
// most a few thousand Player docs across all guilds combined). If the player base ever grows
// into the tens of thousands, or this endpoint's traffic grows enough that a full scan per
// request becomes hot, this should move to a precomputed/cached leaderboard rather than
// recomputing every score on every single ELO lookup.
async function getAllScoredPlayers() {
  const docs = await PlayerModel.find(
    { totalPR: { $ne: null } },
    { epicId: 1, totalPR: 1, thisSeasonPR: 1, recentEvents: 1, lastUpdated: 1 }
  ).lean();

  const byAccount = new Map();
  for (const doc of docs) {
    // No epicId at all (legacy/never-OAuth-linked record) -> nothing to dedupe against; treat the
    // doc as its own account rather than accidentally merging unrelated null-epicId players.
    const key = doc.epicId ?? `_id:${doc._id}`;
    const existingAge = byAccount.get(key)?.lastUpdated ? new Date(byAccount.get(key).lastUpdated).getTime() : -1;
    const age = doc.lastUpdated ? new Date(doc.lastUpdated).getTime() : 0;
    if (age >= existingAge) byAccount.set(key, doc);
  }

  return [...byAccount.values()].map(doc => ({
    totalPR: doc.totalPR ?? 0,
    thisSeasonPR: doc.thisSeasonPR ?? 0,
    recentEvents: doc.recentEvents ?? [],
  }));
}

module.exports = {
  getPlayer,
  upsertPlayer,
  isRegisteredPlayer,
  isEpicLinked,
  linkEpicAccount,
  unlinkEpicAccount,
  getPlayerStats,
  getContextualPlayerStats,
  getStatsForContext,
  refreshPlayerStats,
  forceRefreshStats,
  rescrapeRegisteredPlayers,
  findCanonicalByEpicUsername,
  searchEpicUsernames,
  getAllScoredPlayers,
  cacheTtlMsFor,
  RECENT_ACTIVITY_CACHE_TTL_MS,
  SETTLED_CACHE_TTL_MS,
  SETTLED_ACTIVITY_WINDOW_DAYS,
};
