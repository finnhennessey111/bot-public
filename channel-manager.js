// channel-manager.js - Automated tournament channel creation and deletion

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { scrapeUpcomingTournaments, isBareBuildModeLabel } = require('./tournament-scraper');
const { save: saveStore } = require('./store');
const { buildTournamentEmbed } = require('./embeds');
const { getQueueCount } = require('./queue');
const { getRoleId, getCategoryId } = require('./guild-config');
const playerStore = require('./players');

const EMBED_REFRESH_INTERVAL_MS = 60 * 1000;

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
    saveStore(guild.id);
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
  saveStore(guildId);
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
// Falls back to the old exact-name-in-category match (unchanged from before) when there's no
// eventId (a raw session that somehow arrived without one) or no pinnedMessages entry matches it
// yet (e.g. a channel that predates this field, or one created manually via /setup-tournament) —
// so a genuinely untracked-but-correctly-named channel still isn't duplicated either.
async function findExistingTournamentChannel(guild, pinnedMessages, tournament, categoryId, channelName) {
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

  const existing = guild.channels.cache.find(c => c.name === channelName && c.parentId === (categoryId ?? null));
  if (existing) return { channel: existing, pinnedEntry: pinnedMessages[existing.id] ?? null, matchedBy: 'name' };

  return null;
}

