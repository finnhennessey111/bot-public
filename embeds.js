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

    if (msUntilStart > 0) {
      color = COLOR_UPCOMING;
      statusText = `⏰ Starts in ${formatDuration(msUntilStart)}`;
    } else {
      const msUntilEnd = endTime ? new Date(endTime).getTime() - now : null;
      if (msUntilEnd !== null && msUntilEnd <= ENDING_SOON_THRESHOLD_MS) {
        color = COLOR_ENDING_SOON;
        statusText = `🔴 Ending soon — ${formatDuration(msUntilEnd)} remaining`;
      } else {
        color = COLOR_LIVE;
        statusText = `🟠 Tournament in progress — started ${formatDuration(now - startMs)} ago`;
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

function buildMatchCard(player, tournamentName) {
  const tournamentEvents = player.recentEvents.filter(e => e.name === tournamentName);

  // Last 3 placements for this specific tournament
  const recentPlacements = tournamentEvents.slice(0, 3);
  const placementsText = recentPlacements.length > 0
    ? recentPlacements.map(formatPlacementLine).join('\n')
    : 'No recent placements in this tournament';

  // Best (lowest-numbered) placement across this player's full history in this tournament
  const placedEvents = tournamentEvents.filter(e => e.placement != null);
  const bestEvent = placedEvents.length > 0
    ? placedEvents.reduce((best, e) => (e.placement < best.placement ? e : best))
    : null;
  const bestPlacementText = bestEvent ? formatPlacementLine(bestEvent) : 'No placements in this tournament';

  const platformIcon = PLATFORM_ICONS[player.platform] ?? '🎮';
  const rolesText = player.ingameRoles?.length > 0
    ? player.ingameRoles.join(', ')
    : 'Not specified';
  const languageText = player.language ?? 'Not specified';
  const bioText = player.bio ?? 'No bio set';

  const slug = encodeURIComponent(player.epicUsername);
  const profileUrl = player.epicId
    ? `https://fortnitetracker.com/profile/all/${slug}/events?region=${player.homeRegion}&id=${player.epicId}`
    : `https://fortnitetracker.com/profile/all/${slug}/events`;

  const embed = new EmbedBuilder()
    .setTitle(`${platformIcon} ${player.epicUsername}`)
    .setDescription(`**Discord:** ${player.discordUsername}`)
    .setColor(0x1E3A5F)
    .addFields(
      { name: '⚡ Total PR', value: `**${player.totalPR}**`, inline: true },
      { name: '📅 This Season PR', value: `**${player.thisSeasonPR}**`, inline: true },
      { name: `📊 Last 3 Placements (${tournamentName})`, value: placementsText },
      { name: `🏆 Best Placement (${tournamentName})`, value: bestPlacementText },
      { name: '🌍 Region', value: player.homeRegion, inline: true },
      { name: '🎭 In-Game Role', value: rolesText, inline: true },
      { name: '🗣️ Language', value: languageText, inline: true },
      { name: '📝 Bio', value: bioText },
      { name: '🔗 Profile', value: `[View Profile](${profileUrl})` },
    )
    .setFooter({ text: `Queue type: ${player.queueType.toUpperCase()} • MatchMaker` })
    .setTimestamp();

  return embed;
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
      .setPlaceholder('🗣️ Language (optional)')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('English').setValue('English'),
        new StringSelectMenuOptionBuilder().setLabel('Spanish').setValue('Spanish'),
        new StringSelectMenuOptionBuilder().setLabel('French').setValue('French'),
        new StringSelectMenuOptionBuilder().setLabel('German').setValue('German'),
        new StringSelectMenuOptionBuilder().setLabel('Portuguese').setValue('Portuguese'),
        new StringSelectMenuOptionBuilder().setLabel('Turkish').setValue('Turkish'),
        new StringSelectMenuOptionBuilder().setLabel('Arabic').setValue('Arabic'),
        new StringSelectMenuOptionBuilder().setLabel('Other').setValue('Other'),
      )
  );

  const bioButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('set_bio')
      .setLabel('✏️ Set Bio (optional)')
      .setStyle(ButtonStyle.Secondary)
  );

  return [regionMenu, extraRegionMenu, ingameRoleMenu, languageMenu, bioButton];
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
      '**3.** Run `/matchmaker-setup` as a server admin — this creates all the roles, categories, ' +
      'channels, and starter embeds MatchMaker needs, and asks for your Yunite API token as part of the command.\n\n' +
      'That\'s it — MatchMaker will be fully live for your server after that.'
    )
    .setColor(0x4A90D9)
    .setFooter({ text: 'MatchMaker' });
}

module.exports = {
  buildTournamentEmbed,
  buildQueueButtons,
  buildLeaveQueueButton,
  buildMatchCard,
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
  buildRolesEmbed,
  buildRolesComponents,
  buildRegisterEmbed,
  buildWelcomeDmEmbed,
};