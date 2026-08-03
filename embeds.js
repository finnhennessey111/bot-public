// embeds.js - Discord embed and button builders

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, UserSelectMenuBuilder,
} = require('discord.js');
const config = require('./config');
const { MODES, REGIONS } = require('./creative-queue');
const epicOAuth = require('./epic-oauth');
const { BUILD_MODES, buildModeSpec } = require('./build-mode');

const PLATFORM_ICONS = {
  PC: '🖥️',
  PS4: '🎮',
  XB1: '🎮',
  SWITCH: '🎮',
  MOBILE: '📱',
  Console: '🎮',
};

const REGION_FLAGS = { EU: '🇪🇺', NAC: '🌎', ME: '🌍' };

// Full language list for the #get-roles language select (multi-select, up to 4) — shared between
// the menu builder and nowhere else, but kept as one list so the menu can't drift out of sync
// with itself across edits.
const LANGUAGE_OPTIONS = [
  'English', 'Spanish', 'French', 'German', 'Polish', 'Dutch', 'Portuguese', 'Turkish',
  'Arabic', 'Italian', 'Swedish', 'Norwegian', 'Danish', 'Finnish', 'Romanian', 'Greek',
  'Russian', 'Other',
];

const COLOR_DEFAULT = 0x4A90D9;
const COLOR_UPCOMING = 0x2ECC71; // green — before start
const COLOR_LIVE = 0xE67E22; // orange — in progress
const COLOR_ENDING_SOON = 0xE74C3C; // red — within the last 30min before auto-delete

const ENDING_SOON_THRESHOLD_MS = 30 * 60 * 1000;

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// beginTime/endTime are only known for scheduler-created tournament channels — when omitted
// (e.g. the manual /setup-tournament command has no scraped schedule) the embed falls back to
// its plain, timer-less appearance. isPermanent (FNCS Divisional Cups, Console Duos Victory Cup —
// see tournament-scraper.js's PERMANENT_KEYWORDS) always wins over the countdown/"in
// progress"/"ending soon" states below — a channel that never auto-deletes has no "ending" state
// that makes sense to show — but still uses beginTime for an informational "Next event" line, if
// one is known and still in the future (channel-manager.js keeps this fresh every hourly tick).
//
// eventId is Fortnite Tracker's own event identifier (tournament-scraper.js's eventId — see
// buildTournamentGroups' doc comment), null for manually-created channels (/setup-tournament has
// no scraped schedule to pull one from). When present, https://fortnitetracker.com/events/{eventId}
// is a real, working per-tournament event page — confirmed against live Fortnite Tracker data
// (the calendar's own event links resolve there, e.g. /events/epicgames_S41_PSTypicalGamer_EU
// returns the actual "PlayStation Typical Gamer Icon Cup" event page). The raw calendar JSON this
// bot scrapes never included a URL/slug field itself, but the eventId it already captures for
// dedup/rename purposes doubles as the path segment, so no extra scraping was needed for this.
// Shared by buildTournamentEmbed and buildRankedCupTournamentEmbed below — the countdown/"in
// progress"/"ending soon"/permanent status logic is identical for both, they just render the
// result into a different field layout (one queue count vs. a per-rank breakdown).
function computeTournamentStatus(beginTime, endTime, isPermanent) {
  let color = COLOR_DEFAULT;
  let statusText = null;

  if (isPermanent) {
    color = COLOR_UPCOMING;
    statusText = '🟢 Ongoing — queue anytime';

    const nextStartMs = beginTime ? new Date(beginTime).getTime() : null;
    if (nextStartMs && nextStartMs > Date.now()) {
      statusText += `\nNext event: <t:${Math.floor(nextStartMs / 1000)}:R>`;
    }
  } else if (beginTime) {
    const now = Date.now();
    const startMs = new Date(beginTime).getTime();
    const msUntilStart = startMs - now;
    const startTimestamp = Math.floor(startMs / 1000);

    if (msUntilStart > 0) {
      color = COLOR_UPCOMING;
      statusText = `⏰ Starts <t:${startTimestamp}:R>`;
    } else {
      const msUntilEnd = endTime ? new Date(endTime).getTime() - now : null;
      if (msUntilEnd !== null && msUntilEnd <= ENDING_SOON_THRESHOLD_MS) {
        color = COLOR_ENDING_SOON;
        statusText = `🔴 Ending soon — ${formatDuration(msUntilEnd)} remaining`;
      } else {
        color = COLOR_LIVE;
        statusText = `🟠 Tournament in progress — started <t:${startTimestamp}:R>`;
      }
    }
  }

  return { color, statusText };
}

// eventId -> a real, working per-tournament Fortnite Tracker event page, confirmed against live
// data (e.g. /events/epicgames_S41_PSTypicalGamer_EU resolves to the actual "PlayStation Typical
// Gamer Icon Cup" page) — see buildTournamentEmbed's doc comment below for the full story on why
// this needed no extra scraping. Shared with buildRankedCupTournamentEmbed.
function tournamentDescription(region, eventId) {
  const trackerUrl = eventId ? `https://fortnitetracker.com/events/${eventId}` : null;
  return (
    `**Region:** ${region}\n\nQueue up to find a teammate for this tournament.` +
    (trackerUrl ? `\n\n🔗 [Check if you're eligible](${trackerUrl})` : '') +
    '\n\n⚠️ **Make sure you\'re actually registered for this event** through Epic\'s own ' +
    'competitive system before queueing here — queueing on MatchMaker only finds you a teammate, ' +
    'it does not register you for the tournament itself.'
  );
}

