// players.js - Guild-scoped player profile storage via models/Player.js. Replaces the old
// database.js, which was a pure in-memory, non-guild-scoped registry whose registerUser() was
// never called and whose updateUser() silently no-op'd on any player who'd never been
// "registered" first — every select-menu-driven profile update was effectively lost. upsertPlayer
// here always creates-or-updates in one atomic call, so that bug can't recur.

const PlayerModel = require('./models/Player');
const config = require('./config');
const { scrapePlayer } = require('./scraper');

// How often a player may force a fresh FT scrape early via /refresh-stats (refreshPlayerStats),
// independent of everything below — a player-initiated action, not automatic cache reuse.
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000;

// Old tournament results never change once they're over — re-scraping a player whose most recent
// recorded activity is already old can't turn up anything different. ~90 days is a conservative
// floor for "more than a Fortnite competitive season has passed" (real seasons run roughly 10-14
// weeks) — used only to pick a cache-invalidation strategy, never to hide/discard any event data
// itself (recentEvents is stored and returned exactly as scraped either way).
const SETTLED_ACTIVITY_WINDOW_DAYS = 90;

// Not literally permanent: totalPR is Fortnite Tracker's own continuously-decaying figure (see
// scraper.js/elo.js's doc comments on totalPR) — it can still drift slowly even for a player with
// zero new events, so treating a "settled" player as cached forever would eventually go stale in
// a way nothing would ever notice or correct.
//
// This is now the ONE cache-TTL number in this file (getPlayerStats/getContextualPlayerStats both
// read it directly, no more per-player branching) — but it plays two different roles depending on
// isSettled(recentEvents):
//   - For a SETTLED player, this genuinely is the intended freshness policy — nothing about them
//     is expected to change often, so a flat 30-day passive expiry is the real mechanism.
//   - For an ACTIVE player, this is a backstop only. Real freshness for an active player comes
//     from invalidateStaleAfterEvent below (called from channel-manager.js the moment a real,
//     scraped tournament conclusion — Epic's own endTime, not a guess — passes for their region):
//     a player's cache isn't "stale" just because time passed, only once a tournament they'd
//     plausibly care about has actually concluded since their last scrape. This number only fires
//     for an active player if that event-driven path never ran at all (no FORTNITE_API_KEY, Epic's
//     calendar never carried a real endTime for anything in their region, etc.) — a safety net
//     against silent unbounded staleness, not the primary mechanism.
const SETTLED_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// A player with NO recorded events at all (brand new, or never actually competed) is deliberately
// NOT "settled" — they could start playing any day, and there's no history to judge recency from.
// Only a player with genuine history whose MOST RECENT entry (recentEvents is stored newest-first
// — see scraper.js's parseProfileData) is already old counts as settled. Exported so
// invalidateStaleAfterEvent's own tests can exercise this exact boundary directly.
function isSettled(recentEvents) {
  const newestDate = recentEvents?.[0]?.date ? new Date(recentEvents[0].date).getTime() : null;
  if (newestDate == null) return false;

  const ageDays = (Date.now() - newestDate) / (24 * 60 * 60 * 1000);
  return ageDays > SETTLED_ACTIVITY_WINDOW_DAYS;
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
  return { totalPR: null, thisSeasonPR: null, prBand: null, recentEvents: [], sessions: null, lastUpdated: null, statsByContext: {} };
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
    // scraper.js's parseProfileData deliberately leaves this null (never defaults to 0) when
    // Fortnite Tracker's own "Sessions" DOM block didn't render — see that function's own doc
    // comment on why 0 would be indistinguishable from "genuinely zero sessions" for tier-
    // comparison.js's PR-per-session efficiency factor, which divides by this.
    sessions: scraped.sessions ?? null,
    lastUpdated: new Date(),
  };
}

