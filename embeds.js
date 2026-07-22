// embeds.js - Discord embed and button builders

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');
const config = require('./config');
const { MODES, REGIONS } = require('./creative-queue');

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
// its plain, timer-less appearance.
function buildTournamentEmbed(tournamentName, region, queueCount, isTrios = false, beginTime = null, endTime = null) {
  let color = COLOR_DEFAULT;
  let statusText = null;

  if (beginTime) {
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

  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${tournamentName}`)
    .setDescription(`**Region:** ${region}\n\nQueue up to find a teammate for this tournament.`)
    .setColor(color)
    .addFields(
      ...(statusText ? [{ name: '⏱️ Status', value: statusText }] : []),
      { name: '🟢 Players Queuing', value: `**${queueCount}**`, inline: true },
      { name: '📍 Region', value: region, inline: true },
      { name: '🎮 Format', value: isTrios ? 'Trios' : 'Duos', inline: true },
    )
    .setFooter({ text: 'MatchMaker' })
    .setTimestamp();

  return embed;
}

function buildQueueButtons(isTrios = false) {
  const row = new ActionRowBuilder();

  if (isTrios) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('queue_lf1')
        .setLabel('Looking for 1')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🔍'),
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

function buildLeaveQueueButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('leave_queue')
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
    .setDescription('You have been matched! Add each other in-game and good luck! 🏆')
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

function buildPartyInviteEmbed(leaderUsername, invitedUsername) {
  return new EmbedBuilder()
    .setTitle('🤝 Party Invite')
    .setDescription(
      `**${leaderUsername}** has invited **${invitedUsername}** to join their party.\n\n` +
      `If accepted, you'll queue together as a unit — for a trios tournament, or 6s/8s creative queue.`
    )
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker • Invite expires in 5 minutes' })
    .setTimestamp();
}

function buildPartyInviteButtons(inviteId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`party_accept_${inviteId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`party_decline_${inviteId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );
}

function buildPartyStatusEmbed(party) {
  return new EmbedBuilder()
    .setTitle('🤝 Your Party')
    .setColor(0x4A90D9)
    .addFields(
      party.members.map(m => ({
        name: m.discordId === party.leaderId ? 'Leader' : 'Member',
        value: `<@${m.discordId}>`,
        inline: true,
      }))
    )
    .setFooter({ text: `MatchMaker • ${party.members.length}/${5} members • Leader queues with "Looking for N" or the 6s/8s creative queue` })
    .setTimestamp();
}

function buildFormPartyInstructionsEmbed() {
  return new EmbedBuilder()
    .setTitle('🤝 How to Form a Party')
    .setDescription(
      '• Use `/party-invite @user` to invite a teammate — repeat to grow your party up to **5** members\n' +
      '• 🔒 Accept/Decline buttons appear in a **private channel** shared by the party\n' +
      '• 👤 One party at a time — `/party-leave` to disband before forming a new one'
    )
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker' });
}

function buildPartyChannelInstructionsEmbed() {
  return new EmbedBuilder()
    .setTitle('✅ Party Formed!')
    .setDescription(
      '• 🎮 Trios: leader goes to a **trios** tournament channel and clicks **Looking for 1** (party of exactly 2 required)\n' +
      '• 🎮 6s/8s: leader clicks **Queue** in the creative 6s/8s channel — the bot fills any remaining slots automatically\n' +
      '• 🚪 `/party-leave` — disband the party\n' +
      '• ℹ️ `/party-status` — check your party info'
    )
    .setColor(0x2E7D32)
    .setFooter({ text: 'MatchMaker' });
}

// ── CREATIVE QUEUE ────────────────────────────────────────────────────────────

const CREATIVE_COLOR = 0x9B59B6;

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
    .setFooter({ text: 'MatchMaker Creative' })
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

  return new EmbedBuilder()
    .setTitle(`${platformIcon} ${player.epicUsername}`)
    .setDescription(`**Discord:** ${player.discordUsername}`)
    .setColor(CREATIVE_COLOR)
    .addFields(
      { name: '⚡ Total PR', value: `**${player.totalPR}**`, inline: true },
      { name: '🌍 Region', value: `${flag} ${player.region}`, inline: true },
      { name: '🎮 Platform', value: player.platform, inline: true },
    )
    .setFooter({ text: `${player.mode} • MatchMaker Creative` })
    .setTimestamp();
}

function buildCreativeMatchConfirmedEmbed(players, mode) {
  return new EmbedBuilder()
    .setTitle('🎮 Creative Match Found!')
    .setDescription(`**${mode}**\n\nShare your in-game details below and good luck! 🏆`)
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
      '**Parties (Trios/6s/8s only)**\n' +
      '• Go to #form-party and use `/party-invite @friend`\n' +
      '• Once accepted, leader queues in the tournament or creative channel\n\n' +
      'Need help? Tag a mod.'
    )
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker' });
}

// ── ADMIN SETUP ────────────────────────────────────────────────────────────
// #setup is mod-role-only (see permissions.js's enforceModOnlyChannels) — this is admin/mod
// onboarding, never shown to regular members.