// eventId is Fortnite Tracker's own event identifier (tournament-scraper.js's eventId — see
// buildTournamentGroups' doc comment), null for manually-created channels (/setup-tournament has
// no scraped schedule to pull one from). When present, https://fortnitetracker.com/events/{eventId}
// is a real, working per-tournament event page — confirmed against live Fortnite Tracker data
// (the calendar's own event links resolve there, e.g. /events/epicgames_S41_PSTypicalGamer_EU
// returns the actual "PlayStation Typical Gamer Icon Cup" event page). The raw calendar JSON this
// bot scrapes never included a URL/slug field itself, but the eventId it already captures for
// dedup/rename purposes doubles as the path segment, so no extra scraping was needed for this.
function buildTournamentEmbed(tournamentName, region, queueCount, isTrios = false, beginTime = null, endTime = null, isPermanent = false, eventId = null) {
  const { color, statusText } = computeTournamentStatus(beginTime, endTime, isPermanent);

  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${tournamentName}`)
    .setDescription(tournamentDescription(region, eventId))
    .setColor(color)
    .addFields(
      ...(statusText ? [{ name: '⏱️ Status', value: statusText }] : []),
      { name: '🟢 Players Queuing', value: `**${queueCount}**`, inline: true },
      { name: '📍 Region', value: region, inline: true },
      { name: '🎮 Format', value: isTrios ? 'Trios' : 'Duos', inline: true },
    )
    .setFooter({ text: 'MatchMaker • Think you\'re outperforming your PR? Check www.matchmakerbot.xyz' })
    .setTimestamp();

  return embed;
}

// ── RANKED CUP (per-rank-tier queues) ───────────────────────────────────────
// Ranked Cup tournaments (tournament-scraper.js's isRankedCupTitle) span 6 separate in-game rank
// tiers under ONE Fortnite Tracker event listing — confirmed against live scrape data, real titles
// never mention a rank tier at all ("Duos Ranked Cup (Battle Royale)"/"(Zero Build)"/"(Reload)" is
// the full set, one per build mode per region). A Bronze player and an Elite player shouldn't be
// matched together, so this channel type gets one queue button per rank instead of buildQueueButtons'
// single generic one. Discord buttons only have 5 fixed ButtonStyle values — no custom colors — so
// a leading emoji is what visually distinguishes each rank's button instead.
const RANK_TIERS = [
  { key: 'bronze', label: 'Bronze', emoji: '🟫' },
  { key: 'silver', label: 'Silver', emoji: '⬜' },
  { key: 'gold', label: 'Gold', emoji: '🟨' },
  { key: 'platinum', label: 'Platinum', emoji: '🟦' },
  { key: 'diamond', label: 'Diamond', emoji: '💠' },
  { key: 'elite', label: 'Elite', emoji: '⬛' },
];

function rankTierByKey(key) {
  return RANK_TIERS.find(r => r.key === key) ?? null;
}

// The queue POOL name for one rank tier — deliberately different from the real, unmodified
// tournament name (which stays untouched everywhere scoring/history lookups need Fortnite
// Tracker's literal name, e.g. buildTournamentPlayerFields' recentEvents match below) so each
// rank's matching pool (queue.js's queues[key][region]) is a genuinely separate array — a Bronze
// unit and an Elite unit are never even candidates for each other, since attemptMatchingForQueue
// only ever compares units within the same pool key.
function rankedCupPoolName(tournamentName, rankKey) {
  const tier = rankTierByKey(rankKey);
  return tier ? `${tournamentName} [${tier.label}]` : tournamentName;
}

function buildRankedCupTournamentEmbed(tournamentName, region, rankCounts, isTrios = false, beginTime = null, endTime = null, isPermanent = false, eventId = null) {
  const { color, statusText } = computeTournamentStatus(beginTime, endTime, isPermanent);

  const rankFieldValue = RANK_TIERS
    .map(tier => `${tier.emoji} **${tier.label}:** ${rankCounts[tier.key] ?? 0}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${tournamentName}`)
    .setDescription(tournamentDescription(region, eventId))
    .setColor(color)
    .addFields(
      ...(statusText ? [{ name: '⏱️ Status', value: statusText }] : []),
      { name: '🟢 Players Queuing (by rank)', value: rankFieldValue },
      { name: '📍 Region', value: region, inline: true },
      { name: '🎮 Format', value: isTrios ? 'Trios' : 'Duos', inline: true },
    )
    .setFooter({ text: 'MatchMaker • Think you\'re outperforming your PR? Check www.matchmakerbot.xyz' })
    .setTimestamp();

  return embed;
}

// customId shape: queue_rank_<duo|lf2>_<rankKey> — queueType mirrors buildQueueButtons' existing
// duo/lf2 split (Ranked Cups are duos in every real title observed so far, but this stays
// queueType-generic rather than duo-only in case a trios Ranked Cup ever appears). 3-per-row so
// all 6 fit across two rows.
function buildRankedCupQueueButtons(isTrios = false) {
  const queueType = isTrios ? 'lf2' : 'duo';
  const rows = [];
  for (let i = 0; i < RANK_TIERS.length; i += 3) {
    const row = new ActionRowBuilder().addComponents(
      RANK_TIERS.slice(i, i + 3).map(tier =>
        new ButtonBuilder()
          .setCustomId(`queue_rank_${queueType}_${tier.key}`)
          .setLabel(tier.label)
          .setStyle(ButtonStyle.Secondary)
          .setEmoji(tier.emoji)
      )
    );
    rows.push(row);
  }
  return rows;
}

// ── TOURNAMENT APPROVAL (owner DM) ────────────────────────────────────────────
// A genuinely new tournament (by Fortnite Tracker's own eventId) gets DMed to the developer
// (tournament-approval.js) with these before any channel is created anywhere — see that module's
// doc comment for the full gate design. decision is null while still pending, or
// 'approved'/'rejected'/'expired' once settled — settled DMs show a status line and no buttons
// (tournament-approval.js edits the same message in place rather than sending a new one).
function buildTournamentApprovalEmbed(tournament, decision = null) {
  const startMs = new Date(tournament.beginTime).getTime();
  const startTs = Math.floor(startMs / 1000);

  const tags = [
    tournament.isPermanent ? 'Permanent channel (FNCS Division / Victory Cup)' : null,
    tournament.isRankedCup ? 'Ranked Cup (per-rank queues)' : null,
    tournament.consoleOnly ? 'Console only' : null,
  ].filter(Boolean);

  const statusLine = {
    approved: '✅ **Approved** — channel created across every server.',
    rejected: '❌ **Rejected** — no channel was created.',
    expired: '⌛ **Expired** — the tournament\'s start time passed with no decision, so it was skipped.',
  }[decision];

  const buildModeLabel = buildModeSpec(tournament.buildMode).label;

  return new EmbedBuilder()
    .setTitle(decision ? '🆕 Tournament review — settled' : '🆕 New tournament detected — approval needed')
    .setDescription(
      `**${tournament.name}**\n` +
      `Region: ${tournament.region}\n` +
      `Build mode: ${buildModeLabel}${decision ? '' : ' (auto-detected — change below before approving if wrong)'}\n` +
      `Format: ${tournament.isTrios ? 'Trios' : 'Duos'}\n` +
      `Starts: <t:${startTs}:F> (<t:${startTs}:R>)\n` +
      (tags.length ? `${tags.join(' • ')}\n` : '') +
      `Event ID: \`${tournament.eventId}\`` +
      (statusLine ? `\n\n${statusLine}` : '')
    )
    .setColor(decision === 'rejected' ? 0xE74C3C : decision === 'expired' ? 0x95A5A6 : 0x4A90D9);
}

// Lets the developer correct tournament-scraper.js's title-based auto-detection (build-mode.js's
// detectBuildMode) before approving — some titles are genuinely ambiguous and worth a real check
// in-game rather than trusting automated detection alone. Pre-selected to currentBuildMode (the
// tournament's current value — auto-detected default, or whatever was last picked here) via
// setDefault, so re-rendering after a change (index.js's tournament_buildmode_ handler) shows the
// new choice as selected, not reset back to the top.
function buildBuildModeSelectRow(eventId, currentBuildMode) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`tournament_buildmode_${eventId}`)
      .setPlaceholder('Build mode')
      .addOptions(
        BUILD_MODES.map(mode =>
          new StringSelectMenuOptionBuilder()
            .setLabel(mode.label)
            .setValue(mode.key)
            .setDefault(mode.key === currentBuildMode)
        )
      ),
  );
}

function buildTournamentApprovalButtons(eventId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tournament_approve_${eventId}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`tournament_reject_${eventId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );
}

// ── TOURNAMENT CHANNEL DELETION UNDO (deleter DM + /restore-channel fallback) ────────────────
// channel-deletion-undo.js's accidental-deletion flow — see that module's doc comment for the full
// design. decision is null while still pending (has a Restore button), or
// 'restored'/'permanently_deleted' once settled (status line, no buttons — the same message is
// edited in place rather than replaced, same precedent as buildTournamentApprovalEmbed above).
function buildChannelDeletionUndoEmbed(record, decision = null) {
  const deletedByLine = record.deletedBy?.tag
    ? `Deleted by: ${record.deletedBy.tag}`
    : 'Deleted by: could not be determined from the audit log';

  const expiresTs = Math.floor(new Date(record.expiresAt).getTime() / 1000);

  const statusLine = {
    restored: '✅ **Restored** — the channel is back, exactly as it was.',
    permanently_deleted: '🗑️ **Staying deleted** — treated as intentional, the scraper won\'t recreate it.',
  }[decision];

  return new EmbedBuilder()
    .setTitle(decision ? '🗑️ Tournament channel deletion — settled' : '🗑️ Tournament channel deleted — was this intentional?')
    .setDescription(
      `You just deleted the channel for **${record.tournamentName}** (${record.region}).\n` +
      `${deletedByLine}\n\n` +
      (decision
        ? statusLine
        : 'If this was accidental, click **Restore** below to recreate it exactly as it was.\n\n' +
          `If nothing happens by <t:${expiresTs}:F> (<t:${expiresTs}:R>), it'll be treated as intentional ` +
          'and the scraper won\'t recreate it.')
    )
    .setColor(decision === 'restored' ? 0x2ECC71 : decision === 'permanently_deleted' ? 0x95A5A6 : 0xE74C3C);
}

function buildChannelDeletionUndoButton(recordId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`restore_channel_${recordId}`)
      .setLabel('Restore')
      .setStyle(ButtonStyle.Success)
      .setEmoji('♻️'),
  );
}

// /restore-channel's fallback listing (index.js) — every tournament in this guild still within its
// restore window, for when the DM was missed or the deleter has DMs disabled. Same
// restore_channel_<recordId> customId as the DM button above, so index.js's button handler covers
// both entry points with no special-casing.
function buildRestoreChannelListEmbed(records) {
  const lines = records.map(r => {
    const expiresTs = Math.floor(new Date(r.expiresAt).getTime() / 1000);
    const deletedByLine = r.deletedBy?.tag ? `deleted by ${r.deletedBy.tag}` : 'deleter unknown';
    return `**${r.tournamentName}** (${r.region}) — ${deletedByLine} — window closes <t:${expiresTs}:R>`;
  });

  return new EmbedBuilder()
    .setTitle('🗑️ Deleted tournament channels — restore window open')
    .setDescription(lines.join('\n'))
    .setColor(0xE74C3C)
    .setFooter({ text: 'MatchMaker' });
}

function buildRestoreChannelButtons(records) {
  // Discord caps a message at 5 action rows — records beyond that aren't clickable from this
  // listing (re-running the command after acting on the first few would surface the rest). In
  // practice there's realistically never more than one or two pending at once.
  return records.slice(0, 5).map(r =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`restore_channel_${r._id}`)
        .setLabel(`Restore: ${r.tournamentName}`.slice(0, 80))
        .setStyle(ButtonStyle.Success)
        .setEmoji('♻️')
    )
  );
}

function buildQueueButtons(isTrios = false) {
  const row = new ActionRowBuilder();

  if (isTrios) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('queue_lf2')
        .setLabel('Looking for 2')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔍'),
    );
  } else {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('queue_duo')
        .setLabel('Queue')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🔍'),
    );
  }

  return row;
}

function buildLeaveQueueButton(customId = 'leave_queue') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel('Leave Queue')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );
}

function formatPlacementLine(event) {
  const placementText = event.placement != null ? `#${event.placement.toLocaleString()}` : 'DNP';
  const dateText = event.date ? ` — <t:${Math.floor(new Date(event.date).getTime() / 1000)}:D>` : '';
  return `${placementText} — ${event.prPoints.toFixed(2)} PR pts${dateText}`;
}

