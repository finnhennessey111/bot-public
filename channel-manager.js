// channel-manager.js - Automated tournament channel creation and deletion

const { ThreadAutoArchiveDuration } = require('discord.js');
const { scrapeUpcomingTournaments, isBareBuildModeLabel, isRankedCupTitle } = require('./tournament-scraper');
const { savePinnedMessages } = require('./store');
const { buildTournamentEmbed, buildRankedCupTournamentEmbed, buildRankedCupQueueButtons, rankedCupPoolName, RANK_TIERS } = require('./embeds');
const { getQueueCount } = require('./queue');
const { getChannelId, getTagId } = require('./guild-config');
const playerStore = require('./players');
const tournamentApproval = require('./tournament-approval');
const { markSelfDeletion } = require('./self-deletion-tracker');
const DeletedTournamentChannelModel = require('./models/DeletedTournamentChannel');

const EMBED_REFRESH_INTERVAL_MS = 60 * 1000;

// How often startScheduler's tournament-check tick (runTournamentCheckTick) runs — see that
// setInterval call's own doc comment for why 4 hours (widened from 20 minutes) costs nothing real:
// every newly-detected tournament already sits behind tournament-approval.js's manual DM-approval
// gate, so scrape cadence was never what determined how fast a channel actually went live.
const TOURNAMENT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// How long after a tournament's last session begins its queue channel stays up before auto-deleting.
const CHANNEL_DELETE_BUFFER_MS = 2 * 60 * 60 * 1000;

const managedChannels = {};

// No whitelist here — tournament-scraper.js's BLOCKED_KEYWORDS (mobile, solo, FNCS Major) is the
// single source of truth for channel eligibility. Anything that survives that filter gets a
// channel, including skin/creator cups that don't follow a standard naming pattern (Mongraal Cup,
// Clix Cup, etc.) — a whitelist here used to silently drop those unless individually hardcoded.

const PER_DAY_KEYWORDS = ['fncs'];

// Node's setTimeout clamps/fires near-immediately past this delay (2^31-1 ms, ~24.8 days).
// Chain timers instead of ever exceeding it, so a bad/far-future date can't cause an early delete.
const MAX_TIMEOUT_MS = 2147483647;

function scheduleAfter(delayMs, callback) {
  if (delayMs > MAX_TIMEOUT_MS) {
    return setTimeout(() => scheduleAfter(delayMs - MAX_TIMEOUT_MS, callback), MAX_TIMEOUT_MS);
  }
  return setTimeout(callback, Math.max(delayMs, 0));
}

// Actually deletes a managed tournament channel and cleans up its tracking state — shared by
// armDeletionTimer's normal timer-fired path below and updateActiveTournamentEmbeds' safety-net
// path, which differ only in *when* they run (a scheduled timer vs. catching an already-overdue
// deleteAt synchronously during an embed-refresh pass) and how they log it, so a reader can tell
// from the logs alone which path actually deleted a given channel.
async function deleteManagedChannel(guild, channelId, pinned, pinnedMessages, viaSafetyNet = false) {
  const label = `${pinned.tournamentName} (${pinned.region})`;

  try {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel) {
      // Marked BEFORE the actual delete call — channel-deletion-undo.js's channelDelete listener
      // checks this to tell this expected, bot-initiated deletion apart from a mod manually
      // deleting the channel in Discord's UI, which is what that flow exists to catch. See
      // self-deletion-tracker.js's doc comment for why this (not a require cycle between this file
      // and that one) is the shared signal.
      markSelfDeletion(channelId);
      await channel.delete();
      console.log(viaSafetyNet
        ? `  🧹 Safety net: deleted overdue channel ${channel.name} (${label}) — no timer had been armed for it`
        : `🗑️ Deleted channel: ${channel.name}`);
    } else {
      console.log(viaSafetyNet
        ? `  🧹 Safety net: channel ${channelId} (${label}) already gone — nothing to delete`
        : `  ⏭️ Channel ${channelId} (${label}) already gone — nothing to delete`);
    }
  } catch (err) {
    // If this keeps failing (rather than the "channel already gone" case above), check the bot's
    // permissions in this guild — deleting a channel needs Manage Channels, and a guild where the
    // bot was only ever granted enough to create channels (not delete them) would fail here every
    // single time, which looks identical to "the channel is stuck" from the outside.
    console.error(`${viaSafetyNet ? 'Safety-net delete' : 'Failed to delete channel'} ${channelId} (${label}):`, err.message);
  } finally {
    delete managedChannels[channelId];
    delete pinnedMessages[channelId];
    savePinnedMessages(guild.id);
  }
}

// Arms (or re-arms) a channel's auto-deletion timer from a persisted deleteAt timestamp.
// Used both right after creating a channel and to recover timers that never got armed in this
// process — e.g. after a bot restart (managedChannels is in-memory only, unlike pinnedMessages),
// or for a legacy pinned entry that just had beginTime/deleteAt backfilled. Always fetches the
// channel at fire time rather than closing over a channel object, so a restart-recovered timer
// works identically to a freshly-armed one.
function armDeletionTimer(guild, channelId, pinned, pinnedMessages) {
  const msUntilDelete = pinned.deleteAt - Date.now();
  const label = `${pinned.tournamentName} (${pinned.region})`;

  const timer = scheduleAfter(msUntilDelete, () => deleteManagedChannel(guild, channelId, pinned, pinnedMessages, false));

  managedChannels[channelId] = { tournamentName: pinned.tournamentName, region: pinned.region, beginTime: pinned.beginTime, deleteTimer: timer };
  const hrsUntil = (Math.max(msUntilDelete, 0) / 3600000).toFixed(1);
  console.log(`  ⏲️ Armed deletion timer for ${channelId} (${label}) — fires in ${hrsUntil}hrs${msUntilDelete <= 0 ? ' (overdue, deleting now)' : ''}`);
}

