// channel-manager.js - Automated tournament channel creation and deletion

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { scrapeUpcomingTournaments } = require('./tournament-scraper');
const { save: saveStore } = require('./store');
const { buildTournamentEmbed } = require('./embeds');
const { getQueueCount } = require('./queue');

const EMBED_REFRESH_INTERVAL_MS = 60 * 1000;

// How long after a tournament's last session begins its queue channel stays up before auto-deleting.
const CHANNEL_DELETE_BUFFER_MS = 2 * 60 * 60 * 1000;

const managedChannels = {};

// Broad catch-all patterns — anything that passes BLOCKED_KEYWORDS (see tournament-scraper.js)
// and matches one of these gets a channel. Keeps new/renamed tournament variants (e.g. FNCS's
// "Last Chance Qualifier" naming) from being silently skipped just because they weren't
// hardcoded here.
const KNOWN_TOURNAMENTS = [
  'victory cup',
  'cash cup',
  'fncs',
  'last chance qualifier',
  'elite series',
  'performance evaluation',
  'clix cup',
  'reload',
  'division',
];

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

// Arms (or re-arms) a channel's auto-deletion timer from a persisted deleteAt timestamp.
// Used both right after creating a channel and to recover timers that never got armed in this
// process — e.g. after a bot restart (managedChannels is in-memory only, unlike pinnedMessages),
// or for a legacy pinned entry that just had beginTime/deleteAt backfilled. Always fetches the
// channel at fire time rather than closing over a channel object, so a restart-recovered timer
// works identically to a freshly-armed one.
function armDeletionTimer(guild, channelId, pinned, pinnedMessages) {
  const msUntilDelete = pinned.deleteAt - Date.now();
  const label = `${pinned.tournamentName} (${pinned.region})`;

  const timer = scheduleAfter(msUntilDelete, async () => {
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel) {
        await channel.delete();
        console.log(`🗑️ Deleted channel: ${channel.name}`);
      } else {
        console.log(`  ⏭️ Channel ${channelId} (${label}) already gone — nothing to delete`);
      }
    } catch (err) {
      console.error(`Failed to delete channel ${channelId} (${label}):`, err.message);
    } finally {
      delete managedChannels[channelId];
      delete pinnedMessages[channelId];
      saveStore();
    }
  });

  managedChannels[channelId] = { tournamentName: pinned.tournamentName, region: pinned.region, beginTime: pinned.beginTime, deleteTimer: timer };
  const hrsUntil = (Math.max(msUntilDelete, 0) / 3600000).toFixed(1);
  console.log(`  ⏲️ Armed deletion timer for ${channelId} (${label}) — fires in ${hrsUntil}hrs${msUntilDelete <= 0 ? ' (overdue, deleting now)' : ''}`);
}

const REGION_CATEGORIES = {
  EU: process.env.CATEGORY_EU,
  NAC: process.env.CATEGORY_NAC,
  ME: process.env.CATEGORY_ME,
};

const REGION_ROLE_IDS = {
  EU: process.env.ROLE_EU,
  NAC: process.env.ROLE_NAC,
  ME: process.env.ROLE_ME,
};