// Epic username always shown; Discord tag always shown too (not just username) — a modern
// no-discriminator account's tag equals its username, in which case there's nothing extra to
// show, so this only appends the tag when it differs.
function formatDiscordLine(player) {
  const tag = player.discordTag ?? player.discordUsername;
  return tag === player.discordUsername ? player.discordUsername : `${player.discordUsername} (${tag})`;
}

// One consistent "true home region/platform vs. currently-displayed PR context" indicator —
// combines #3's region transparency and #6's platform transparency into a single note rather than
// two separate ad-hoc ones, per that task's explicit instruction. Returns null (nothing rendered)
// for the overwhelmingly common case: a player queueing in their own home region on their default
// platform segment, where the displayed PR already IS their home PR with nothing to disclose.
// player.prContext is stamped by players.js's getStatsForContext via queue.js's buildPlayer /
// creative-queue.js's buildCreativePlayer.
function buildPrContextNote(player) {
  const ctx = player.prContext;
  if (!ctx || (ctx.isHomeRegion && ctx.isHomePlatform)) return null;

  const parts = [];
  if (!ctx.isHomeRegion) parts.push(`${ctx.region} region (home: ${player.homeRegion})`);
  if (!ctx.isHomePlatform) {
    const segmentLabel = ctx.platformSegment === 'gamepad' ? 'Console' : 'PC';
    parts.push(`${segmentLabel}-tournament PR — genuinely ${player.platform}`);
  }
  return `Showing: ${parts.join(' • ')}`;
}

// Shared field set for the tournament duo/trio match card — used by both buildMatchCard (same
// server) and buildCrossServerPlayerCard (cross-server, which just appends a Server field on
// top of this). A one-off tournament with no queue history for itself falls back to the
// player's 3 most recent placements across any tournament, rather than showing nothing.
function buildTournamentPlayerFields(player, tournamentName) {
  const tournamentEvents = player.recentEvents.filter(e => e.name === tournamentName);
  const isFallback = tournamentEvents.length === 0;
  const events = isFallback ? player.recentEvents : tournamentEvents;

  const recentPlacements = events.slice(0, 3);
  const placementsLabel = isFallback
    ? '📊 Last 3 Placements (recent — no history for this tournament yet)'
    : `📊 Last 3 Placements (${tournamentName})`;
  const placementsText = recentPlacements.length > 0
    ? recentPlacements.map(formatPlacementLine).join('\n')
    : 'No recent placements';

  const placedEvents = events.filter(e => e.placement != null);
  const bestPlacements = [...placedEvents].sort((a, b) => a.placement - b.placement).slice(0, 3);
  const bestLabel = isFallback
    ? '🏆 Best 3 Placements (recent — no history for this tournament yet)'
    : `🏆 Best 3 Placements (${tournamentName})`;
  const bestText = bestPlacements.length > 0
    ? bestPlacements.map(formatPlacementLine).join('\n')
    : 'No placements recorded';

  const rolesText = player.ingameRoles?.length > 0 ? player.ingameRoles.join(', ') : 'Not specified';
  const languagesText = player.languages?.length > 0 ? player.languages.join(', ') : 'Not specified';

  const slug = encodeURIComponent(player.epicUsername);
  const profileUrl = player.epicId
    ? `https://fortnitetracker.com/profile/all/${slug}/events?region=${player.homeRegion}&id=${player.epicId}`
    : `https://fortnitetracker.com/profile/all/${slug}/events`;

  const fields = [
    { name: '⚡ Total PR', value: `**${player.totalPR}**`, inline: true },
    { name: '🌍 Region', value: player.homeRegion, inline: true },
    { name: '🎭 In-Game Role', value: rolesText, inline: true },
    { name: placementsLabel, value: placementsText },
    { name: bestLabel, value: bestText },
    { name: '🗣️ Language', value: languagesText, inline: true },
    { name: '🔗 Profile', value: `[View Profile](${profileUrl})` },
  ];

  if (player.ageBracket) {
    fields.splice(3, 0, { name: '🔞 Age Bracket', value: player.ageBracket, inline: true });
  }

  const prContextNote = buildPrContextNote(player);
  if (prContextNote) {
    fields.splice(1, 0, { name: '📎 PR Context', value: prContextNote, inline: true });
  }

  return fields;
}

function buildMatchCard(player, tournamentName) {
  const platformIcon = PLATFORM_ICONS[player.platform] ?? '🎮';

  return new EmbedBuilder()
    .setTitle(`${platformIcon} ${player.epicUsername}`)
    .setDescription(`**Discord:** ${formatDiscordLine(player)}`)
    .setColor(0x1E3A5F)
    .addFields(...buildTournamentPlayerFields(player, tournamentName))
    .setFooter({ text: `Queue type: ${player.queueType.toUpperCase()} • MatchMaker` })
    .setTimestamp();
}

// Shown in place of buildMatchCard/buildCreativeMatchCard when the player being displayed is on
// a *different* server than the channel's own guild — Discord permissions are guild-scoped, so a
// cross-server opponent can't be added to the channel or pinged, just described in text. For a
// tournament match this carries the exact same fields as buildMatchCard plus a Server field —
// only the creative (1v1/2v2/6s/8s) path keeps the old minimal card, since creative players don't
// carry placement/role/language data at all.
function buildCrossServerPlayerCard(player, kind = 'tournament', tournamentName = null) {
  const platformIcon = PLATFORM_ICONS[player.platform] ?? '🎮';

  if (kind === 'creative') {
    return new EmbedBuilder()
      .setTitle(`${platformIcon} ${player.epicUsername}`)
      .setColor(CREATIVE_COLOR)
      .addFields(
        { name: '💬 Discord', value: formatDiscordLine(player), inline: true },
        { name: '🌐 Server', value: player.guildName ?? 'Unknown server', inline: true },
      )
      .setFooter({ text: 'Matched from another server — add them in-game to play together' })
      .setTimestamp();
  }

  return new EmbedBuilder()
    .setTitle(`${platformIcon} ${player.epicUsername}`)
    .setDescription(`**Discord:** ${formatDiscordLine(player)}`)
    .setColor(0x1E3A5F)
    .addFields(
      ...buildTournamentPlayerFields(player, tournamentName),
      { name: '🌐 Server', value: player.guildName ?? 'Unknown server', inline: true },
    )
    .setFooter({ text: 'Matched from another server — add them in-game to play together' })
    .setTimestamp();
}

// For roster mention lines (team announcements, ready pings, etc.) — a player on the viewer's
// own guild can be pinged normally; a cross-server player can't be addressed from a guild they
// aren't in, so they're named instead.
function mentionOrCrossServerName(player, viewerGuildId) {
  return player.guildId === viewerGuildId
    ? `<@${player.discordId}>`
    : `**${player.epicUsername}** (${player.guildName ?? 'other server'})`;
}