// Discord channel names need to stay short — abbreviate the common build-mode words wherever they
// appear in a tournament's name, AND move the abbreviation to the front (e.g. "ZB Typical Gamer
// Icon Cup", not "Typical Gamer Icon Cup ZB") so it reads as a mode tag rather than getting cut off
// by (or pushing something else out of) the 40-char slice below. Only affects the generated
// channel-name string, not the tournament's display name used elsewhere (embed title, pinned
// message).
function abbreviateBuildMode(name) {
  const match = name.match(/\(?\s*\b(battle royale|zero build)\b\s*\)?/i);
  if (!match) return name;

  const tag = /zero build/i.test(match[1]) ? 'ZB' : 'BR';
  const withoutTag = (name.slice(0, match.index) + name.slice(match.index + match[0].length))
    .replace(/\s{2,}/g, ' ')
    .trim();

  return `${tag} ${withoutTag}`.trim();
}

function buildChannelName(tournamentName, dateStr = null) {
  const cleanName = abbreviateBuildMode(tournamentName)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);

  if (dateStr) return `${cleanName}-${dateStr}`;
  return cleanName;
}

function getDateStr(isoString) {
  const date = new Date(isoString);
  const month = date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }).toLowerCase();
  const day = date.getUTCDate();
  return `${month}-${day}`;
}

function isPerDayTournament(name) {
  return PER_DAY_KEYWORDS.some(k => name.toLowerCase().includes(k));
}

// Permanent tournament channels are never recreated or deleted, so their stored beginTime would
// otherwise freeze at creation time — called every daily tick (even when createTournamentChannel
// is otherwise a no-op because the channel already exists) so the embed's "Next event" countdown
// (buildTournamentEmbed's isPermanent branch) stays accurate as occurrences pass, using the
// latest scrape's earliest-future-occurrence beginTime for this tournament+region.
function refreshPermanentBeginTime(channelId, latestBeginTime, pinnedMessages, guildId) {
  const pinned = pinnedMessages[channelId];
  if (!pinned || pinned.beginTime === latestBeginTime) return;
  pinned.beginTime = latestBeginTime;
  savePinnedMessages(guildId);
  console.log(`  🔄 Refreshed next-event beginTime for permanent channel ${channelId} (${pinned.tournamentName}): ${latestBeginTime}`);
}

// Finds an already-existing channel for this exact tournament, preferring tournament-scraper.js's
// stable eventId (Fortnite Tracker's own event identifier — see buildTournamentGroups' comment)
// over the channel's literal current name. This is what lets a naming-logic change (e.g. today's
// BR/ZB prefix format, or any future one) rename an existing channel in place instead of creating
// a second, orphaned one for the same real tournament — every previous naming fix this bot has
// shipped left its old, now-incorrectly-named channels sitting as duplicates until their own
// deletion timer eventually cleared them, across every server, each time.
//
// Falls back to a name+forum+tag match when there's no eventId (a raw session that somehow
// arrived without one) or no pinnedMessages entry matches it yet (e.g. a post that predates this
// field) — so a genuinely untracked-but-correctly-named post still isn't duplicated either.
//
// Region used to disambiguate same-named tournaments in different regions via category membership
// (parentId) alone, since each region had its own category. One shared forum now holds every
// region's posts, so parentId alone would incorrectly treat "ZB Mongraal Cup" in EU and in NAC as
// the same post — appliedTags (the region tag) is what actually disambiguates them now; parentId
// is kept alongside it purely to scope the search to this guild's own tournament forum. A pre-
// migration plain-text channel (legacy, still tracked via its own pinnedMessages entry) has no
// appliedTags at all, so it naturally never matches here — it's still found via the eventId path
// above regardless of its channel type.
async function findExistingTournamentChannel(guild, pinnedMessages, tournament, forumChannelId, regionTagId, channelName) {
  if (tournament.eventId) {
    const match = Object.entries(pinnedMessages).find(
      ([, pinned]) => pinned.guildId === guild.id && pinned.tournamentEventId === tournament.eventId
    );
    if (match) {
      const [channelId, pinnedEntry] = match;
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel) return { channel, pinnedEntry, matchedBy: 'eventId' };
      // Pinned entry points at a channel that's gone (deleted, naturally or otherwise) — fall
      // through to the name-based check below rather than treating this as a live match.
    }
  }

  const existing = guild.channels.cache.find(c =>
    c.name === channelName
    && c.parentId === (forumChannelId ?? null)
    && (!regionTagId || c.appliedTags?.includes(regionTagId))
  );
  if (existing) return { channel: existing, pinnedEntry: pinnedMessages[existing.id] ?? null, matchedBy: 'name' };

  return null;
}