function buildChannelName(tournamentName, dateStr = null) {
  const cleanName = tournamentName
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

function matchKnownTournament(name) {
  return KNOWN_TOURNAMENTS.find(k => name.toLowerCase().includes(k)) ?? null;
}

async function createTournamentChannel(guild, tournament, pinnedMessages) {
  const { name, region, beginTime, lastBeginTime, isTrios, consoleOnly } = tournament;

  const perDay = isPerDayTournament(name);
  const dateStr = perDay ? getDateStr(beginTime) : null;
  const channelName = buildChannelName(name, dateStr);

  console.log(`  🔧 createTournamentChannel("${name}", ${region}) → channel name "${channelName}"`);

  // Region is no longer baked into the name (channels live in per-region categories instead),
  // so the same tournament in a different region produces an identical name — scope the
  // dedup check to this region's category or same-name channels across regions would
  // incorrectly appear as duplicates of each other.
  const categoryId = REGION_CATEGORIES[region];
  const existing = guild.channels.cache.find(c => c.name === channelName && c.parentId === (categoryId ?? null));
  if (existing) {
    console.log(`  ⏭️ Skipped — channel already exists in this region's category: ${channelName}`);
    return;
  }

  if (name.toLowerCase().includes('mobile')) {
    console.log(`  ⏭️ Skipped — mobile tournaments are excluded: "${name}"`);
    return;
  }

  const matchedKeyword = matchKnownTournament(name);
  if (!matchedKeyword) {
    console.log(`  ❌ Skipped — "${name.toLowerCase()}" matched none of KNOWN_TOURNAMENTS: [${KNOWN_TOURNAMENTS.join(', ')}]`);
    console.log(`  ⚠️ Unknown tournament: ${name}`);
    return;
  }
  console.log(`  ✅ Matched KNOWN_TOURNAMENTS keyword: "${matchedKeyword}"`);

  const regionRoleId = REGION_ROLE_IDS[region];
  const consoleRoleId = process.env.ROLE_CONSOLE;

  if (!categoryId) {
    console.log(`  ⚠️ No CATEGORY_${region} env var set — channel will be created with no parent category`);
  }
  if (!(consoleOnly && consoleRoleId) && !regionRoleId) {
    console.log(`  ⚠️ No ROLE_${region} env var set — channel will have no region role granted view access`);
  }

  const permissionOverwrites = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
  ];

  const noFiles = [PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks];
  if (consoleOnly && consoleRoleId) {
    permissionOverwrites.push({ id: consoleRoleId, allow: [PermissionFlagsBits.ViewChannel], deny: noFiles });
  } else if (regionRoleId) {
    permissionOverwrites.push({ id: regionRoleId, allow: [PermissionFlagsBits.ViewChannel], deny: noFiles });
  }

  const modRoleId = process.env.MOD_ROLE_ID;
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

    const deleteAfter = new Date(lastBeginTime).getTime() + CHANNEL_DELETE_BUFFER_MS;

    const { buildQueueButtons } = require('./embeds');
    const embed = buildTournamentEmbed(name, region, 0, isTrios, beginTime, deleteAfter);
    const buttons = buildQueueButtons(isTrios);
    const msg = await channel.send({ embeds: [embed], components: [buttons] });
    await msg.pin();

    pinnedMessages[channel.id] = {
      messageId: msg.id,
      tournamentName: name,
      region,
      isTrios,
      beginTime,
      deleteAt: deleteAfter,
    };
    saveStore();

    armDeletionTimer(guild, channel.id, { tournamentName: name, region, beginTime, deleteAt: deleteAfter }, pinnedMessages);

  } catch (err) {
    console.error(`  ❌ Failed to create channel ${channelName}:`, err.message);
  }
}