function buildMatchButtons(matchId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_${matchId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`reject_${matchId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );
}

function buildMatchConfirmedEmbed(players) {
  return new EmbedBuilder()
    .setTitle('🎮 Match Found!')
    .setDescription('You have been matched! Add each other in-game and good luck! 🏆\n\n📊 Think you\'re outperforming your PR? Check www.matchmakerbot.xyz')
    .setColor(0x2E7D32)
    .addFields(
      players.map((player, i) => {
        const platformIcon = PLATFORM_ICONS[player.platform] ?? '🎮';
        return {
          name: `${platformIcon} Player ${i + 1}`,
          value: `**${player.epicUsername}**\nDiscord: ${player.discordUsername}`,
          inline: true,
        };
      })
    )
    .setFooter({ text: 'MatchMaker • Good luck!' })
    .setTimestamp();
}

// Single-user picker shared by any button flow that used to be a `/command @user` slash option
// (vote-kick) — a Discord-native user select needs no autocomplete or validation UI of its own.
function buildUserSelectRow(customId, placeholder) {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(1),
  );
}

// ── INLINE 6s/8s TEAM FORMING (team-invite.js) ──────────────────────────────
// Replaces the old standalone #form-party channel — bring-count select, then (if bringing 1+) an
// exact-count User Select to invite specific teammates, all from inside the 6s/8s channel itself.

// maxBring is 5 for 6s (target size 6, minus the clicking leader), 7 for 8s.
function buildTeamBringCountSelectRow(category, maxBring) {
  const options = [];
  for (let n = 0; n <= maxBring; n++) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(n === 0 ? '0 — queue solo' : `${n}`)
        .setValue(`${n}`)
    );
  }
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`team_bring_count_${category}`)
      .setPlaceholder('How many people are you bringing?')
      .addOptions(options),
  );
}

// count is exact (min = max) — the leader picked this number up front, so the select must
// resolve to precisely that many teammates, no more, no less. defaultUserIds pre-fills the menu
// (Edit Team re-opening this pre-selected with whoever's currently in/invited to the team).
function buildTeamMemberUserSelectRow(customId, count, defaultUserIds = []) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(`Pick exactly ${count} teammate${count === 1 ? '' : 's'}`)
    .setMinValues(count)
    .setMaxValues(count);
  if (defaultUserIds.length > 0) menu.addDefaultUsers(defaultUserIds);
  return new ActionRowBuilder().addComponents(menu);
}

// Shown to an invited player — every *current* teammate (leader + anyone already accepted), name/
// PR/platform/region only, per spec ("nothing else about them"). p.region is each teammate's own
// registered home region (players.js), not necessarily this team's queue region (team.region,
// already shown above in the description) — same homeRegion-vs-queueRegion distinction
// buildMatchCard/buildTournamentPlayerFields draws for tournament matches.
function buildTeamInviteEmbed(leaderUsername, teammatePlayers, invitedUsername, mode, region) {
  return new EmbedBuilder()
    .setTitle('🤝 Team Invite')
    .setDescription(
      `**${leaderUsername}** wants **${invitedUsername}** to join their team for **${mode}** (${region}).`
    )
    .setColor(CREATIVE_COLOR)
    .addFields(
      teammatePlayers.map(p => {
        const platformIcon = PLATFORM_ICONS[p.platform] ?? '🎮';
        const flag = REGION_FLAGS[p.region] ?? '🏳️';
        return {
          name: `${platformIcon} ${p.epicUsername}`,
          value: `${p.totalPR} PR • ${p.platform} • ${flag} ${p.region ?? 'Unknown'}`,
          inline: true,
        };
      })
    )
    .setFooter({ text: 'MatchMaker • Invite expires in 5 minutes' })
    .setTimestamp();
}

function buildTeamInviteButtons(inviteId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`team_invite_accept_${inviteId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`team_invite_decline_${inviteId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );
}

// Shared status panel for a forming team — visible to the whole channel (not ephemeral) since
// Accept/Decline happen from separate interactions and need to edit this same message in place;
// Edit Team/Queue Now are still leader-only, enforced by the button handlers.
function buildTeamFormingEmbed(leaderUsername, mode, region, bringCount, acceptedUsernames, pendingUsernames) {
  const acceptedLine = acceptedUsernames.length > 0 ? acceptedUsernames.map(n => `✅ ${n}`).join('\n') : '_none yet_';
  const pendingLine = pendingUsernames.length > 0 ? pendingUsernames.map(n => `⏳ ${n}`).join('\n') : '_none_';

  return new EmbedBuilder()
    .setTitle('🤝 Forming a Team')
    .setDescription(`**${leaderUsername}** is bringing **${bringCount}** teammate(s) for **${mode}** (${region}).`)
    .setColor(CREATIVE_COLOR)
    .addFields(
      { name: 'On the team', value: acceptedLine, inline: true },
      { name: 'Invited — pending', value: pendingLine, inline: true },
    )
    .setFooter({ text: 'MatchMaker • Leader can Edit Team or Queue Now at any time' })
    .setTimestamp();
}

function buildTeamFormingButtons(leaderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`team_edit_${leaderId}`)
      .setLabel('Edit Team')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('✏️'),
    new ButtonBuilder()
      .setCustomId(`team_queue_now_${leaderId}`)
      .setLabel('Queue Now')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔍'),
  );
}

// ── CREATIVE QUEUE ────────────────────────────────────────────────────────────

const CREATIVE_COLOR = 0x9B59B6;

const COMING_SOON_CATEGORY_LABEL = { '6s': '3v3', '8s': '4v4' };

// Posted in creative-6s/creative-8s instead of the real queue embed (creative-channel.js's
// postComingSoonCreativeChannel) — 6s/8s is planned as a paid feature, not available during the
// current free-for-everyone period. No components/buttons at all, unlike buildCreativeQueueEmbed —
// there's nothing to queue for yet. The channel itself still gets created by /matchmaker-setup (so
// launching the real feature later is just swapping this embed's content in place, not creating/
// deleting channels retroactively) — see matchmaker-setup.js's CREATIVE_CHANNEL_SPECS comment.
function buildCreativeComingSoonEmbed(category) {
  const formatLabel = COMING_SOON_CATEGORY_LABEL[category] ?? category;
  return new EmbedBuilder()
    .setTitle(`🎮 Creative ${category} (${formatLabel}) — Coming Soon`)
    .setDescription(
      `🎉 Free trial coming soon! Creative ${category} matchmaking isn't open yet — check back soon. ` +
      'This channel will switch over to the real queue automatically once it launches.'
    )
    .setColor(CREATIVE_COLOR)
    .setFooter({ text: 'MatchMaker Creative • Check your ELO at www.matchmakerbot.xyz' });
}

// counts: { [mode]: { EU: n, NAC: n } } — computed by the caller (creative-channel.js) so this
// stays a pure presentation function, same pattern as buildTournamentEmbed's queueCount param.
// `modes` is the list of mode-name strings for this category — passed in rather than looked up
// from creative-queue.js's MODES so this same builder serves both the pairwise 1v1/2v2 queue
// and the 6s/8s partial-fill team queue (creative-team-queue.js has its own MODES map).
function buildCreativeQueueEmbed(category, counts = {}, modes = MODES[category]) {
  const modeLines = modes.map(mode => {
    const modeCounts = counts[mode] ?? {};
    const perRegion = REGIONS.map(r => `${REGION_FLAGS[r]} ${r}: **${modeCounts[r] ?? 0}**`).join('   ');
    return `**${mode}**\n${perRegion}`;
  });

  return new EmbedBuilder()
    .setTitle(`🎮 Creative ${category} Queue`)
    .setDescription(
      'Select a **mode** and **region** below, then click **Queue** to join.\n\n' +
      modeLines.join('\n\n')
    )
    .setColor(CREATIVE_COLOR)
    .setFooter({ text: 'MatchMaker Creative • Think you\'re outperforming your PR? Check www.matchmakerbot.xyz' })
    .setTimestamp();
}

function buildCreativeQueueComponents(category, modes = MODES[category], queueButtonPrefix = 'creative_queue_', leaveButtonId = 'creative_leave_queue') {
  const modeSelect = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`creative_mode_${category}`)
      .setPlaceholder('🎯 Select a mode')
      .addOptions(modes.map(mode => new StringSelectMenuOptionBuilder().setLabel(mode).setValue(mode)))
  );

  const regionSelect = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`creative_region_${category}`)
      .setPlaceholder('🌍 Select a region')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('EU — Europe').setValue('EU').setEmoji('🇪🇺'),
        new StringSelectMenuOptionBuilder().setLabel('NA Central').setValue('NAC').setEmoji('🌎'),
      )
  );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${queueButtonPrefix}${category}`)
      .setLabel('Queue')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔍'),
    new ButtonBuilder()
      .setCustomId(leaveButtonId)
      .setLabel('Leave Queue')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );

  return [modeSelect, regionSelect, buttons];
}

function buildCreativeMatchCard(player) {
  const platformIcon = PLATFORM_ICONS[player.platform] ?? '🎮';
  const flag = REGION_FLAGS[player.region] ?? '🏳️';

  const fields = [
    { name: '⚡ Total PR', value: `**${player.totalPR}**`, inline: true },
    { name: '🌍 Region', value: `${flag} ${player.region}`, inline: true },
    { name: '🎮 Platform', value: player.platform, inline: true },
  ];

  const prContextNote = buildPrContextNote(player);
  if (prContextNote) {
    fields.push({ name: '📎 PR Context', value: prContextNote, inline: false });
  }

  return new EmbedBuilder()
    .setTitle(`${platformIcon} ${player.epicUsername}`)
    .setDescription(`**Discord:** ${player.discordUsername}`)
    .setColor(CREATIVE_COLOR)
    .addFields(...fields)
    .setFooter({ text: `${player.mode} • MatchMaker Creative` })
    .setTimestamp();
}

function buildCreativeMatchConfirmedEmbed(players, mode) {
  return new EmbedBuilder()
    .setTitle('🎮 Creative Match Found!')
    .setDescription(`**${mode}**\n\nShare your in-game details below and good luck! 🏆\n\n📊 Think you're outperforming your PR? Check www.matchmakerbot.xyz`)
    .setColor(CREATIVE_COLOR)
    .addFields(
      players.map((player, i) => {
        const platformIcon = PLATFORM_ICONS[player.platform] ?? '🎮';
        return {
          name: `${platformIcon} Player ${i + 1}`,
          value: `**${player.epicUsername}**\nDiscord: ${player.discordUsername}`,
          inline: true,
        };
      })
    )
    .setFooter({ text: 'MatchMaker Creative • Close the channel when you\'re done' })
    .setTimestamp();
}

function buildCloseChannelButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('close_creative_channel')
      .setLabel('Close Channel')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );
}

// Posted alongside buildCloseChannelButton in a confirmed 6s/8s team match channel — primary
// path for what used to be the /votekick command's target-player option.
function buildVoteKickOpenButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('votekick_open')
      .setLabel('🗳️ Vote Kick')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── 6s/8s TEAM MATCH LIFECYCLE ─────────────────────────────────────────────────

function buildReadyCheckEmbed(readyCount, totalCount) {
  return new EmbedBuilder()
    .setTitle('✅ Ready Check')
    .setDescription(
      `Click **Ready** to confirm you're here. Anyone who doesn't respond within ` +
      `${config.teamQueue.readyCheckSeconds}s will be removed and automatically re-queued.\n\n` +
      `**${readyCount}/${totalCount}** ready`
    )
    .setColor(CREATIVE_COLOR)
    .setTimestamp();
}