function computeRankCounts(guildId, tournamentName, region) {
  const counts = {};
  for (const tier of RANK_TIERS) {
    counts[tier.key] = getQueueCount(guildId, rankedCupPoolName(tournamentName, tier.key), region);
  }
  return counts;
}

async function createTournamentChannel(guild, tournament, pinnedMessages) {
  const { name, region, beginTime, lastBeginTime, isTrios, consoleOnly, isPermanent, isRankedCup } = tournament;

  // Last-resort guard: tournament-scraper.js's buildTournamentGroups already drops sessions whose
  // title is nothing but a build-mode label (see isBareBuildModeLabel there) before they ever
  // become a `tournament` object, but this is the last point before a channel actually gets
  // created — if some future scrape source ever bypasses that filter, refuse here too rather than
  // shipping a channel literally named "battle-royale"/"zero-build" with no way for players to
  // tell which tournament it's for. A build-mode tag alone is never a valid channel name.
  if (isBareBuildModeLabel(name.toLowerCase())) {
    console.error(`  ❌ Refused to create channel — tournament name is just a build-mode label with no tournament name at all ("${name}")`);
    return;
  }

  // A mod deleted this exact tournament's channel in this exact guild before, and that deletion is
  // either still within its 24h confirmation window (channel-deletion-undo.js) or was confirmed
  // permanent — either way, recreating it here would defeat the whole point of asking. Scoped to
  // (guild.id, eventId), not eventId alone: the same real tournament's channel in a DIFFERENT guild
  // is unaffected (see models/DeletedTournamentChannel.js's doc comment). A 'restored' record (or
  // no record at all) falls through to normal creation — restoring flips status to 'restored'
  // *before* calling back into this same function to recreate the channel, so that path isn't
  // blocked by its own gate.
  if (tournament.eventId) {
    const deletionRecord = await DeletedTournamentChannelModel.findOne({ guildId: guild.id, eventId: tournament.eventId }).lean();
    if (deletionRecord && deletionRecord.status !== 'restored') {
      const reason = deletionRecord.status === 'permanently_deleted'
        ? 'was permanently deleted here'
        : 'is awaiting restore-window confirmation';
      console.log(`  🚫 Skipped — "${name}" (${region}) ${reason} in this server (eventId ${tournament.eventId})`);
      return;
    }
  }

  // Permanent tournaments (FNCS Divisional Cups) must never get a date-suffixed name — 'fncs'
  // also matches PER_DAY_KEYWORDS, but a date suffix keyed off *this* week's beginTime would give
  // next week's occurrence a different channel name, which the dedupe check below (exact name
  // match) wouldn't recognize as the same tournament — producing a brand new channel every week
  // instead of the single always-open one this is supposed to be.
  const perDay = !isPermanent && isPerDayTournament(name);
  const dateStr = perDay ? getDateStr(beginTime) : null;
  const channelName = buildChannelName(name, dateStr);

  console.log(`  🔧 createTournamentChannel("${name}", ${region}) → post title "${channelName}"`);

  // Region is no longer baked into the name (one shared forum holds every region's posts,
  // disambiguated by tag instead — see findExistingTournamentChannel's own doc comment), so the
  // same tournament in a different region produces an identical title.
  const forumChannelId = getChannelId(guild.id, 'tournamentForum');
  const regionTagId = getTagId(guild.id, region);
  const found = await findExistingTournamentChannel(guild, pinnedMessages, tournament, forumChannelId, regionTagId, channelName);
  if (found) {
    const { channel: existing, pinnedEntry, matchedBy } = found;

    if (matchedBy === 'eventId' && existing.name !== channelName) {
      // Same real tournament (Fortnite Tracker's own event identifier matched), but naming logic
      // has changed since this channel was created — rename in place rather than leaving the old
      // name to sit as an orphaned duplicate once a second, correctly-named channel would
      // otherwise get created here. Captured before setName — Discord.js mutates the channel
      // object's own .name in place once the rename resolves, so reading it only afterward would
      // always log the new name on both sides of the arrow.
      const previousName = existing.name;
      try {
        await existing.setName(channelName);
        console.log(`  ✏️ Renamed channel ${existing.id} "${previousName}" → "${channelName}" (same tournament, eventId ${tournament.eventId} — naming logic changed)`);
      } catch (err) {
        console.error(`  ❌ Failed to rename channel ${existing.id} to "${channelName}":`, err.message);
      }
      if (pinnedEntry) {
        pinnedEntry.tournamentName = name;
        savePinnedMessages(guild.id);
      }
    } else {
      console.log(`  ⏭️ Skipped — channel already exists (matched by ${matchedBy}): ${existing.name}`);
    }

    // Backfills consoleOnly on every tick (not just at creation) for a channel this process
    // already knows about — self-heals any pinnedMessages entry written before this field
    // existed, same as this tournament's own scraped value, every single check. Cheap (a plain
    // property compare) since createTournamentChannel already re-derives this tournament's
    // current consoleOnly from tournament-scraper.js on every scheduler tick regardless.
    if (pinnedEntry && pinnedEntry.consoleOnly !== !!consoleOnly) {
      pinnedEntry.consoleOnly = !!consoleOnly;
      savePinnedMessages(guild.id);
      console.log(`  🩹 Backfilled consoleOnly=${!!consoleOnly} for existing channel ${existing.id} (${name})`);
    }

    if (isPermanent) refreshPermanentBeginTime(existing.id, beginTime, pinnedMessages, guild.id);
    return;
  }

  // No mobile/solo/FNCS-Major re-check here — tournament-scraper.js's BLOCKED_KEYWORDS already
  // filtered those out before this tournament ever reached us.

  if (!forumChannelId) {
    console.error(`  ❌ No tournament forum configured for this guild — run /matchmaker-setup (or wait for the next startup self-heal) before tournament posts can be created`);
    return;
  }
  const forum = await guild.channels.fetch(forumChannelId).catch(() => null);
  if (!forum) {
    console.error(`  ❌ Configured tournament forum ${forumChannelId} no longer exists for this guild`);
    return;
  }
  if (!regionTagId) {
    console.log(`  ⚠️ No ${region} tag configured for this guild — post will be created untagged`);
  }

  // Visibility/attachment-lock permissions are NOT set per-post here — a forum THREAD can't hold
  // its own overwrites independent of its parent forum channel (confirmed via discord.js source:
  // ThreadChannel has no .permissionOverwrites at all, and GuildForumThreadManager#create's
  // options don't accept any). The forum CHANNEL's own overwrites (matchmaker-setup.js's
  // ensureTournamentForum + permissions.js's enforcePermissions) are what every post inherits —
  // same @everyone-ViewChannel-allow/AttachFiles-EmbedLinks-deny + mod-role-allow rule as before,
  // just applied once at the forum level instead of once per post.

  try {
    console.log(`  🚀 Calling forum.threads.create("${channelName}")...`);

    // Permanent tournaments never get a deleteAt at all — never scheduled for deletion, by
    // design (see the class-level comment on PERMANENT_KEYWORDS in tournament-scraper.js).
    const deleteAfter = isPermanent ? null : new Date(lastBeginTime).getTime() + CHANNEL_DELETE_BUFFER_MS;

    const { buildQueueButtons, buildRankedCupQueueButtons } = require('./embeds');
    const embed = isRankedCup
      ? buildRankedCupTournamentEmbed(name, region, computeRankCounts(guild.id, name, region), isTrios, beginTime, deleteAfter, isPermanent, tournament.eventId ?? null)
      : buildTournamentEmbed(name, region, 0, isTrios, beginTime, deleteAfter, isPermanent, tournament.eventId ?? null);
    const components = isRankedCup ? buildRankedCupQueueButtons(isTrios) : [buildQueueButtons(isTrios)];

    const thread = await forum.threads.create({
      name: channelName,
      message: { embeds: [embed], components },
      appliedTags: regionTagId ? [regionTagId] : [],
      // Max available (1 week) — not enough on its own for a genuinely permanent post (FNCS
      // Divisionals can go quiet longer than that with no new messages, and editing the starter
      // message — which the periodic refresh does — does NOT reset this timer, only a new message
      // does), so updateActiveTournamentEmbeds below proactively un-archives permanent tournament
      // threads every refresh tick as the real fix. This just keeps every OTHER (much shorter-
      // lived, days-not-weeks) post from ever archiving during its normal lifetime at all.
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    });

    console.log(`✅ Created forum post: ${channelName} (id: ${thread.id})`);

    pinnedMessages[thread.id] = {
      // A forum post's starter message shares the thread's own ID (confirmed via discord.js's
      // ThreadChannel#fetchStarterMessage source, which fetches `{message: this.id}`) — no
      // separate message-creation/fetch/pin step needed the way a normal channel required.
      messageId: thread.id,
      guildId: guild.id,
      tournamentName: name,
      tournamentEventId: tournament.eventId ?? null,
      region,
      isTrios,
      // See tournament-scraper.js's isRankedCupTitle — Ranked Cups get one queue button/pool per
      // in-game rank tier (embeds.js's buildRankedCupQueueButtons/buildRankedCupTournamentEmbed)
      // instead of the single generic one. index.js's queue_rank_ handler and
      // updateActiveTournamentEmbeds below both branch on this.
      isRankedCup: !!isRankedCup,
      // Real, scraped platform-eligibility data (tournament-scraper.js: platforms.length === 1 &&
      // platforms[0] === 'Console') — NOT a Discord-role gate (that was removed separately, see
      // index.js's queue_duo/lf2 handler). This is what queue.js's isCompatiblePlatform reads to
      // require every matched member be on Console for a genuinely console-only tournament.
      consoleOnly: !!consoleOnly,
      beginTime,
      deleteAt: deleteAfter,
      permanent: !!isPermanent,
    };
    savePinnedMessages(guild.id);

    if (isPermanent) {
      console.log(`  ♾️ Permanent tournament — no deletion timer armed for ${thread.id}`);
    } else {
      armDeletionTimer(guild, thread.id, { tournamentName: name, region, beginTime, deleteAt: deleteAfter }, pinnedMessages);
    }

  } catch (err) {
    console.error(`  ❌ Failed to create forum post ${channelName}:`, err.message);
  }
}