function buildSetupInstructionsEmbed() {
  return new EmbedBuilder()
    .setTitle('🛠️ Admin Setup')
    .setDescription(
      '• Run `/matchmaker-setup` and enter your Yunite API token\n' +
      '• Go to Yunite dashboard → Fortnite Registration → Post verification message → select #register\n' +
      '• Assign **MatchMaker Mod** role to your mod team in Server Settings → Roles\n' +
      '• That\'s it — everything else is automatic\n' +
      '• Tournament channels appear automatically 48hrs before each tournament\n' +
      '• For help: personalediting2@gmail.com'
    )
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker' });
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
      '• 🔗 Link your Epic account using **Yunite** in this channel\n' +
      `• ✅ Once linked, go to ${getRolesChannelId ? `<#${getRolesChannelId}>` : '#get-roles'} to complete your profile\n` +
      '• 🎮 Then you can queue in tournament and creative channels'
    )
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker' });
}

// ── WELCOME DM ─────────────────────────────────────────────────────────────

function buildWelcomeDmEmbed(guildName) {
  return new EmbedBuilder()
    .setTitle('👋 Thanks for adding MatchMaker!')
    .setDescription(
      `Before your members can use MatchMaker in **${guildName}**, a couple of setup steps:\n\n` +
      '**1.** Install Yunite (yunite.xyz) in your server, if you haven\'t already.\n' +
      '**2.** Authorize the MatchMaker app on Yunite for your server — this lets MatchMaker look up ' +
      'linked Epic accounts.\n' +
      '**3.** (Optional but recommended) In Yunite\'s own dashboard, set it to auto-assign a role ' +
      'when a member links their Epic account — new members only see #register until they have it, ' +
      'then #get-roles/#how-to-use unlock automatically.\n' +
      '**4.** Run `/matchmaker-setup` as a server admin — this creates all the roles, categories, ' +
      'channels, and starter embeds MatchMaker needs, asks for your Yunite API token, and (if you did ' +
      'step 3) which role Yunite assigns on verification.\n\n' +
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
    .setFooter({ text: 'MatchMaker' });
}

function buildAccessChannelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('access_check')
      .setLabel('Check My Access')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔍'),
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
      .setLabel('Subscribe Yearly — £29.99')
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

  if (status.kind === 'subscription') {
    const expiryTs = Math.floor(new Date(status.subscriptionExpiry).getTime() / 1000);
    const planLabel = status.plan === 'yearly' ? 'Yearly' : 'Monthly';
    return embed
      .setTitle('✅ Subscribed')
      .setColor(ACCESS_ACTIVE_COLOR)
      .setDescription(
        `**Plan:** ${planLabel}\n` +
        `**Status:** ${status.subscriptionStatus === 'cancelled' ? 'Cancelled — access continues until it expires' : 'Active'}\n` +
        `**Access until:** <t:${expiryTs}:D>`
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
// gating point (queue_duo/lf2/lf1, creative_queue_*, team_queue_*).
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
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(yearlyUrl).setLabel('Subscribe Yearly — £29.99'));
  }
  if (buttons.length === 0) return null;
  return new ActionRowBuilder().addComponents(...buttons);
}

// ── MOD DEBUG COMMANDS ──────────────────────────────────────────────────────

function buildBotStatusEmbed({ uptimeMs, mongoConnected, yuniteReachable, activeQueues, activeMatches, activeParties }) {
  return new EmbedBuilder()
    .setTitle('🛠️ Bot Status')
    .setColor(mongoConnected && yuniteReachable ? 0x2ECC71 : 0xE67E22)
    .addFields(
      { name: '⏱️ Uptime', value: formatDuration(uptimeMs), inline: true },
      { name: '🗄️ MongoDB', value: mongoConnected ? '✅ Connected' : '❌ Not connected', inline: true },
      { name: '🔗 Yunite API', value: yuniteReachable ? '✅ Reachable' : '❌ Unreachable', inline: true },
      { name: '🎮 Active Queues', value: `**${activeQueues}**`, inline: true },
      { name: '⚔️ Active Matches', value: `**${activeMatches}**`, inline: true },
      { name: '🤝 Active Parties', value: `**${activeParties}**`, inline: true },
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
  const trialStatus = status.kind === 'trial'
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
  buildMatchCard,
  buildCrossServerPlayerCard,
  mentionOrCrossServerName,
  buildMatchButtons,
  buildMatchConfirmedEmbed,
  buildPartyInviteEmbed,
  buildPartyInviteButtons,
  buildPartyStatusEmbed,
  buildFormPartyInstructionsEmbed,
  buildPartyChannelInstructionsEmbed,
  buildCreativeQueueEmbed,
  buildCreativeQueueComponents,
  buildCreativeMatchCard,
  buildCreativeMatchConfirmedEmbed,
  buildCloseChannelButton,
  buildReadyCheckEmbed,
  buildReadyButton,
  buildTeamMethodVoteEmbed,
  buildTeamMethodVoteButtons,
  buildTeamChoiceEmbed,
  buildTeamChoiceButtons,
  buildTeamsAnnouncementEmbed,
  buildVoteKickEmbed,
  buildVoteKickButtons,
  buildHowtoEmbed,
  buildSetupInstructionsEmbed,
  buildRolesEmbed,
  buildRolesComponents,
  buildBioButtonRow,
  buildRegisterEmbed,
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