// Channel-scoped — the handler looks up which match this belongs to via the channel it was
// clicked in, so (unlike accept_/reject_/votekick_) no matchId needs to be embedded here.
function buildReadyButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('team_ready')
      .setLabel('Ready')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
  );
}

// ── 6s/8s TEAM ASSIGNMENT ──────────────────────────────────────────────────

function buildTeamMethodVoteEmbed(chooseCount, balancedCount, totalCount) {
  return new EmbedBuilder()
    .setTitle('🗳️ How would you like teams to be decided?')
    .setDescription(
      '👥 **Choose Own Teams** — everyone picks Team 1 or Team 2 themselves. Anyone who hasn\'t ' +
      'picked in time is auto-assigned to balance the teams.\n\n' +
      '⚡ **PR Balanced Teams** — the bot splits everyone into the most evenly matched teams it can.\n\n' +
      `Majority wins after **${config.teamQueue.teamMethodVoteSeconds}s** — a tie defaults to PR Balanced Teams.\n\n` +
      `👥 **${chooseCount}**   ⚡ **${balancedCount}** (${totalCount} player(s) total)`
    )
    .setColor(CREATIVE_COLOR)
    .setTimestamp();
}

function buildTeamMethodVoteButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('team_method_choose')
      .setLabel('Choose Own Teams')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('👥'),
    new ButtonBuilder()
      .setCustomId('team_method_balanced')
      .setLabel('PR Balanced Teams')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⚡'),
  );
}

function formatTeamRosterLine(players) {
  return players.length > 0 ? players.map(p => p.epicUsername).join('\n') : '*Nobody yet*';
}

function buildTeamChoiceEmbed(team1Players, team2Players, undecidedPlayers) {
  return new EmbedBuilder()
    .setTitle('👥 Pick Your Team!')
    .setDescription(
      `Click a button below to join a team. Anyone undecided after **${config.teamQueue.teamChoiceSeconds}s** ` +
      'is auto-assigned to balance the teams.'
    )
    .setColor(CREATIVE_COLOR)
    .addFields(
      { name: '1️⃣ Team 1', value: formatTeamRosterLine(team1Players), inline: true },
      { name: '2️⃣ Team 2', value: formatTeamRosterLine(team2Players), inline: true },
      { name: '❔ Undecided', value: formatTeamRosterLine(undecidedPlayers), inline: false },
    )
    .setTimestamp();
}

function buildTeamChoiceButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('team_pick_1')
      .setLabel('Join Team 1')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('1️⃣'),
    new ButtonBuilder()
      .setCustomId('team_pick_2')
      .setLabel('Join Team 2')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('2️⃣'),
  );
}

function formatTeamAnnounceLine(players) {
  return players.map(p => `**${p.epicUsername}** — ${p.totalPR} PR`).join('\n');
}

function buildTeamsAnnouncementEmbed(team1Players, team2Players) {
  return new EmbedBuilder()
    .setTitle('✅ Teams Finalised')
    .setColor(0x2E7D32)
    .addFields(
      { name: '1️⃣ Team 1', value: formatTeamAnnounceLine(team1Players), inline: true },
      { name: '2️⃣ Team 2', value: formatTeamAnnounceLine(team2Players), inline: true },
    )
    .setTimestamp();
}

function buildVoteKickEmbed(initiatorUsername, targetUsername, yesCount, noCount, totalEligible) {
  const threshold = Math.ceil(config.teamQueue.voteKickMajority * totalEligible);
  return new EmbedBuilder()
    .setTitle('🗳️ Vote Kick')
    .setDescription(
      `**${initiatorUsername}** wants to kick **${targetUsername}**.\n\n` +
      `Needs **${threshold}/${totalEligible}** yes votes to pass within ${config.teamQueue.voteKickWindowSeconds}s.\n\n` +
      `✅ **${yesCount}**   ❌ **${noCount}**`
    )
    .setColor(0xE74C3C)
    .setTimestamp();
}

function buildVoteKickButtons(voteId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`votekick_yes_${voteId}`)
      .setLabel('Yes')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`votekick_no_${voteId}`)
      .setLabel('No')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );
}

// ── MATCH FEEDBACK (data capture only — see feedback.js) ────────────────────
// matchId is embedded in every customId here (not looked up by channel, unlike vote-kick) since
// the feedback prompt is a standalone ephemeral message with no channel of its own to key off.

function buildFeedbackRatingButtons(matchId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`feedback_great_${matchId}`)
      .setLabel('Great match')
      .setStyle(ButtonStyle.Success)
      .setEmoji('👍'),
    new ButtonBuilder()
      .setCustomId(`feedback_okay_${matchId}`)
      .setLabel('Okay')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('😐'),
    new ButtonBuilder()
      .setCustomId(`feedback_notgreat_${matchId}`)
      .setLabel('Not great')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('👎'),
  );
}