// tournaments is a single scrape's worth of data, shared across every guild this tick — see
// tournament-scraper.js's scrapeUpcomingTournaments doc comment and runTournamentCheckTick below.
// This function must never call scrapeUpcomingTournaments() itself.
async function checkAndCreateChannels(guild, tournaments, pinnedMessages) {
  console.log('🔍 Checking for upcoming tournaments...');

  try {
    console.log(`📋 Checking ${tournaments.length} tournaments`);

    const now = new Date();
    console.log(`🕐 Current time: ${now.toISOString()}`);

    for (const tournament of tournaments) {
      const startDate = new Date(tournament.beginTime);
      const hoursUntilStart = (startDate.getTime() - now.getTime()) / (1000 * 60 * 60);

      console.log(`→ ${tournament.name} | ${tournament.region} | begins ${tournament.beginTime} | ${hoursUntilStart.toFixed(1)}hrs away${tournament.isPermanent ? ' | PERMANENT' : ''}`);

      // Permanent tournaments (FNCS Divisional Cups) skip the 48h window entirely — the channel
      // should exist as soon as the division is known about and stay open regardless of any one
      // occurrence's timing, not just within 48h of the next session. createTournamentChannel's
      // own dedupe check (by stable channel name) makes this idempotent, so re-running this every
      // hour just confirms the channel still exists rather than recreating it.
      if (!tournament.isPermanent) {
        if (hoursUntilStart <= 0) {
          console.log(`  ⏭️ Skipped — already started/in the past`);
          continue;
        }

        if (hoursUntilStart > 48) {
          console.log(`  ⏭️ Skipped — outside 48h window (enters window in ${(hoursUntilStart - 48).toFixed(1)}hrs)`);
          continue;
        }

        console.log(`  ✅ Within 48h window — attempting channel creation`);
      } else {
        console.log(`  ♾️ Permanent tournament — skipping 48h window check, ensuring channel exists`);
      }

      // Only genuinely multi-session tournaments (e.g. FNCS) should keep their channel open
      // until the last session. Everything else groups all future occurrences of the same
      // recurring cup under one scraped entry, so lastBeginTime can be weeks/months out —
      // use this occurrence's own beginTime instead.
      await createTournamentChannel(guild, shapeForCreation(tournament), pinnedMessages);
    }

    console.log('✅ Tournament check complete');

  } catch (err) {
    console.error('Failed to check tournaments:', err.message);
  }
}