// Called on every Queue click (queue.js's buildPlayer). Reuses a player's MongoDB record if it
// was scraped within SETTLED_CACHE_TTL_MS — skipping the Puppeteer/FT Tracker round trip entirely
// — otherwise scrapes fresh and persists the result for next time. For an active player this
// passive check is rarely what actually decides staleness in practice: invalidateStaleAfterEvent
// (below) already nulls lastUpdated the moment a real tournament they'd plausibly care about
// concludes, well before this TTL would; see SETTLED_CACHE_TTL_MS's own doc comment for the full
// split. This is always the player's HOME region, default-platform snapshot — see
// getStatsForContext below for a queue-region/platform-specific fetch.
async function getPlayerStats(guildId, discordId, epicUsername, epicId, region) {
  const existing = await PlayerModel.findOne({ guildId, discordId });
  const age = existing?.lastUpdated ? Date.now() - existing.lastUpdated.getTime() : null;

  if (existing?.lastUpdated && age < SETTLED_CACHE_TTL_MS && existing.totalPR != null) {
    console.log(`[stats] cache HIT for ${epicUsername} (${discordId}) — scraped ${formatAge(age)} ago, skipping FT scrape`);
    return {
      totalPR: existing.totalPR,
      thisSeasonPR: existing.thisSeasonPR ?? 0,
      prBand: existing.prBand ?? null,
      recentEvents: existing.recentEvents ?? [],
      sessions: existing.sessions ?? null,
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

  if (cached?.lastUpdated && age < SETTLED_CACHE_TTL_MS && cached.totalPR != null) {
    console.log(`[stats] contextual cache HIT for ${epicUsername} (${discordId}) context=${key} — scraped ${formatAge(age)} ago`);
    return {
      totalPR: cached.totalPR,
      thisSeasonPR: cached.thisSeasonPR ?? 0,
      prBand: cached.prBand ?? null,
      recentEvents: cached.recentEvents ?? [],
      sessions: cached.sessions ?? null,
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
// tournaments' consoleOnly flag does) rather than this function inferring it. `platform` here is
// always the single, already-resolved string resolveQueuePlatform below produces — never a raw
// Player.platforms array.

// Investigated before designing #get-roles' platform self-service: a real player can genuinely
// have BOTH PC and Console history on the same account (plays console sometimes, PC other times),
// which a forced single either/or pick can't represent. This resolves Player.platforms (the
// self-service array — get-roles' select_platform handler, index.js) down to the single string
// every real consumer here still wants (getStatsForContext's platformSegment resolution above,
// queue.js's isCompatiblePlatform match gate, creative-queue.js's buildCreativePlayer) — CONTEXTUAL
// to the specific queue action, not a fixed identity:
//   - For a console-only tournament (tournamentConsoleOnly true): 'Console' if the player has
//     checked Console at all (regardless of whether they also have PC) — that's the whole point of
//     capturing it as an additive fact rather than a replace-one-with-the-other pick. null if they
//     haven't — genuinely not eligible, not a guess; callers (index.js) block the join up front with
//     a clear message rather than letting them queue into a pool that can never match them (the real
//     silent-stuck-forever bug this replaces — see queue.js's isCompatiblePlatform, which already
//     required platform === 'Console' for every member of a console-only match but had no real way
//     to ever be true, since nothing populated it before this).
//   - Otherwise: PC if they have it (their broad, cross-play-inclusive default — matches every
//     existing non-console-restricted tournament/creative behavior, unaffected by also having
//     Console), else Console if that's all they have (matches how a Console-only player's PR has
//     always needed the kbm-equivalent FT segment even for a non-console-restricted event — see
//     getStatsForContext's platformSegment formula above), else 'PC' as the ultimate default for a
//     player who hasn't set anything (same fallback every caller already used before self-service
//     existed).
function resolveQueuePlatform(platforms, tournamentConsoleOnly) {
  const list = platforms ?? [];
  const hasPC = list.includes('PC');
  const hasConsole = list.includes('Console');

  if (tournamentConsoleOnly) return hasConsole ? 'Console' : null;
  if (hasPC) return 'PC';
  if (hasConsole) return 'Console';
  return 'PC';
}
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

// Called by channel-manager.js when a tracked tournament's REAL scraped endTime passes (Epic's
// own eventWindow endTime — tournament-scraper.js's buildTournamentGroups — never a guessed/
// hardcoded schedule, so this self-corrects automatically across seasons as Epic's own calendar
// shifts). Same cheap, INSTANT-ONLY invalidation shape as rescrapeRegisteredPlayers above — clears
// lastUpdated via a plain Mongo update, never scrapes here, the actual re-scrape still only
// happens lazily on that player's next real queue action via getPlayerStats' existing cache-miss
// path. Two things narrow this beyond rescrapeRegisteredPlayers' plain region match:
//
//   1. SETTLED players (isSettled — no recorded activity in SETTLED_ACTIVITY_WINDOW_DAYS) are
//      left alone entirely. A tournament concluding in their home region says nothing about
//      someone who hasn't shown up to compete in 90+ days — invalidating them on every regional
//      conclusion would just reintroduce the wasted-rescrape churn the settled/long-TTL tier
//      exists to avoid; they stay on SETTLED_CACHE_TTL_MS's plain passive expiry instead.
//   2. Only players whose OWN cached snapshot predates eventEndTime get touched. A player who
//      already queued (and got a fresh scrape) after this exact tournament concluded already
//      reflects whatever it changed — nulling their cache again would force a pointless re-scrape
//      on their next queue for zero new signal. This is a real per-player comparison (their own
//      lastUpdated vs. this specific event's real conclusion), not a blind re-trigger every time
//      this function runs.
//
// Bounded by "registered players in one guild+region" (typically small — see getAllScoredPlayers'
// own doc comment on this bot's current scale), so fetching candidates into JS to apply isSettled
// (already the single source of truth that decision uses elsewhere) is cheap and keeps this in
// sync with that logic by construction, rather than re-deriving the same judgment in raw Mongo
// query syntax where it could quietly drift.
async function invalidateStaleAfterEvent(guildId, region, eventEndTime) {
  const cutoffMs = new Date(eventEndTime).getTime();
  if (!Number.isFinite(cutoffMs)) return;

  const candidates = await PlayerModel.find(
    { guildId, region, lastUpdated: { $ne: null } },
    { lastUpdated: 1, recentEvents: 1 }
  ).lean();

  const staleIds = candidates
    .filter(p => p.lastUpdated.getTime() < cutoffMs && !isSettled(p.recentEvents))
    .map(p => p._id);

  if (staleIds.length === 0) {
    console.log(`[stats] event-conclusion invalidation: no active player with a pre-event cache in guild=${guildId} region=${region}`);
    return;
  }

  await PlayerModel.updateMany({ _id: { $in: staleIds } }, { $set: { lastUpdated: null } });
  console.log(`[stats] event-conclusion invalidation — expired lastUpdated for ${staleIds.length} active player(s) in guild=${guildId} region=${region} (re-scraped lazily on their next queue, via getPlayerStats)`);
}

// Powers elo.js's percentile ranking — needs "every OTHER player with a real recorded score",
// not just one guild's registrants, so this is deliberately NOT guild-scoped (unlike every other
// function here). Deduped down to one entry per real account using the SAME freshest-by-
// lastUpdated rule findCanonicalByEpicUsername uses for a single lookup — without this, a player
// registered under N guilds (a normal, already-supported situation — see that function's doc
// comment) would occupy N slots in the comparison pool and skew everyone else's percentile.
// Projected to only the fields the score formula (and, since it's the same real deduped
// population, tier-comparison.js's daily band computation) actually needs, to keep the payload
// small. sessions included alongside totalPR/recentEvents for tier-comparison.js's PR-per-session
// efficiency factor — same HOME-context-only scope as totalPR/recentEvents here (not
// statsByContext), consistent with how this function has always sampled the population.
//
// Full, unindexed collection scan (totalPR has no index) — fine at this bot's current scale (at
// most a few thousand Player docs across all guilds combined). If the player base ever grows
// into the tens of thousands, or this endpoint's traffic grows enough that a full scan per
// request becomes hot, this should move to a precomputed/cached leaderboard rather than
// recomputing every score on every single ELO lookup.
async function getAllScoredPlayers() {
  const docs = await PlayerModel.find(
    { totalPR: { $ne: null } },
    { epicId: 1, totalPR: 1, thisSeasonPR: 1, recentEvents: 1, sessions: 1, lastUpdated: 1 }
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
    sessions: doc.sessions ?? null,
  }));
}

// Startup self-heal for the #get-roles bio/age-bracket removal — both features are gone
// entirely (embeds.js no longer builds their select/button, index.js no longer handles their
// interactions), but any player who used either one before removal still has the real value
// sitting on their Player document. Neither field was ever backed by a Discord role (bio came
// from a modal, ageBracket from a select menu with no assignRole call at all — confirmed via a
// real search before removing), so unlike guild-config.js's GUILD_CONFIG_MIGRATIONS (which fixes
// per-guild Discord objects — roles, channels — one guild at a time), this is a single global
// Mongo update across every Player document regardless of guild: there's no Discord-side state to
// reconcile, just stale data to clear. Called once at startup (index.js's clientReady handler,
// alongside repairComingSoonCreativeChannels — same "pure DB, no client/guild loop needed"
// shape). The filter means this is a cheap no-op on every startup after the first one actually
// finds something to clean up.
async function removeBioAndAgeBracketFields() {
  const result = await PlayerModel.updateMany(
    { $or: [{ bio: { $exists: true } }, { ageBracket: { $exists: true } }] },
    { $unset: { bio: '', ageBracket: '' } }
  );

  const matched = result.matchedCount ?? 0;
  if (matched === 0) {
    console.log('[players] bio/ageBracket cleanup: no player documents still had either field — nothing to do');
    return;
  }

  console.log(`[players] bio/ageBracket cleanup — removed the stale field(s) from ${matched} player document(s)`);
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
  resolveQueuePlatform,
  refreshPlayerStats,
  forceRefreshStats,
  rescrapeRegisteredPlayers,
  invalidateStaleAfterEvent,
  removeBioAndAgeBracketFields,
  findCanonicalByEpicUsername,
  searchEpicUsernames,
  getAllScoredPlayers,
  isSettled,
  SETTLED_CACHE_TTL_MS,
  SETTLED_ACTIVITY_WINDOW_DAYS,
};