function buildFeedbackNotGreatReasonButtons(matchId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`feedback_reason_tooeasy_${matchId}`)
      .setLabel('Too easy')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`feedback_reason_toohard_${matchId}`)
      .setLabel('Too hard')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`feedback_reason_comms_${matchId}`)
      .setLabel('Bad communication')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`feedback_reason_other_${matchId}`)
      .setLabel('Other')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildRejectReasonButtons(matchId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rejectreason_pr_${matchId}`)
      .setLabel('PR felt mismatched')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rejectreason_placements_${matchId}`)
      .setLabel('Recent placements didn\'t match up')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rejectreason_other_${matchId}`)
      .setLabel('Not interested / other')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ── POST-MATCH OUTCOME/DIFFICULTY SURVEY (data capture only — see post-match-feedback.js) ────
// DM'd to every participant once a CREATIVE match concludes (channel closed, either via the Close
// Channel button or its own auto-delete timer) — separate from the "rate your match" flow above
// (buildFeedbackRatingButtons), different trigger point and different questions. Pure data
// capture for later manual review — never affects the reporting player's own score in any way
// (see models/PostMatchFeedback.js's doc comment for why that constraint matters). Two steps, same
// "don't record anything until the final answer" shape as buildFeedbackNotGreatReasonButtons above
// — outcome is threaded through the second step's customId rather than written after step 1, so a
// player ends up with exactly one response per match, not a stray outcome-only partial one.
function buildPostMatchOutcomeEmbed(mode) {
  return new EmbedBuilder()
    .setTitle('🏆 How did your match go?')
    .setDescription(`A quick 2-question check-in for your recent **${mode}** match — purely for us to review later, this never affects your score.`)
    .setColor(COLOR_DEFAULT)
    .setFooter({ text: 'MatchMaker • Think you\'re outperforming your PR? Check www.matchmakerbot.xyz' });
}

function buildPostMatchOutcomeButtons(matchId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`postmatch_outcome_win_${matchId}`).setLabel('I won').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`postmatch_outcome_loss_${matchId}`).setLabel('I lost').setStyle(ButtonStyle.Danger).setEmoji('❌'),
  );
}

// outcome ('win'/'loss') is threaded through here from whichever step-1 button was clicked —
// step 2's customId carries it forward so the final write (index.js's postmatch_result_ handler)
// has both answers at once without needing to look anything up.
function buildPostMatchDifficultyButtons(matchId, outcome) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`postmatch_result_${outcome}_easy_${matchId}`).setLabel('Too easy for my skill').setStyle(ButtonStyle.Secondary).setEmoji('🟢'),
    new ButtonBuilder().setCustomId(`postmatch_result_${outcome}_fair_${matchId}`).setLabel('Felt fair').setStyle(ButtonStyle.Secondary).setEmoji('🟡'),
    new ButtonBuilder().setCustomId(`postmatch_result_${outcome}_hard_${matchId}`).setLabel('Too hard for my skill').setStyle(ButtonStyle.Secondary).setEmoji('🔴'),
  );
}

// ── HOWTO ──────────────────────────────────────────────────────────────────

function buildHowtoEmbed() {
  return new EmbedBuilder()
    .setTitle('🎮 How to Use MatchMaker')
    .setDescription(
      '**Getting Started**\n' +
      '• Go to #get-roles and set your region, platform and role\n' +
      '• That\'s it — you\'re ready to queue\n\n' +
      '**Finding a Teammate for Tournaments**\n' +
      '• Go to the tournament channel for your region\n' +
      '• Click Queue\n' +
      '• Accept or decline your match when one is found\n\n' +
      '**Creative (1v1, 2v2, 6s, 8s)**\n' +
      '• Go to the relevant creative channel\n' +
      '• Pick your mode and region then click Queue\n\n' +
      '**Bringing Friends (6s/8s only)**\n' +
      '• Click Queue, choose how many teammates you\'re bringing, then pick them\n' +
      '• Once they accept, click Queue Now — the bot backfills any open slots\n\n' +
      'Need help? Tag a mod.'
    )
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker' });
}

// ── ADMIN SETUP ────────────────────────────────────────────────────────────
// #setup is mod-role-only (see permissions.js's enforceModOnlyChannels) — this is admin/mod
// onboarding, never shown to regular members.

// changelogEntries: newest-first, already capped to the last ~5 (changelog.js's getRecentEntries)
// — one shared global feed across every guild, not per-server. Optional/omittable so every
// existing call site (and any future one) that doesn't have entries handy still works unchanged.
function buildSetupInstructionsEmbed(changelogEntries = []) {
  const embed = new EmbedBuilder()
    .setTitle('🛠️ Admin Setup')
    .setDescription(
      '• Run `/matchmaker-setup` — creates every role, category, channel and starter embed ' +
      'MatchMaker needs, including an auto-created verified role\n' +
      '• Assign **MatchMaker Mod** role to your mod team in Server Settings → Roles\n' +
      '• Members link their Epic account with the **Link Epic Account** button in #register — ' +
      'that\'s it, everything else is automatic\n' +
      '• Tournament channels appear automatically 48hrs before each tournament\n' +
      '• Deleted a tournament channel by accident? You\'ll get a DM with a Restore button (24h ' +
      'window). Missed the DM, or DMs are off? Run `/restore-channel` to see and restore anything ' +
      'still within its window\n' +
      '• For help: personalediting2@gmail.com'
    )
    .addFields({
      name: '🔧 Troubleshooting common issues',
      value:
        '• Channels aren\'t being created / "Category does not exist" errors — a category got ' +
        'deleted or renamed since setup ran. Fix: re-run `/matchmaker-setup`.\n' +
        '• "No verified role configured" warnings — same cause, same fix: re-run `/matchmaker-setup`.\n' +
        '• Someone stuck on "fetching stats" — this can occasionally take up to a minute if it ' +
        'needs a couple of retries behind the scenes; it should resolve on its own. If it errors ' +
        'outright, have them try again in a minute.\n' +
        '• Still stuck after re-running setup? — contact personalediting2@gmail.com',
    });

  if (changelogEntries.length > 0) {
    const value = changelogEntries
      .map(e => `• ${e.text} — <t:${Math.floor(new Date(e.createdAt).getTime() / 1000)}:R>`)
      .join('\n');
    embed.addFields({ name: '📢 Recent Updates', value });
  }

  return embed.setColor(0x4A90D9).setFooter({ text: 'MatchMaker' });
}

// ── SUGGESTIONS ──────────────────────────────────────────────────────────────
// #suggestions is verified-member-visible (permissions.js's verifiedChannels), one persistent
// embed with a single button that opens a modal (index.js's suggestion_open/suggestion_modal) —
// see suggestions.js for the centralized storage + developer-DM forwarding this feeds into.
function buildSuggestionsChannelEmbed() {
  return new EmbedBuilder()
    .setTitle('💡 Suggest a Feature')
    .setDescription(
      'Got an idea to make MatchMaker better? Click the button below and it goes straight to the ' +
      'developer.\n\n' +
      'This is for feature suggestions only, and goes to MatchMaker\'s developer — not this ' +
      'server\'s mods. For gameplay help or account issues, check #how-to-use or tag a mod instead.'
    )
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker' });
}

function buildSuggestionButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('suggestion_open')
      .setLabel('Submit Suggestion')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('💡'),
  );
}

// ── ROLES ──────────────────────────────────────────────────────────────────
// Extracted from index.js's former postRolesEmbed — content unchanged, just split into an
// embed builder and a components builder so /matchmaker-setup can post them without depending
// on index.js's interaction-handling module.

function buildRolesEmbed() {
  return new EmbedBuilder()
    .setTitle('🎮 Set Up Your Profile')
    .setDescription('Use the menus below to customise your MatchMaker profile.\n\n**Region is mandatory** — everything else is optional.')
    .setColor(0x1E3A5F)
    .setFooter({ text: 'MatchMaker • Complete your profile to queue' });
}

function buildRolesComponents() {
  const regionMenu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_region')
      .setPlaceholder('🌍 Select your primary region (mandatory)')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('EU — Europe').setValue('EU').setEmoji('🇪🇺'),
        new StringSelectMenuOptionBuilder().setLabel('NA Central').setValue('NAC').setEmoji('🌎'),
        new StringSelectMenuOptionBuilder().setLabel('Middle East').setValue('ME').setEmoji('🌍'),
      )
  );

  const extraRegionMenu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_extra_regions')
      .setPlaceholder('🌐 Additional regions (optional)')
      .setMinValues(0)
      .setMaxValues(2)
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('EU — Europe').setValue('EU').setEmoji('🇪🇺'),
        new StringSelectMenuOptionBuilder().setLabel('NA Central').setValue('NAC').setEmoji('🌎'),
        new StringSelectMenuOptionBuilder().setLabel('Middle East').setValue('ME').setEmoji('🌍'),
      )
  );

  const ingameRoleMenu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_ingame_role')
      .setPlaceholder('🎯 In-game role (optional, pick multiple)')
      .setMinValues(0)
      .setMaxValues(3)
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Fragger').setValue('Fragger').setEmoji('💥'),
        new StringSelectMenuOptionBuilder().setLabel('IGL (In-Game Leader)').setValue('IGL').setEmoji('🧠'),
        new StringSelectMenuOptionBuilder().setLabel('Support').setValue('Support').setEmoji('🛡️'),
      )
  );

  const languageMenu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_language')
      .setPlaceholder('🗣️ Language(s) (optional, pick up to 4)')
      .setMinValues(0)
      .setMaxValues(4)
      .addOptions(LANGUAGE_OPTIONS.map(l => new StringSelectMenuOptionBuilder().setLabel(l).setValue(l)))
  );

  const ageBracketMenu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_age_bracket')
      .setPlaceholder('🔞 Age bracket (optional)')
      .setMinValues(0)
      .setMaxValues(1)
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('13-14').setValue('13-14'),
        new StringSelectMenuOptionBuilder().setLabel('15-16').setValue('15-16'),
        new StringSelectMenuOptionBuilder().setLabel('16+').setValue('16+'),
      )
  );

  // 5 select rows fills Discord's 5-action-row-per-message cap — the bio button (a button, which
  // can't share a row with a select menu) has to go in a second message, see buildBioButtonRow().
  return [regionMenu, extraRegionMenu, ingameRoleMenu, languageMenu, ageBracketMenu];
}

function buildBioButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('set_bio')
      .setLabel('✏️ Set Bio (optional)')
      .setStyle(ButtonStyle.Secondary)
  );
}

// ── REGISTER ───────────────────────────────────────────────────────────────

function buildRegisterEmbed(getRolesChannelId) {
  return new EmbedBuilder()
    .setTitle('📋 Get Started')
    .setDescription(
      '• 🔗 Click **Link Epic Account** below to link your Epic account\n' +
      `• ✅ Once linked, go to ${getRolesChannelId ? `<#${getRolesChannelId}>` : '#get-roles'} to complete your profile\n` +
      '• 🎮 Then you can queue in tournament and creative channels'
    )
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker' });
}

// Opens the Epic OAuth flow — index.js's epic_link_open handler replies (ephemeral) with an
// authorize URL wrapped in buildEpicAuthorizeLinkRow below.
function buildEpicLinkButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('epic_link_open')
      .setLabel('Link Epic Account')
      .setEmoji('🔗')
      .setStyle(ButtonStyle.Primary)
  );
}

// A Link-style button (like buildAccessSubscribeButtons' Stripe checkout buttons below) opens the
// URL directly on click — no interaction ever reaches the bot for this one, unlike the button
// above, so there's nothing to handle in index.js for it.
function buildEpicAuthorizeLinkRow(url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Continue to Epic Games')
      .setStyle(ButtonStyle.Link)
      .setURL(url)
  );
}

// Reply payload for every queue-join gate (tournament, creative 1v1/2v2, creative 6s/8s) once
// players.js's isEpicLinked comes back false — reuses the exact same Epic OAuth flow #register's
// Link Epic Account button uses (epic-oauth.js), just built directly here instead of round-
// tripping through the epic_link_open button handler, since this fires from queue channels, not
// #register itself. Built once here (not duplicated per call site) so the messaging and OAuth
// behavior can never drift between queue types.
function buildEpicLinkRequiredReply(guildId, discordId) {
  if (!epicOAuth.isConfigured()) {
    return { content: '❌ You need to link your Epic account before queueing, but Epic account linking isn\'t set up for this bot yet — contact a mod.' };
  }
  const url = epicOAuth.buildAuthorizeUrl(discordId, guildId);
  return {
    content: '🔗 You need to link your Epic account before queueing. Click below to get started — this link expires in 10 minutes.',
    components: [buildEpicAuthorizeLinkRow(url)],
  };
}

// ── WELCOME DM ─────────────────────────────────────────────────────────────

function buildWelcomeDmEmbed(guildName) {
  return new EmbedBuilder()
    .setTitle('👋 Thanks for adding MatchMaker!')
    .setDescription(
      `Before your members can use MatchMaker in **${guildName}**, one setup step:\n\n` +
      '**1.** Run `/matchmaker-setup` as a server admin — this creates all the roles, categories, ' +
      'channels, and starter embeds MatchMaker needs, including a verified role that\'s assigned ' +
      'automatically when a member links their Epic account (new members only see #register until ' +
      'they have it, then #get-roles/#how-to-use/#access unlock automatically).\n\n' +
      'That\'s it — MatchMaker will be fully live for your server after that.'
    )
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker' });
}

// ── ACCESS / SUBSCRIPTIONS ────────────────────────────────────────────────
// Discord-ID-based access system (access.js/billing.js/notifications.js) — a 7-day free trial,
// then an escalating-cost credit-day ladder funded only by creative-queue play, then a paid
// Stripe subscription. Global per Discord ID, independent of any single server.

const ACCESS_COLOR = 0x4A90D9;
const ACCESS_DENIED_COLOR = 0xE74C3C;
const ACCESS_ACTIVE_COLOR = 0x2E7D32;

function buildAccessChannelEmbed() {
  return new EmbedBuilder()
    .setTitle('🔐 MatchMaker Access')
    .setDescription(
      '7 day free trial on signup. Complete creative matches during your trial to earn credits — once the trial ' +
      'ends, spend them here (one day at a time, use them within 7 days or lose them) to keep playing, or ' +
      'subscribe for unlimited access.'
    )
    .setColor(ACCESS_COLOR)
    // Billing/payment issues (charged but no access, subscription not reflecting, etc.) aren't
    // something a server's own mod team can fix — unlike gameplay questions (buildHowtoEmbed's
    // "Tag a mod"), this is the one player-facing embed where the developer contact genuinely
    // belongs, since it's the one player-facing surface tied to real money.
    .setFooter({ text: 'MatchMaker • Billing issue? personalediting2@gmail.com' });
}

function buildAccessChannelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('access_check')
      .setLabel('Check My Access')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔍'),
    new ButtonBuilder()
      .setCustomId('access_refresh_stats')
      .setLabel('Refresh Stats')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔄'),
  );
}

// Attached to both the ephemeral "Check My Access" status message and the "no access" blocking
// embed shown at every gating point — one handler in index.js serves both, since clicking either
// button does the same thing (generate a checkout session for the clicking user).
function buildAccessSubscribeButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('access_subscribe_monthly')
      .setLabel('Subscribe Monthly — £2.99')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('access_subscribe_yearly')
      .setLabel('Subscribe Yearly — £28.99')
      .setStyle(ButtonStyle.Success),
  );
}

// Shown alongside buildAccessSubscribeButtons whenever getAccessStatus().kind is
// 'credits_active_can_buy' — the only way left to spend a credit-day (checkAccess no longer
// auto-spends, see access.js).
function buildUseCreditsButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('access_use_credits')
      .setLabel('Use Credits for Today')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('💳'),
  );
}

// status comes from access.js's getAccessStatus() — shape varies by status.kind.
function buildAccessStatusEmbed(status) {
  const embed = new EmbedBuilder().setFooter({ text: 'MatchMaker' }).setTimestamp();

  if (status.kind === 'free_access_mode') {
    return embed
      .setTitle('🎉 Free Access')
      .setColor(ACCESS_ACTIVE_COLOR)
      .setDescription('MatchMaker is free for everyone right now — no trial, credits, or subscription needed to queue.');
  }

  if (status.kind === 'subscription') {
    const expiryTs = Math.floor(new Date(status.subscriptionExpiry).getTime() / 1000);
    const planLabel = status.plan === 'yearly' ? 'Yearly' : 'Monthly';
    // trialDaysRemaining is only set when the player subscribed while still inside their trial —
    // shown as a separate bonus line so it's clear their payment went through AND their remaining
    // trial days still count (for free) before subscription billing effectively "kicks in".
    const trialBonusLine = status.trialDaysRemaining != null
      ? `\n\n🎁 **Trial bonus:** ${status.trialDaysRemaining} day(s) remaining (free)`
      : '';
    return embed
      .setTitle('✅ Subscribed')
      .setColor(ACCESS_ACTIVE_COLOR)
      .setDescription(
        `**Plan:** ${planLabel}\n` +
        `**Status:** ${status.subscriptionStatus === 'cancelled' ? 'Cancelled — access continues until it expires' : 'Active'}\n` +
        `**Subscribed ✅ — active until:** <t:${expiryTs}:D>` +
        trialBonusLine
      );
  }

  if (status.kind === 'trial') {
    return embed
      .setTitle('✅ Free Trial Active')
      .setColor(ACCESS_ACTIVE_COLOR)
      .setDescription(
        `**Days remaining:** ${status.trialDaysRemaining}\n` +
        `**Credits banked:** ${status.creditsEarned} — play creative matches now to fund extra days once your trial ends!`
      );
  }

  if (status.kind === 'new') {
    return embed
      .setTitle('👋 No Access Yet')
      .setColor(ACCESS_COLOR)
      .setDescription('Click Queue on any tournament or creative channel to start your 7-day free trial.');
  }

  if (status.kind === 'credits_active_already_bought_today') {
    return embed
      .setTitle('✅ Access Active Today')
      .setColor(ACCESS_ACTIVE_COLOR)
      .setDescription(
        `You already have access today (until **midnight UTC**).\n\n` +
        `**Credits remaining:** ${status.creditsEarned}\n` +
        `**Days left in your credit window:** ${status.daysLeftInWindow}\n\n` +
        'Come back tomorrow to spend more credits and extend again.'
      );
  }

  if (status.kind === 'credits_active_can_buy') {
    return embed
      .setTitle('💳 Credits Available')
      .setColor(ACCESS_ACTIVE_COLOR)
      .setDescription(
        `**Credits you have:** ${status.creditsEarned}\n` +
        `**Cost for today's access:** ${status.nextRungCost}\n` +
        `**Days left in your credit window:** ${status.daysLeftInWindow}\n\n` +
        'Click **Use Credits for Today** below to spend them and unlock access until midnight UTC.'
      );
  }

  // 'no_access' — credit window expired, or no credits usable (none left, or not enough for the
  // next rung), no subscription.
  return embed
    .setTitle('❌ No Access')
    .setColor(ACCESS_DENIED_COLOR)
    .setDescription('Your credits have expired or run out — subscribe to continue.');
}