async function createTournamentChannel(guild, tournament, pinnedMessages) {
  const { name, region, beginTime, lastBeginTime, isTrios, consoleOnly, isPermanent } = tournament;

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

  // Permanent tournaments (FNCS Divisional Cups) must never get a date-suffixed name — 'fncs'
  // also matches PER_DAY_KEYWORDS, but a date suffix keyed off *this* week's beginTime would give
  // next week's occurrence a different channel name, which the dedupe check below (exact name
  // match) wouldn't recognize as the same tournament — producing a brand new channel every week
  // instead of the single always-open one this is supposed to be.
  const perDay = !isPermanent && isPerDayTournament(name);
  const dateStr = perDay ? getDateStr(beginTime) : null;
  const channelName = buildChannelName(name, dateStr);

  console.log(`  🔧 createTournamentChannel("${name}", ${region}) → channel name "${channelName}"`);

  // Region is no longer baked into the name (channels live in per-region categories instead),
  // so the same tournament in a different region produces an identical name — scope the
  // dedup check to this region's category or same-name channels across regions would
  // incorrectly appear as duplicates of each other.
  const categoryId = getCategoryId(guild.id, region);
  const found = await findExistingTournamentChannel(guild, pinnedMessages, tournament, categoryId, channelName);
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
        saveStore(guild.id);
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
      saveStore(guild.id);
      console.log(`  🩹 Backfilled consoleOnly=${!!consoleOnly} for existing channel ${existing.id} (${name})`);
    }

    if (isPermanent) refreshPermanentBeginTime(existing.id, beginTime, pinnedMessages, guild.id);
    return;
  }

  // No mobile/solo/FNCS-Major re-check here — tournament-scraper.js's BLOCKED_KEYWORDS already
  // filtered those out before this tournament ever reached us.

  if (!categoryId) {
    console.log(`  ⚠️ No ${region} category configured for this guild — channel will be created with no parent category`);
  }

  // Every tournament channel (any region, console-only or not) is visible to the whole server —
  // region/console Discord roles no longer gate ViewChannel here (they still gate whether the
  // Registered role has been granted at all — see index.js's queue_duo/lf2 handler — just not
  // which channels a member can see). AttachFiles/EmbedLinks stays denied for @everyone regardless,
  // matching every other queue channel's no-spam rule.
  const permissionOverwrites = [
    { id: guild.roles.everyone, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
    { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
  ];

  const modRoleId = getRoleId(guild.id, 'mod');
  if (modRoleId) {
    permissionOverwrites.push({ id: modRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
  }

  try {
    console.log(`  🚀 Calling guild.channels.create("${channelName}")...`);
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId ?? null,
      permissionOverwrites,
    });

    console.log(`✅ Created channel: ${channelName} (id: ${channel.id})`);

    // Permanent tournaments never get a deleteAt at all — never scheduled for deletion, by
    // design (see the class-level comment on PERMANENT_KEYWORDS in tournament-scraper.js).
    const deleteAfter = isPermanent ? null : new Date(lastBeginTime).getTime() + CHANNEL_DELETE_BUFFER_MS;

    const { buildQueueButtons } = require('./embeds');
    const embed = buildTournamentEmbed(name, region, 0, isTrios, beginTime, deleteAfter, isPermanent);
    const buttons = buildQueueButtons(isTrios);
    const msg = await channel.send({ embeds: [embed], components: [buttons] });
    await msg.pin();

    pinnedMessages[channel.id] = {
      messageId: msg.id,
      guildId: guild.id,
      tournamentName: name,
      tournamentEventId: tournament.eventId ?? null,
      region,
      isTrios,
      // Real, scraped platform-eligibility data (tournament-scraper.js: platforms.length === 1 &&
      // platforms[0] === 'Console') — NOT a Discord-role gate (that was removed separately, see
      // index.js's queue_duo/lf2 handler). This is what queue.js's isCompatiblePlatform reads to
      // require every matched member be on Console for a genuinely console-only tournament.
      consoleOnly: !!consoleOnly,
      beginTime,
      deleteAt: deleteAfter,
      permanent: !!isPermanent,
    };
    saveStore(guild.id);

    if (isPermanent) {
      console.log(`  ♾️ Permanent tournament — no deletion timer armed for ${channel.id}`);
    } else {
      armDeletionTimer(guild, channel.id, { tournamentName: name, region, beginTime, deleteAt: deleteAfter }, pinnedMessages);
    }

  } catch (err) {
    console.error(`  ❌ Failed to create channel ${channelName}:`, err.message);
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
      await createTournamentChannel(guild, {
        ...tournament,
        lastBeginTime: tournament.isMultiSession ? tournament.lastBeginTime : tournament.beginTime,
      }, pinnedMessages);
    }

    console.log('✅ Tournament check complete');

  } catch (err) {
    console.error('Failed to check tournaments:', err.message);
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
      saveStore(guild.id);
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
      saveStore(guild.id);
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

      const msg = await channel.messages.fetch(pinned.messageId);
      const count = getQueueCount(guild.id, pinned.tournamentName, pinned.region);
      const newEmbed = buildTournamentEmbed(
        pinned.tournamentName, pinned.region, count, pinned.isTrios, pinned.beginTime, pinned.deleteAt, pinned.permanent
      );
      await msg.edit({ embeds: [newEmbed], components: msg.components });
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
// scrapeUpcomingTournaments), then fans the single result out to every guild's
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
  await forEachGuild(client, guild => checkAndCreateChannels(guild, tournaments, pinnedMessages));
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

  // Every 20 minutes — briefly dropped to once a day over Cloudflare-IP-block risk (each tick is
  // a full Puppeteer navigation via scrapeUpcomingTournaments), but a working residential proxy is
  // now in place (see proxy-config.js), so that risk no longer applies. Daily was too slow anyway:
  // short-notice skin cups are sometimes posted only 1-2 days out, and a tournament entering the
  // 48h creation window between daily ticks could sit unnoticed for up to ~24h before its channel
  // appeared — players would queue elsewhere in the meantime. This log fires unconditionally on
  // every tick (independent of whether checkAndCreateChannels itself finds anything to do) so a
  // live deployment's logs make it obvious the interval is still alive, rather than only ever
  // seeing evidence when a channel actually gets created.
  setInterval(async () => {
    const now = new Date();
    console.log(`⏰ Scheduler tick fired — UTC hour ${now.getUTCHours()} (${now.toISOString()}) — running tournament check`);
    await runTournamentCheckTick(client, pinnedMessages);
  }, 20 * 60 * 1000);

  setInterval(() => {
    runEmbedRefreshTick(client, pinnedMessages).catch(console.error);
  }, EMBED_REFRESH_INTERVAL_MS);

  console.log('📅 Tournament scheduler started — 20min tournament check + 60s embed refresh armed');
}

module.exports = {
  startScheduler, checkAndCreateChannels, managedChannels, buildChannelName, abbreviateBuildMode,
  createTournamentChannel,
};