// Only genuinely multi-session tournaments (e.g. FNCS) should keep their channel open until the
// last session. Everything else groups all future occurrences of the same recurring cup under one
// scraped entry, so lastBeginTime can be weeks/months out — use this occurrence's own beginTime
// instead. Shared by checkAndCreateChannels' per-guild loop above and
// createTournamentChannelsAcrossGuilds below (the tournament-approval.js approve path), so an
// approved tournament gets created with exactly the same deletion timing a normal same-tick
// creation would have gotten.
function shapeForCreation(tournament) {
  return {
    ...tournament,
    lastBeginTime: tournament.isMultiSession ? tournament.lastBeginTime : tournament.beginTime,
  };
}

// Called once by index.js's tournament_approve_ button handler after tournament-approval.js
// settles a record as 'approved' — creates the channel in EVERY guild the bot is currently in,
// mirroring what a normal scheduled tick would have done had this tournament been pre-approved
// (or not gated at all). Errors in one guild are logged and don't stop the rest — same
// per-guild-isolation precedent as forEachGuild below.
async function createTournamentChannelsAcrossGuilds(client, tournament, pinnedMessages) {
  const shaped = shapeForCreation(tournament);
  for (const guild of client.guilds.cache.values()) {
    await createTournamentChannel(guild, shaped, pinnedMessages)
      .catch(err => console.error(`[tournament-approval] Failed to create channel in guild ${guild.id} for ${tournament.eventId}:`, err.message));
  }
}