// accessResult comes from access.js's checkAccess() when allowed is false — shown at every
// gating point (queue_duo/lf2, creative_queue_*, team_queue_*).
function buildNoAccessEmbed(accessResult) {
  const embed = new EmbedBuilder()
    .setTitle('❌ Access Required')
    .setColor(ACCESS_DENIED_COLOR)
    .setFooter({ text: 'MatchMaker • Check #access for your full status' });

  if (accessResult.reason === 'post_trial_no_access') {
    embed.setDescription(
      accessResult.creditsAvailable > 0
        ? `Your free trial has ended. You have **${accessResult.creditsAvailable}** credits available. ` +
          'Visit #access to use them and extend your access.'
        : 'Your free trial has ended and you have no credits. Visit #access to subscribe.'
    );
  } else {
    embed.setDescription('You need an active trial, credits, or subscription to queue. Subscribe below for unlimited access.');
  }

  return embed;
}

function buildCreditWindowStartedDmEmbed(creditsEarned, estimatedDays) {
  return new EmbedBuilder()
    .setTitle('⌛ Your Free Trial Has Ended')
    .setDescription(
      `Your free trial has ended. You have **${creditsEarned}** credits, which can buy you up to **${estimatedDays}** ` +
      'day(s) of access. Visit #access to use them. You have **7 days** before they expire.'
    )
    .setColor(ACCESS_DENIED_COLOR)
    .setFooter({ text: 'MatchMaker' })
    .setTimestamp();
}

// Sent at noon UTC to anyone whose credit-bought access expires at midnight that same night.
function buildMidnightReminderDmEmbed() {
  return new EmbedBuilder()
    .setTitle('⏰ Your Access Expires at Midnight')
    .setDescription(
      'Your credit-bought access expires at **midnight UTC tonight**. Visit #access tomorrow to spend more credits ' +
      'and extend it another day.'
    )
    .setColor(ACCESS_COLOR)
    .setFooter({ text: 'MatchMaker' })
    .setTimestamp();
}

function buildCreditWindowExpiryWarningDmEmbed(creditsEarned) {
  return new EmbedBuilder()
    .setTitle('⚠️ Your Credits Expire Soon')
    .setDescription(
      `You have **24 hours** left to use your remaining **${creditsEarned}** credits before they expire forever. ` +
      'Visit #access now.'
    )
    .setColor(ACCESS_DENIED_COLOR)
    .setFooter({ text: 'MatchMaker' })
    .setTimestamp();
}

function buildCreditWindowExpiredDmEmbed() {
  return new EmbedBuilder()
    .setTitle('⌛ Your Credit Window Has Expired')
    .setDescription(
      'Your credit window has expired and your remaining credits have been forfeited. Subscribe at £2.99/month to continue.'
    )
    .setColor(ACCESS_DENIED_COLOR)
    .setFooter({ text: 'MatchMaker' })
    .setTimestamp();
}

function buildSubscriptionExpiredDmEmbed() {
  return new EmbedBuilder()
    .setTitle('⌛ Your Subscription Has Expired')
    .setDescription(
      'Your subscription has expired. Resubscribe below to continue, or check #access in your server for full details.'
    )
    .setColor(ACCESS_DENIED_COLOR)
    .setFooter({ text: 'MatchMaker' })
    .setTimestamp();
}