async function checkAndCreateChannels(guild, pinnedMessages) {
  console.log('🔍 Checking for upcoming tournaments...');

  try {
    const tournaments = await scrapeUpcomingTournaments();
    console.log(`📋 Scraped ${tournaments.length} tournaments`);

    const now = new Date();
    console.log(`🕐 Current time: ${now.toISOString()}`);

    for (const tournament of tournaments) {
      const startDate = new Date(tournament.beginTime);
      const hoursUntilStart = (startDate.getTime() - now.getTime()) / (1000 * 60 * 60);

      console.log(`→ ${tournament.name} | ${tournament.region} | begins ${tournament.beginTime} | ${hoursUntilStart.toFixed(1)}hrs away`);

      if (hoursUntilStart <= 0) {
        console.log(`  ⏭️ Skipped — already started/in the past`);
        continue;
      }

      if (hoursUntilStart > 48) {
        console.log(`  ⏭️ Skipped — outside 48h window (enters window in ${(hoursUntilStart - 48).toFixed(1)}hrs)`);
        continue;
      }

      console.log(`  ✅ Within 48h window — attempting channel creation`);
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
async function updateActiveTournamentEmbeds(guild, pinnedMessages) {
  const entries = Object.entries(pinnedMessages);
  console.log(`🔄 Refreshing tournament embeds — ${entries.length} pinned channel(s) tracked`);

  // Legacy/manually-created entries can be missing beginTime (e.g. pinned before this field
  // existed, or created via /setup-tournament with no known schedule). Try once to recover it
  // by matching against a fresh scrape — gated behind "any missing" so this doesn't launch
  // Puppeteer on every 60s tick, and marked attempted either way so a permanent miss (a custom
  // name that will never appear in the scrape) doesn't retry forever.
  const needsBackfill = entries.filter(([, pinned]) => !pinned.beginTime && !pinned.beginTimeBackfillAttempted);
  if (needsBackfill.length > 0) {
    console.log(`  🔍 ${needsBackfill.length} pinned channel(s) missing beginTime — attempting one-time backfill from a fresh scrape`);
    try {
      const tournaments = await scrapeUpcomingTournaments();
      const byKey = new Map(tournaments.map(t => [`${t.name}-${t.region}`, t]));

      for (const [channelId, pinned] of needsBackfill) {
        const match = byKey.get(`${pinned.tournamentName}-${pinned.region}`);
        pinned.beginTimeBackfillAttempted = true;
        if (match) {
          pinned.beginTime = match.beginTime;
          pinned.deleteAt = new Date(match.isMultiSession ? match.lastBeginTime : match.beginTime).getTime() + CHANNEL_DELETE_BUFFER_MS;
          console.log(`  🩹 Backfilled beginTime for ${channelId} (${pinned.tournamentName}, ${pinned.region}): ${pinned.beginTime}`);
        } else {
          console.log(`  ⚠️ No match in current scrape for ${channelId} (${pinned.tournamentName}, ${pinned.region}) — leaving timer-less`);
        }
      }
      saveStore();
    } catch (err) {
      console.error('  ❌ Backfill scrape failed:', err.message);
    }
  }

  for (const [channelId, pinned] of entries) {
    // managedChannels is in-memory only — a bot restart wipes it even though pinnedMessages
    // (and its deleteAt) survives in data.json. Re-arm anything with a known deleteAt but no
    // timer in this process, whether that's restart recovery or an entry that was just
    // backfilled above. armDeletionTimer deletes immediately if deleteAt has already passed.
    if (pinned.deleteAt && !managedChannels[channelId]) {
      console.log(`  🔁 No deletion timer armed for ${channelId} (${pinned.tournamentName}) — arming now`);
      armDeletionTimer(guild, channelId, pinned, pinnedMessages);
    }

    if (!pinned.beginTime) {
      console.log(`  ⏭️ ${channelId} (${pinned.tournamentName ?? 'unknown'}) — no beginTime stored, countdown can't be rendered`);
      continue;
    }

    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        console.log(`  ⏭️ ${channelId} (${pinned.tournamentName}) — channel no longer exists, skipping`);
        continue;
      }

      const msg = await channel.messages.fetch(pinned.messageId);
      const count = getQueueCount(pinned.tournamentName, pinned.region);
      const newEmbed = buildTournamentEmbed(
        pinned.tournamentName, pinned.region, count, pinned.isTrios, pinned.beginTime, pinned.deleteAt
      );
      await msg.edit({ embeds: [newEmbed], components: msg.components });
      console.log(`  ✅ ${channelId} (${pinned.tournamentName}) — embed refreshed`);
    } catch (err) {
      console.error(`  ❌ Failed to refresh tournament embed for channel ${channelId}:`, err.message);
    }
  }
}

function startScheduler(guild, pinnedMessages) {
  checkAndCreateChannels(guild, pinnedMessages);
  // Also run immediately (not just on the 60s interval below) so deletion timers lost to a
  // restart — managedChannels is in-memory only — get re-armed right away instead of after
  // up to a minute's delay.
  updateActiveTournamentEmbeds(guild, pinnedMessages).catch(console.error);

  setInterval(async () => {
    const now = new Date();
    console.log(`⏰ Scheduler tick — UTC hour ${now.getUTCHours()} (${now.toISOString()})`);
    if (now.getUTCHours() === 12) {
      console.log('  → 12:00 UTC — running tournament check');
      await checkAndCreateChannels(guild, pinnedMessages);
    } else {
      console.log('  → not 12:00 UTC — skipping until next tick');
    }
  }, 60 * 60 * 1000);

  setInterval(() => {
    updateActiveTournamentEmbeds(guild, pinnedMessages).catch(console.error);
  }, EMBED_REFRESH_INTERVAL_MS);

  console.log('📅 Tournament scheduler started');
}

module.exports = { startScheduler, checkAndCreateChannels, managedChannels };