// Refreshes the pinned embed for every tournament channel that has a known beginTime, so the
// countdown/elapsed/ending-soon status and left-border color stay live between player actions.
// backfillTournaments is a single scrape's worth of data shared across every guild this tick (null
// if no guild needed one this tick) — see runEmbedRefreshTick below. This function must never call
// scrapeUpcomingTournaments() itself.
async function updateActiveTournamentEmbeds(guild, pinnedMessages, backfillTournaments = null) {
  const entries = Object.entries(pinnedMessages).filter(([, pinned]) => pinned.guildId === guild.id);
  console.log(`🔄 Refreshing tournament embeds — ${entries.length} pinned channel(s) tracked`);

  // Legacy/manually-created entries can be missing beginTime (e.g. pinned before this field
  // existed, or created via /setup-tournament with no known schedule) and/or missing deleteAt
  // (e.g. pinned before that field existed, or a beginTime-only backfill from before this
  // check covered deleteAt too) — either gap means no deletion timer ever gets armed for that
  // channel, on any restart, ever, which is how channels ended up stuck open forever. Permanent
  // tournaments are exempt — they deliberately have no deleteAt (see PERMANENT_KEYWORDS in
  // tournament-scraper.js) and must never have one backfilled in.
  const needsBackfill = entries.filter(
    ([, pinned]) => !pinned.permanent && (!pinned.beginTime || !pinned.deleteAt) && !pinned.beginTimeBackfillAttempted
  );
  if (needsBackfill.length > 0) {
    const stillMissingBeginTime = needsBackfill.filter(([, pinned]) => !pinned.beginTime);

    // Only entries missing beginTime actually need this tick's scrape (to look up a match by
    // name+region) — an entry that already has beginTime but is just missing deleteAt can
    // compute it directly below, no scrape required, so it's never held up by one failing/not
    // having run this tick.
    if (stillMissingBeginTime.length > 0 && !backfillTournaments) {
      console.log(`  ⏭️ ${stillMissingBeginTime.length} pinned channel(s) missing beginTime, but no scrape was fetched this tick (or it failed) — will retry next tick`);
    } else {
      console.log(`  🔍 ${needsBackfill.length} pinned channel(s) missing beginTime and/or deleteAt — backfilling`);
      const byKey = backfillTournaments ? new Map(backfillTournaments.map(t => [`${t.name}-${t.region}`, t])) : null;

      for (const [channelId, pinned] of needsBackfill) {
        const match = byKey?.get(`${pinned.tournamentName}-${pinned.region}`);

        if (!pinned.beginTime) {
          if (!match) {
            pinned.beginTimeBackfillAttempted = true;
            console.log(`  ⚠️ No match in current scrape for ${channelId} (${pinned.tournamentName}, ${pinned.region}) — leaving timer-less`);
            continue;
          }
          pinned.beginTime = match.beginTime;
        }

        // deleteAt is directly derivable from beginTime — prefer the scrape match's
        // lastBeginTime (accurate for multi-session tournaments like FNCS), but fall back to
        // this entry's own stored beginTime if there's no match (e.g. it's aged out of the
        // scrape's forward-looking window), so a stuck channel still gets *a* deletion timer
        // instead of none at all.
        const effectiveLastBeginTime = match ? (match.isMultiSession ? match.lastBeginTime : match.beginTime) : pinned.beginTime;
        pinned.deleteAt = new Date(effectiveLastBeginTime).getTime() + CHANNEL_DELETE_BUFFER_MS;
        pinned.beginTimeBackfillAttempted = true;
        console.log(`  🩹 Backfilled ${channelId} (${pinned.tournamentName}, ${pinned.region}) — beginTime=${pinned.beginTime}, deleteAt=${new Date(pinned.deleteAt).toISOString()}${match ? '' : ' (no scrape match — derived from stored beginTime)'}`);
      }
      savePinnedMessages(guild.id);
    }
  }

  for (const [channelId, pinned] of entries) {
    // managedChannels is in-memory only — a bot restart wipes it even though pinnedMessages
    // (and its deleteAt) survives in data.json. Re-arm anything with a known deleteAt but no
    // timer in this process, whether that's restart recovery or an entry that was just
    // backfilled above — UNLESS deleteAt has already passed, in which case don't wait on a new
    // timer's near-zero delay: delete it right here, synchronously, in this pass. This safety net
    // is what actually closes the stuck-channel gap — those channels' deleteAt was simply never
    // set (see the backfill above), so armDeletionTimer never got a chance to run at all, on any
    // restart, ever.
    if (pinned.deleteAt && !managedChannels[channelId]) {
      if (pinned.deleteAt <= Date.now()) {
        console.log(`  🧹 Safety net: ${channelId} (${pinned.tournamentName}) is past its deleteAt (${new Date(pinned.deleteAt).toISOString()}) with no timer armed — deleting now instead of waiting on a new one`);
        await deleteManagedChannel(guild, channelId, pinned, pinnedMessages, true);
        continue;
      }
      console.log(`  🔁 No deletion timer armed for ${channelId} (${pinned.tournamentName}) — arming now`);
      armDeletionTimer(guild, channelId, pinned, pinnedMessages);
    }

    if (!pinned.permanent && !pinned.beginTime) {
      console.log(`  ⏭️ ${channelId} (${pinned.tournamentName ?? 'unknown'}) — no beginTime stored, countdown can't be rendered`);
      continue;
    }

    // Tournament just moved from upcoming to past (beginTime has elapsed) — expire every
    // registered player's cached stats in this region (no scraping here, see players.js's
    // rescrapeRegisteredPlayers) so their cached stats pick up the event that just happened the
    // next time they actually queue, rather than each of them individually waiting out the 24h
    // queue-join cache. statsRescraped is set synchronously (before the invalidation resolves) so
    // an overlapping tick within the same ~60s window can't fire it twice. Doesn't apply to
    // permanent tournaments — there's no single "this tournament just began" moment for something
    // that's always open.
    if (!pinned.permanent && !pinned.statsRescraped && new Date(pinned.beginTime).getTime() <= Date.now()) {
      pinned.statsRescraped = true;
      savePinnedMessages(guild.id);
      console.log(`  🔄 ${channelId} (${pinned.tournamentName}, ${pinned.region}) — tournament has begun, expiring cached stats for registered players in this region`);
      playerStore.rescrapeRegisteredPlayers(guild.id, pinned.region)
        .catch(err => console.error(`  ❌ Cache invalidation failed for ${pinned.tournamentName} (${pinned.region}):`, err.message));
    }

    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        console.log(`  ⏭️ ${channelId} (${pinned.tournamentName}) — channel no longer exists, skipping`);
        continue;
      }

      // CRITICAL for permanent tournaments: a forum thread auto-archives after inactivity (max 1
      // week — see createTournamentChannel's autoArchiveDuration comment), and editing the starter
      // message below does NOT reset that timer, only a genuinely new message does. A permanent
      // tournament (never deleted, could plausibly go quiet for over a week between real events)
      // would otherwise silently auto-archive with nothing to ever un-stick it. This tick runs
      // every EMBED_REFRESH_INTERVAL_MS (60s), so proactively un-archiving here means the worst
      // case is well under a minute of being archived before this self-heals — not "forever."
      // channel.archived is undefined (falsy) on a pre-migration plain-text channel, so this is a
      // natural no-op for those.
      if (pinned.permanent && channel.archived) {
        try {
          await channel.setArchived(false);
          console.log(`  🔓 Un-archived permanent tournament thread ${channelId} (${pinned.tournamentName}) — had auto-archived from inactivity`);
        } catch (err) {
          console.error(`  ❌ Failed to un-archive permanent tournament thread ${channelId} (${pinned.tournamentName}):`, err.message);
        }
      }

      const msg = await channel.messages.fetch(pinned.messageId);

      // isRankedCup used to only ever be set at fresh-creation time and never revisited — a
      // pre-existing entry whose title genuinely IS a Ranked Cup (isRankedCupTitle re-checked
      // fresh here, not trusted from the stored flag) but was created before detection covered it
      // correctly (or via /setup-tournament, which didn't check at all) would keep its old plain
      // embed/generic button forever. This upgrades it in place — but ONLY once it's actually safe
      // to swap the buttons.
      //
      // Why "safe" matters: the generic queue_duo/queue_lf2 button is about to be replaced by
      // per-rank ones. Anyone who already joined via that OLD button is sitting in a pool keyed by
      // the plain tournament name (queue.js's queues[tournamentName][region]) — a genuinely
      // DIFFERENT pool from any rank-scoped one (embeds.js's rankedCupPoolName). If the buttons
      // vanish out from under them: (a) queue.js's sweepAllQueues would keep matching them against
      // whoever else is stuck in that same orphaned pool regardless of rank — defeating the whole
      // point of a Ranked Cup — and (b) they'd have NO way to leave that queue at all — the
      // leave-queue flow only ever reappears by re-clicking the exact button they queued with
      // (index.js's queue_duo/queue_rank_ handlers), which is gone, and there's no separate
      // /leave-queue command. So the upgrade is deferred (not skipped — re-checked every tick)
      // until that legacy pool is genuinely empty; anyone still in it keeps using the old generic
      // button exactly as before in the meantime, completely unaffected. Worst case, the channel
      // just reaches its normal 2h-post-begin delete+recreate first, which already fixes this the
      // slow way.
      const actuallyRankedCup = isRankedCupTitle(pinned.tournamentName.toLowerCase());
      const needsRankedCupUpgrade = actuallyRankedCup && !pinned.isRankedCup;
      let upgradeSafe = false;

      if (needsRankedCupUpgrade) {
        const legacyPoolCount = getQueueCount(guild.id, pinned.tournamentName, pinned.region);
        if (legacyPoolCount === 0) {
          upgradeSafe = true;
        } else {
          console.log(`  ⏳ ${channelId} (${pinned.tournamentName}) — should be a Ranked Cup but ${legacyPoolCount} player(s) are still queued in the legacy (pre-upgrade) pool; deferring the per-rank button upgrade until it's empty`);
        }
      }

      const effectiveIsRankedCup = pinned.isRankedCup || upgradeSafe;
      const newEmbed = effectiveIsRankedCup
        ? buildRankedCupTournamentEmbed(
            pinned.tournamentName, pinned.region, computeRankCounts(guild.id, pinned.tournamentName, pinned.region), pinned.isTrios,
            pinned.beginTime, pinned.deleteAt, pinned.permanent, pinned.tournamentEventId ?? null
          )
        : buildTournamentEmbed(
            pinned.tournamentName, pinned.region, getQueueCount(guild.id, pinned.tournamentName, pinned.region), pinned.isTrios,
            pinned.beginTime, pinned.deleteAt, pinned.permanent, pinned.tournamentEventId ?? null
          );
      const newComponents = upgradeSafe ? buildRankedCupQueueButtons(pinned.isTrios) : msg.components;

      await msg.edit({ embeds: [newEmbed], components: newComponents });

      // Only persisted AFTER a successful edit — if msg.edit throws (caught below), nothing is
      // saved, so the next tick retries the whole upgrade from scratch instead of leaving
      // pinned.isRankedCup=true persisted while the actual message still has its old generic
      // button (a half-upgraded state this design specifically avoids).
      if (upgradeSafe) {
        pinned.isRankedCup = true;
        savePinnedMessages(guild.id);
        console.log(`  ⬆️ ${channelId} (${pinned.tournamentName}) — upgraded to per-rank Ranked Cup queues (legacy pool was empty)`);
      }

      console.log(`  ✅ ${channelId} (${pinned.tournamentName}) — embed refreshed`);
    } catch (err) {
      console.error(`  ❌ Failed to refresh tournament embed for channel ${channelId}:`, err.message);
    }
  }
}