function buildTrialExpiringSoonDmEmbed(hoursRemaining) {
  return new EmbedBuilder()
    .setTitle('⏳ Your Free Trial Is Ending Soon')
    .setDescription(
      `Your free trial ends in about **${hoursRemaining} hour(s)**. Play a creative match or two now to bank credits ` +
      'for after it ends, or subscribe below for unlimited access.'
    )
    .setColor(ACCESS_COLOR)
    .setFooter({ text: 'MatchMaker' })
    .setTimestamp();
}

function buildPaymentFailedDmEmbed() {
  return new EmbedBuilder()
    .setTitle('⚠️ Your Payment Failed')
    .setDescription(
      'Your last subscription payment didn\'t go through. Please update your payment details with Stripe, or your ' +
      'subscription will expire at the end of the current billing period.'
    )
    .setColor(ACCESS_DENIED_COLOR)
    .setFooter({ text: 'MatchMaker' })
    .setTimestamp();
}

// monthlyUrl/yearlyUrl may individually be null if that plan's Stripe checkout-session generation
// failed at DM-send time — whichever button(s) have a real URL still show, and this returns null
// only if BOTH failed, so the DM still sends either way (see notifications.js/webhook-server.js),
// just with fewer (or zero) working link buttons.
function buildDmSubscribeButtons(monthlyUrl, yearlyUrl) {
  const buttons = [];
  if (monthlyUrl) {
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(monthlyUrl).setLabel('Subscribe Monthly — £2.99'));
  }
  if (yearlyUrl) {
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(yearlyUrl).setLabel('Subscribe Yearly — £28.99'));
  }
  if (buttons.length === 0) return null;
  return new ActionRowBuilder().addComponents(...buttons);
}

// ── MOD DEBUG COMMANDS ──────────────────────────────────────────────────────

function buildBotStatusEmbed({ uptimeMs, mongoConnected, epicOAuthConfigured, activeQueues, activeMatches }) {
  return new EmbedBuilder()
    .setTitle('🛠️ Bot Status')
    .setColor(mongoConnected && epicOAuthConfigured ? 0x2ECC71 : 0xE67E22)
    .addFields(
      { name: '⏱️ Uptime', value: formatDuration(uptimeMs), inline: true },
      { name: '🗄️ MongoDB', value: mongoConnected ? '✅ Connected' : '❌ Not connected', inline: true },
      { name: '🔗 Epic OAuth', value: epicOAuthConfigured ? '✅ Configured' : '❌ Not configured', inline: true },
      { name: '🎮 Active Queues', value: `**${activeQueues}**`, inline: true },
      { name: '⚔️ Active Matches', value: `**${activeMatches}**`, inline: true },
    )
    .setFooter({ text: 'MatchMaker' })
    .setTimestamp();
}

// tournamentEntries/creativeEntries/teamEntries: [{ label, count }] — already-formatted
// "Tournament / Region" or "Mode / Region" strings, grouped into sections by the caller
// (index.js) since it's the one that knows which queue system each entry came from.
function buildQueueStatusEmbed({ tournamentEntries, creativeEntries, teamEntries }) {
  const embed = new EmbedBuilder()
    .setTitle('📋 Queue Status')
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker' })
    .setTimestamp();

  const formatSection = entries => entries.length > 0
    ? entries.map(e => `**${e.label}** — ${e.count} player(s)`).join('\n')
    : '*No active queues*';

  embed.addFields(
    { name: '🏆 Tournament Queues', value: formatSection(tournamentEntries) },
    { name: '🎯 Creative 1v1/2v2', value: formatSection(creativeEntries) },
    { name: '👥 Creative 6s/8s', value: formatSection(teamEntries) },
  );

  return embed;
}

// accessStatus comes straight from access.js's getAccessStatus(discordId) — access is global
// per Discord ID, not guild-scoped, same as everywhere else it's read.
function formatAccessSummary(status) {
  // A subscribed player can still be mid-trial (status.trialDaysRemaining set on the
  // 'subscription' kind) — treat that the same as kind === 'trial' rather than reporting "Ended".
  const trialStatus = status.kind === 'trial' || status.trialDaysRemaining != null
    ? `Active — ${status.trialDaysRemaining} day(s) left`
    : status.kind === 'new'
      ? 'Not started'
      : 'Ended';

  const credits = status.creditsEarned != null ? `${status.creditsEarned} earned` : '0';

  const subscriptionStatus = status.kind === 'subscription'
    ? `${status.subscriptionStatus === 'cancelled' ? 'Cancelled (access continues)' : 'Active'} — ${status.plan ?? 'unknown plan'}`
    : 'None';

  return { trialStatus, credits, subscriptionStatus };
}

function buildPlayerLookupEmbed(discordUser, playerDoc, accessStatus) {
  const embed = new EmbedBuilder()
    .setTitle(`🔍 Player Lookup — ${discordUser.username}`)
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker' })
    .setTimestamp();

  if (playerDoc) {
    embed.addFields(
      { name: '🎮 Epic Username', value: playerDoc.epicUsername ?? 'Unknown', inline: true },
      { name: '📍 Region', value: playerDoc.region ?? 'Unknown', inline: true },
      { name: '🖥️ Platform', value: playerDoc.platform ?? 'Unknown', inline: true },
      { name: '⚡ Total PR', value: `${playerDoc.totalPR ?? 'N/A'}`, inline: true },
      { name: '📅 This Season PR', value: `${playerDoc.thisSeasonPR ?? 'N/A'}`, inline: true },
      { name: '🕐 Stats Age', value: playerDoc.lastUpdated ? `<t:${Math.floor(new Date(playerDoc.lastUpdated).getTime() / 1000)}:R>` : 'Never scraped', inline: true },
    );
  } else {
    embed.setDescription('No stored stats for this player in this server — they haven\'t queued yet.');
  }

  const { trialStatus, credits, subscriptionStatus } = formatAccessSummary(accessStatus);
  embed.addFields(
    { name: '🎟️ Trial Status', value: trialStatus, inline: true },
    { name: '💳 Credits', value: credits, inline: true },
    { name: '💎 Subscription', value: subscriptionStatus, inline: true },
  );

  return embed;
}

module.exports = {
  buildTournamentEmbed,
  buildQueueButtons,
  buildLeaveQueueButton,
  RANK_TIERS,
  rankTierByKey,
  rankedCupPoolName,
  buildRankedCupTournamentEmbed,
  buildRankedCupQueueButtons,
  buildTournamentApprovalEmbed,
  buildTournamentApprovalButtons,
  buildBuildModeSelectRow,
  buildChannelDeletionUndoEmbed,
  buildChannelDeletionUndoButton,
  buildRestoreChannelListEmbed,
  buildRestoreChannelButtons,
  buildSuggestionsChannelEmbed,
  buildSuggestionButtonRow,
  buildMatchCard,
  buildCrossServerPlayerCard,
  mentionOrCrossServerName,
  buildMatchButtons,
  buildMatchConfirmedEmbed,
  buildUserSelectRow,
  buildTeamBringCountSelectRow,
  buildTeamMemberUserSelectRow,
  buildTeamInviteEmbed,
  buildTeamInviteButtons,
  buildTeamFormingEmbed,
  buildTeamFormingButtons,
  buildCreativeComingSoonEmbed,
  buildCreativeQueueEmbed,
  buildCreativeQueueComponents,
  buildCreativeMatchCard,
  buildCreativeMatchConfirmedEmbed,
  buildCloseChannelButton,
  buildVoteKickOpenButtonRow,
  buildReadyCheckEmbed,
  buildReadyButton,
  buildTeamMethodVoteEmbed,
  buildTeamMethodVoteButtons,
  buildTeamChoiceEmbed,
  buildTeamChoiceButtons,
  buildTeamsAnnouncementEmbed,
  buildVoteKickEmbed,
  buildVoteKickButtons,
  buildFeedbackRatingButtons,
  buildFeedbackNotGreatReasonButtons,
  buildRejectReasonButtons,
  buildPostMatchOutcomeEmbed,
  buildPostMatchOutcomeButtons,
  buildPostMatchDifficultyButtons,
  buildHowtoEmbed,
  buildSetupInstructionsEmbed,
  buildRolesEmbed,
  buildRolesComponents,
  buildBioButtonRow,
  buildRegisterEmbed,
  buildEpicLinkButtonRow,
  buildEpicAuthorizeLinkRow,
  buildEpicLinkRequiredReply,
  buildWelcomeDmEmbed,
  buildAccessChannelEmbed,
  buildAccessChannelButtons,
  buildAccessSubscribeButtons,
  buildUseCreditsButton,
  buildAccessStatusEmbed,
  buildNoAccessEmbed,
  buildTrialExpiringSoonDmEmbed,
  buildCreditWindowStartedDmEmbed,
  buildMidnightReminderDmEmbed,
  buildCreditWindowExpiryWarningDmEmbed,
  buildCreditWindowExpiredDmEmbed,
  buildPaymentFailedDmEmbed,
  buildSubscriptionExpiredDmEmbed,
  buildDmSubscribeButtons,
  buildBotStatusEmbed,
  buildQueueStatusEmbed,
  buildPlayerLookupEmbed,
};