// Runs a per-guild scheduler action against every guild the bot is currently in — a fresh
// snapshot of client.guilds.cache on each call, so a guild joined/left between ticks is picked
// up automatically without restarting the scheduler.
async function forEachGuild(client, action) {
  for (const guild of client.guilds.cache.values()) {
    await action(guild).catch(err => console.error(`Scheduler action failed for guild ${guild.id}:`, err.message));
  }
}

// Scrapes exactly once (never per-guild — see tournament-scraper.js's doc comment on
// scrapeUpcomingTournaments), gates the result through tournament-approval.js's manual-approval
// check ONCE (before the per-guild loop — critical, since gating per-guild would DM the owner once
// per server for the same brand-new tournament and race duplicate 'pending' records against each
// other), then fans only the already-approved tournaments out to every guild's
// checkAndCreateChannels call. This is what keeps each tick at O(1) Puppeteer navigations
// regardless of guild count, instead of the O(guilds) it used to be.
async function runTournamentCheckTick(client, pinnedMessages) {
  let tournaments;
  try {
    tournaments = await scrapeUpcomingTournaments();
  } catch (err) {
    console.error('Failed to scrape tournaments for this check:', err.message);
    return;
  }

  const approvedTournaments = await tournamentApproval.gateTournaments(client, tournaments, pinnedMessages);
  await forEachGuild(client, guild => checkAndCreateChannels(guild, approvedTournaments, pinnedMessages));

  await tournamentApproval.expirePendingApprovals(client).catch(err => console.error('[tournament-approval] Failed to sweep expired approvals:', err.message));
}

// Scrapes at most once per tick, and only if at least one guild actually has a pinned entry
// needing beginTime backfill (checked across the whole global pinnedMessages, not per guild) —
// so N guilds all needing backfill in the same tick still costs one scrape, not N. A
// deleteAt-only backfill doesn't need a scrape at all (updateActiveTournamentEmbeds derives it
// straight from the entry's own beginTime), so it isn't part of this gate. Permanent entries
// never need one either — they deliberately have no beginTime/deleteAt to backfill.
async function runEmbedRefreshTick(client, pinnedMessages) {
  const anyNeedsBackfill = Object.values(pinnedMessages).some(
    pinned => !pinned.permanent && !pinned.beginTime && !pinned.beginTimeBackfillAttempted
  );

  let backfillTournaments = null;
  if (anyNeedsBackfill) {
    console.log('  🔍 At least one pinned channel is missing beginTime — fetching one shared scrape for backfill this tick');
    try {
      backfillTournaments = await scrapeUpcomingTournaments();
    } catch (err) {
      console.error('  ❌ Backfill scrape failed:', err.message);
    }
  }

  await forEachGuild(client, guild => updateActiveTournamentEmbeds(guild, pinnedMessages, backfillTournaments));
}

function startScheduler(client, pinnedMessages) {
  // Runs immediately on every startup (not just at the next scheduled tick) so a tournament that
  // entered the 48h window while the bot was offline gets its channel created right away.
  console.log('📅 Running initial tournament check on startup...');
  runTournamentCheckTick(client, pinnedMessages);
  // Also run immediately (not just on the 60s interval below) so deletion timers lost to a
  // restart — managedChannels is in-memory only — get re-armed right away instead of after
  // up to a minute's delay.
  runEmbedRefreshTick(client, pinnedMessages);

  // Every 4 hours (widened from 20 minutes) — detection speed was never actually the bottleneck
  // for real-world responsiveness: every newly-detected tournament already sits behind
  // tournament-approval.js's manual DM-approval gate before it goes live anywhere, so a channel
  // never appears faster than the owner actually approves it regardless of how often this tick
  // runs. Checking every 20 minutes only paid off if approvals themselves happened within minutes
  // of detection — in practice approval turnaround, not scrape cadence, is what determines how
  // fast a channel actually shows up. 4 hours costs nothing real while cutting this category of
  // scraping traffic (a full Puppeteer navigation via scrapeUpcomingTournaments) roughly 12x
  // compared to the old 20-min cadence. (The earlier once-a-day/Cloudflare-IP-block concern this
  // interval used to be tuned around no longer applies either — a working residential proxy is in
  // place, see proxy-config.js.) This log fires unconditionally on every tick (independent of
  // whether checkAndCreateChannels itself finds anything to do) so a live deployment's logs make
  // it obvious the interval is still alive, rather than only ever seeing evidence when a channel
  // actually gets created.
  setInterval(async () => {
    const now = new Date();
    console.log(`⏰ Scheduler tick fired — UTC hour ${now.getUTCHours()} (${now.toISOString()}) — running tournament check`);
    await runTournamentCheckTick(client, pinnedMessages);
  }, TOURNAMENT_CHECK_INTERVAL_MS);

  setInterval(() => {
    runEmbedRefreshTick(client, pinnedMessages).catch(console.error);
  }, EMBED_REFRESH_INTERVAL_MS);

  console.log('📅 Tournament scheduler started — 4hr tournament check + 60s embed refresh armed');
}

module.exports = {
  startScheduler, checkAndCreateChannels, managedChannels, buildChannelName, abbreviateBuildMode,
  createTournamentChannel, createTournamentChannelsAcrossGuilds, CHANNEL_DELETE_BUFFER_MS,
  updateActiveTournamentEmbeds, TOURNAMENT_CHECK_INTERVAL_MS,
  // Exported for testability (same precedent as buildChannelName/abbreviateBuildMode above) — the
  // forum-post migration's #5 item specifically asked to verify this deletion path works with
  // ThreadChannel.delete() the same way it always did with a normal channel's.
  deleteManagedChannel,
};