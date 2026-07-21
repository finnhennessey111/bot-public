// index.js - Main bot entry point

require('dotenv').config();
const {
  Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');

const {
  buildPlayer, joinQueue, removeFromQueue, removeFromQueueAnywhere,
  isInQueue, getQueueCount, startMatchSweep, matchEvents, findUnitByDiscordId,
} = require('./queue');
const {
  createMatch, acceptMatch, rejectMatch, getPendingMatchByDiscordId, getPendingMatchCount,
} = require('./matching');
// Named playerStore (not `players`) — this file uses `players` extensively as a local variable
// name for arrays of built player objects, which would otherwise shadow this module import.
const playerStore = require('./players');
const { getEpicFromDiscord, checkYuniteReachable } = require('./yunite');
const { startScheduler, checkAndCreateChannels } = require('./channel-manager');
const { enforcePermissions } = require('./permissions');
const guildConfig = require('./guild-config');
const { getRoleId, getChannelId } = guildConfig;
const { runMatchmakerSetup } = require('./matchmaker-setup');
const {
  buildTournamentEmbed, buildQueueButtons, buildLeaveQueueButton,
  buildMatchCard, buildMatchButtons, buildMatchConfirmedEmbed,
  buildPartyInviteEmbed, buildPartyInviteButtons, buildPartyStatusEmbed,
  buildFormPartyInstructionsEmbed, buildPartyChannelInstructionsEmbed,
  buildCreativeMatchConfirmedEmbed, buildCloseChannelButton, buildCreativeMatchCard,
  buildReadyCheckEmbed, buildTeamMethodVoteEmbed, buildTeamChoiceEmbed,
  buildVoteKickEmbed, buildVoteKickButtons,
  buildHowtoEmbed, buildRolesEmbed, buildRolesComponents,
  buildAccessStatusEmbed, buildAccessSubscribeButtons, buildNoAccessEmbed,
  buildBotStatusEmbed, buildQueueStatusEmbed, buildPlayerLookupEmbed,
} = require('./embeds');
const store = require('./store');
const { pinnedMessages, save: saveStore } = store;
const party = require('./party');
const {
  REGIONS: CREATIVE_REGIONS, buildCreativePlayer, joinCreativeQueue, requeueCreativeUnit,
  removeFromCreativeQueueAnywhere, findCreativeUnitByDiscordId, isInCreativeQueue,
  startCreativeMatchSweep, creativeMatchEvents, getCreativeQueueCount,
} = require('./creative-queue');
const { postCreativeQueueChannel, updateCreativeQueueEmbed } = require('./creative-channel');
const creativeTeamQueue = require('./creative-team-queue');
const teamMatchLifecycle = require('./team-match-lifecycle');
const channelLifecycle = require('./channel-lifecycle');
const credits = require('./credits');
const access = require('./access');
const billing = require('./billing');
const { startWebhookServer } = require('./webhook-server');
const { startAccessScheduler } = require('./notifications');
const { QUEUE_CHANNEL_CONFIGS, categoryForAnyMode } = require('./creative-channel-configs');
const db = require('./db');

const botStartTime = Date.now();

// Runtime gate for the mod debug commands and the setup/admin commands restricted to mods —
// a custom per-guild role (guild-config.js's roleIds.mod), not a Discord permission bit, so it
// can't be expressed via SlashCommandBuilder#setDefaultMemberPermissions.
function isModMember(guildId, interaction) {
  const modRoleId = getRoleId(guildId, 'mod');
  return !!modRoleId && !!interaction.member?.roles.cache.has(modRoleId);
}

async function replyModOnly(interaction) {
  await interaction.editReply({ content: '❌ This command is restricted to the MatchMaker Mod role.' });
}

// Non-empty queue buckets, one entry per tournament/mode+region combo currently holding at
// least one player — shared by /bot-status (just the count) and /queue-status (the full list).
function getTournamentQueueEntries(guildId) {
  const entries = [];
  const guildQueues = store.queues[guildId] ?? {};
  for (const tournamentName of Object.keys(guildQueues)) {
    for (const region of Object.keys(guildQueues[tournamentName])) {
      const count = getQueueCount(guildId, tournamentName, region);
      if (count > 0) entries.push({ label: `${tournamentName} / ${region}`, count });
    }
  }
  return entries;
}

function getCreativeQueueEntries(guildId) {
  const entries = [];
  const guildQueues = store.creativeQueues[guildId] ?? {};
  for (const mode of Object.keys(guildQueues)) {
    for (const region of Object.keys(guildQueues[mode])) {
      const count = getCreativeQueueCount(guildId, mode, region);
      if (count > 0) entries.push({ label: `${mode} / ${region}`, count });
    }
  }
  return entries;
}

function getTeamQueueEntries(guildId) {
  const entries = [];
  for (const category of ['6s', '8s']) {
    for (const mode of creativeTeamQueue.MODES[category]) {
      for (const region of CREATIVE_REGIONS) {
        const count = creativeTeamQueue.getTeamQueueWaitingCount(guildId, mode, region);
        if (count > 0) entries.push({ label: `${mode} / ${region}`, count });
      }
    }
  }
  return entries;
}

// discordId:category -> { mode, region } — pending selections from the creative queue's
// select menus, held here since Queue is a separate interaction from picking mode/region.
const creativeSelections = new Map();

// discordIds currently mid-join (stats fetch in flight) — closes the race where a double
// click on Queue passes the isInCreativeQueue check twice before the first join lands,
// ending up with two units for the same player and, in the worst case, a self-match.
const creativeJoinInProgress = new Set();
const teamJoinInProgress = new Set();

// Cross-queue exclusivity: a player can't be queued (or mid-match) in both the tournament
// system and any creative queue (1v1/2v2 or 6s/8s) at once. Pending matches are tagged by
// `kind` (matching.js) so a pending creative accept/reject doesn't count as tournament activity
// and vice versa.
function isInTournamentActivity(guildId, discordId) {
  if (findUnitByDiscordId(guildId, discordId)) return true;
  const pending = getPendingMatchByDiscordId(guildId, discordId);
  return !!pending && pending.match.kind !== 'creative';
}

function isInCreativeActivity(guildId, discordId) {
  if (isInCreativeQueue(guildId, discordId)) return true;
  if (creativeTeamQueue.isInTeamQueue(guildId, discordId)) return true;
  if (teamMatchLifecycle.isPlayerInActiveTeamMatch(guildId, discordId)) return true;
  const pending = getPendingMatchByDiscordId(guildId, discordId);
  return !!pending && pending.match.kind === 'creative';
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('clientReady', async () => {
  console.log(`✅ MatchMaker bot is online as ${client.user.tag}`);

  // client.guilds.cache is only reliably populated once the ready sequence completes, so
  // guild-config's per-guild backfill/hydration has to happen here, not before login.
  await guildConfig.init(client);

  for (const guild of client.guilds.cache.values()) {
    enforcePermissions(guild).catch(console.error);
  }

  startScheduler(client, pinnedMessages);
  startMatchSweep();
  matchEvents.on('matchFound', ({ unitA, unitB, tournamentName, region, guildId }) => {
    const guild = client.guilds.cache.get(guildId);
    if (guild) notifyMatchFound(unitA, unitB, tournamentName, region, guild).catch(console.error);
  });

  startCreativeMatchSweep();
  creativeMatchEvents.on('matchFound', ({ unitA, unitB, mode, region, guildId }) => {
    const guild = client.guilds.cache.get(guildId);
    if (guild) notifyCreativeMatchFound(unitA, unitB, mode, region, guild).catch(console.error);
  });

  creativeTeamQueue.startCreativeTeamMatchSweep();
  creativeTeamQueue.creativeTeamMatchEvents.on('matchFormed', ({ units, mode, region, guildId }) => {
    const guild = client.guilds.cache.get(guildId);
    if (guild) teamMatchLifecycle.startTeamMatch(units, mode, region, guild, client).catch(console.error);
  });

  channelLifecycle.restoreScheduledDeletions(client);
  channelLifecycle.channelLifecycleEvents.on('channelDeleted', ({ textChannelId, kind }) => {
    if (kind === 'creative-team') teamMatchLifecycle.endTeamMatch(textChannelId);
  });

  startAccessScheduler(client);
});

// Only fires for guilds joined WHILE the bot is running — guildConfig.init() (above) handles
// backfilling config for guilds already joined at startup, without sending a DM for those.
client.on('guildCreate', guild => guildConfig.handleNewGuild(guild).catch(console.error));

// ── PLATFORM HELPERS ──────────────────────────────────────────────────────────

function isConsolePlayer(guildId, member) {
  return member.roles.cache.has(getRoleId(guildId, 'Console'));
}

function isPCPlayer(guildId, member) {
  return member.roles.cache.has(getRoleId(guildId, 'PC'));
}

function getPlatformFromMember(guildId, member) {
  if (member.roles.cache.has(getRoleId(guildId, 'PC'))) return 'PC';
  if (member.roles.cache.has(getRoleId(guildId, 'Console'))) return 'Console';
  if (member.roles.cache.has(getRoleId(guildId, 'Mobile'))) return 'Mobile';
  return null;
}

// ── INTERACTION HANDLER ────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    console.error('Unhandled interactionCreate error:', err);
    await replyWithError(interaction, err).catch(console.error);
  }
});

// ── HELPER: SAFELY REPORT AN INTERACTION ERROR ────────────────────────────────
// Reply state varies depending on where in the handler the error was thrown (not yet
// replied, deferred, or already replied), so pick the method that's actually valid rather
// than assuming one — calling reply() twice, or editReply() before any reply, both throw.
async function replyWithError(interaction, err) {
  if (typeof interaction.isRepliable === 'function' && !interaction.isRepliable()) return;

  const payload = { content: '❌ Something went wrong handling that. Please try again.', flags: 64 };

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

async function handleInteraction(interaction) {

  // ── SLASH COMMANDS ───────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {

    // /setup-tournament
    if (interaction.commandName === 'setup-tournament') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);

      const tournamentName = interaction.options.getString('tournament');
      const region = interaction.options.getString('region');
      const isTrios = interaction.options.getBoolean('trios') ?? false;

      const embed = buildTournamentEmbed(tournamentName, region, 0, isTrios);
      const buttons = buildQueueButtons(isTrios);

      const msg = await interaction.channel.send({ embeds: [embed], components: [buttons] });
      await msg.pin();

      pinnedMessages[interaction.channelId] = {
        messageId: msg.id,
        guildId: interaction.guild.id,
        tournamentName,
        region,
        isTrios,
        consoleOnly: false,
      };
      saveStore(interaction.guild.id);

      await interaction.editReply({
        content: `✅ Tournament embed created for **${tournamentName}** (${region})`,
      });
    }

    // /setup-roles
    if (interaction.commandName === 'setup-roles') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);
      await interaction.channel.send({ embeds: [buildRolesEmbed()], components: buildRolesComponents() });
      await interaction.editReply({ content: '✅ Roles embed posted.' });
    }

    // /setup-party-channel
    if (interaction.commandName === 'setup-party-channel') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);
      const msg = await interaction.channel.send({ embeds: [buildFormPartyInstructionsEmbed()] });
      await msg.pin();
      await interaction.editReply({ content: '✅ Party instructions posted and pinned.' });
    }

    // /setup-creative-1v1, /setup-creative-2v2, /setup-creative-6s, /setup-creative-8s — all
    // post wherever the command is run (6s/8s used to target a fixed env-var channel; there's
    // no per-guild equivalent of that now that config lives in Mongo, so they match 1v1/2v2's
    // existing "post wherever run" behavior instead).
    if ([
      'setup-creative-1v1', 'setup-creative-2v2', 'setup-creative-6s', 'setup-creative-8s',
    ].includes(interaction.commandName)) {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);
      const category = interaction.commandName.replace('setup-creative-', '');
      await postCreativeQueueChannel(interaction.guild.id, interaction.channel, category, QUEUE_CHANNEL_CONFIGS[category]);
      await interaction.editReply({ content: `✅ Creative ${category} queue embed posted and pinned.` });
    }

    // /setup-howto — posts wherever the command is run (previously a fixed env-var channel;
    // /matchmaker-setup posts the same embed automatically into #how-to-use on first setup —
    // this command is for manually re-posting/refreshing it elsewhere).
    if (interaction.commandName === 'setup-howto') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);
      const msg = await interaction.channel.send({ embeds: [buildHowtoEmbed()] });
      await msg.pin();
      await interaction.editReply({ content: '✅ How-to embed posted and pinned.' });
    }

    // /votekick — only usable inside a private match channel (tournament "match-...", or a
    // 6s/8s team match "team-6s-.../team-8s-..." — see team-match-lifecycle.js's channel
    // naming). handleVoteKickCommand below is the authoritative check (an active team match
    // must actually exist for this channel); this is just a fast, clear rejection for anyone
    // running it somewhere obviously wrong.
    if (interaction.commandName === 'votekick') {
      await interaction.deferReply({ flags: 64 });

      const name = interaction.channel.name;
      if (!(name.startsWith('match-') || name.includes('6s-') || name.includes('8s-'))) {
        return interaction.editReply({ content: '❌ This command only works inside a private match channel.' });
      }

      const target = interaction.options.getUser('player');
      const result = teamMatchLifecycle.handleVoteKickCommand(interaction.channelId, interaction.user.id, target.id);

      if (result.status === 'not_in_match') {
        return interaction.editReply({ content: '❌ This command only works inside an active 6s/8s match channel.' });
      }
      if (result.status === 'too_early') {
        return interaction.editReply({ content: `❌ Vote-kick unlocks ${result.remaining}s after the channel was created.` });
      }
      if (result.status === 'not_participant') {
        return interaction.editReply({ content: '❌ You are not part of this match.' });
      }
      if (result.status === 'self_target') {
        return interaction.editReply({ content: '❌ You cannot vote-kick yourself.' });
      }
      if (result.status === 'target_not_in_match') {
        return interaction.editReply({ content: `❌ **${target.username}** is not part of this match.` });
      }
      if (result.status === 'already_initiated') {
        return interaction.editReply({ content: '❌ You have already started a vote-kick in this match — one per player per session.' });
      }
      if (result.status === 'vote_in_progress') {
        return interaction.editReply({ content: '❌ A vote is already in progress in this match.' });
      }
      if (result.status === 'target_cooldown') {
        return interaction.editReply({ content: `❌ A vote against **${target.username}** failed recently — try again in ${result.remaining}s.` });
      }

      await interaction.editReply({ content: `🗳️ Vote-kick started against **${target.username}**.` });

      await interaction.channel.send({
        embeds: [buildVoteKickEmbed(interaction.user.username, target.username, 0, 0, result.eligibleCount)],
        components: [buildVoteKickButtons(result.voteId)],
      });

      teamMatchLifecycle.startVoteResolutionTimer(interaction.channelId, result.voteId, interaction.guild, client, interaction.channel);
    }

    // /refresh-stats — force a rescrape of the caller's own stats, rate-limited to once/hour
    // (players.js's refreshPlayerStats) so this can't be used to hammer FT Tracker.
    if (interaction.commandName === 'refresh-stats') {
      await interaction.deferReply({ flags: 64 });

      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!member.roles.cache.has(getRoleId(interaction.guild.id, 'Registered'))) {
        return interaction.editReply({
          content: `❌ Complete your profile in <#${getChannelId(interaction.guild.id, 'getRoles')}> first (set your region).`,
        });
      }

      const userData = await playerStore.getPlayer(interaction.guild.id, interaction.user.id);
      if (!userData?.region) {
        return interaction.editReply({
          content: `❌ Set your region in <#${getChannelId(interaction.guild.id, 'getRoles')}> first.`,
        });
      }

      try {
        const { epicUsername, epicId } = await resolveEpicIdentity(interaction.guild, member);
        const result = await playerStore.refreshPlayerStats(
          interaction.guild.id, interaction.user.id, epicUsername, epicId, userData.region
        );

        if (result.limited) {
          const retryTimestamp = Math.floor(result.retryAt.getTime() / 1000);
          return interaction.editReply({
            content: `❌ You can only refresh your stats once per hour. Try again <t:${retryTimestamp}:R>.`,
          });
        }

        await interaction.editReply({
          content: `✅ Stats refreshed! Total PR: **${result.stats.totalPR}**, This Season PR: **${result.stats.thisSeasonPR}**.`,
        });
      } catch (err) {
        console.error('refresh-stats error:', err);
        await interaction.editReply({ content: `❌ Failed to refresh stats: ${err.message}` });
      }
    }

    // /cancel-tournament
    if (interaction.commandName === 'cancel-tournament') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);

      const pinned = pinnedMessages[interaction.channelId];
      if (!pinned) {
        return interaction.editReply({ content: '❌ No tournament found in this channel.' });
      }

      const { tournamentName, region } = pinned;
      const count = getQueueCount(interaction.guild.id, tournamentName, region);
      if (count > 0) {
        await interaction.channel.send(
          `⚠️ **${tournamentName}** has been cancelled. All queued players have been removed.`
        );
      }

      await interaction.editReply({ content: `✅ Tournament cancelled. Channel will be deleted in 10 seconds.` });
      delete pinnedMessages[interaction.channelId];
      saveStore(interaction.guild.id);
      setTimeout(() => interaction.channel.delete().catch(console.error), 10000);
    }

    // /check-tournaments
    if (interaction.commandName === 'check-tournaments') {
      if (!isModMember(interaction.guild.id, interaction)) {
        return interaction.reply({ content: '❌ This command is restricted to the MatchMaker Mod role.', flags: 64 });
      }
      await interaction.reply({ content: '🔍 Checking tournaments in background... check #master-tournaments shortly.', flags: 64 });
      checkAndCreateChannels(interaction.guild, pinnedMessages).catch(console.error);
    }

    // /matchmaker-setup — admin-only (see register-commands.js's setDefaultMemberPermissions).
    // Creates every role/category/channel MatchMaker needs and posts the starter embeds,
    // idempotently (safe to re-run — reuses anything already created and still present).
    if (interaction.commandName === 'matchmaker-setup') {
      await interaction.deferReply({ flags: 64 });

      const yuniteToken = interaction.options.getString('yunite-token');

      try {
        const result = await runMatchmakerSetup(interaction.guild, yuniteToken);
        await interaction.editReply({ content: result.summary });
      } catch (err) {
        console.error('matchmaker-setup failed:', err.message);
        await interaction.editReply({ content: `❌ Setup failed: ${err.message}` });
      }
    }

    // /party-invite
    if (interaction.commandName === 'party-invite') {
      await interaction.deferReply({ flags: 64 });

      if (interaction.channelId !== getChannelId(interaction.guild.id, 'formParty')) {
        return interaction.editReply({
          content: `❌ Use this command in <#${getChannelId(interaction.guild.id, 'formParty')}>.`,
        });
      }

      const invited = interaction.options.getUser('user');
      const leader = interaction.user;

      if (invited.id === leader.id) {
        return interaction.editReply({ content: '❌ You cannot invite yourself.' });
      }
      if (invited.bot) {
        return interaction.editReply({ content: '❌ You cannot invite a bot.' });
      }
      if (party.hasPendingInvite(interaction.guild.id, leader.id)) {
        return interaction.editReply({ content: '❌ You already have a pending invite out. Wait for it to resolve first.' });
      }
      if (!party.canAddMember(interaction.guild.id, leader.id)) {
        return interaction.editReply({ content: `❌ Your party is already at the ${party.MAX_PARTY_SIZE}-member cap.` });
      }
      if (party.isInParty(interaction.guild.id, invited.id) || party.hasPendingInvite(interaction.guild.id, invited.id)) {
        return interaction.editReply({ content: `❌ **${invited.username}** is already in a party or has a pending invite.` });
      }

      const existingParty = party.getPartyByDiscordId(interaction.guild.id, leader.id);
      const formPartyChannel = interaction.channel;

      let privateChannel;
      if (existingParty) {
        // Growing an existing party — invite into the party's shared channel rather than
        // spinning up a new one per invite.
        try {
          privateChannel = await client.channels.fetch(existingParty.channelId);
          await privateChannel.permissionOverwrites.edit(invited.id, { ViewChannel: true });
        } catch (err) {
          console.error('Failed to add invitee to existing party channel:', err.message);
          return interaction.editReply({ content: '❌ Failed to open the party channel to the invitee.' });
        }
      } else {
        const channelName = `party-${leader.username}-${invited.username}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .slice(0, 90);

        try {
          privateChannel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: formPartyChannel.parentId ?? null,
            permissionOverwrites: [
              { id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
              { id: leader.id, allow: [PermissionFlagsBits.ViewChannel] },
              { id: invited.id, allow: [PermissionFlagsBits.ViewChannel] },
              { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            ],
          });
        } catch (err) {
          console.error('Failed to create party channel:', err.message);
          return interaction.editReply({ content: '❌ Failed to create private party channel.' });
        }
      }

      const inviteId = party.createInvite({
        leaderId: leader.id,
        leaderUsername: leader.username,
        invitedId: invited.id,
        invitedUsername: invited.username,
        channelId: privateChannel.id,
        guildId: interaction.guild.id,
      });

      await privateChannel.send({
        content: `<@${invited.id}>`,
        embeds: [buildPartyInviteEmbed(leader.username, invited.username)],
        components: [buildPartyInviteButtons(inviteId)],
      });

      setTimeout(async () => {
        const expired = party.expireInvite(inviteId);
        if (!expired) return;
        try {
          const ch = await client.channels.fetch(expired.channelId);
          await ch.send('⌛ This party invite expired.');
          setTimeout(() => ch.delete().catch(console.error), 10000);
        } catch (err) {
          console.error('Failed to clean up expired party invite channel:', err.message);
        }
      }, 5 * 60 * 1000);

      await interaction.editReply({ content: `✅ Invite sent! Head to ${privateChannel} to continue.` });
    }

    // /party-leave
    if (interaction.commandName === 'party-leave') {
      await interaction.deferReply({ flags: 64 });

      if (interaction.channelId !== getChannelId(interaction.guild.id, 'formParty')) {
        return interaction.editReply({
          content: `❌ Use this command in <#${getChannelId(interaction.guild.id, 'formParty')}>.`,
        });
      }

      const record = party.getPartyByDiscordId(interaction.guild.id, interaction.user.id);
      if (!record) {
        return interaction.editReply({ content: '❌ You are not in a party.' });
      }

      const memberIds = record.members.map(m => m.discordId);

      // Reject any pending match first (requeues both units in that match)...
      for (const discordId of memberIds) {
        const pending = getPendingMatchByDiscordId(interaction.guild.id, discordId);
        if (pending) rejectMatch(pending.matchId, discordId);
      }
      // ...then pull the disbanding unit back out again, wherever it ended up.
      for (const discordId of memberIds) {
        removeFromQueueAnywhere(interaction.guild.id, discordId);
      }

      try {
        const ch = await client.channels.fetch(record.channelId);
        if (ch) await ch.delete();
      } catch (err) {
        console.error('Failed to delete party channel:', err.message);
      }

      party.disbandParty(record.partyId);

      await interaction.editReply({ content: '✅ Party disbanded.' });
    }

    // /party-status
    if (interaction.commandName === 'party-status') {
      await interaction.deferReply({ flags: 64 });

      if (interaction.channelId !== getChannelId(interaction.guild.id, 'formParty')) {
        return interaction.editReply({
          content: `❌ Use this command in <#${getChannelId(interaction.guild.id, 'formParty')}>.`,
        });
      }

      const record = party.getPartyByDiscordId(interaction.guild.id, interaction.user.id);
      if (!record) {
        return interaction.editReply({ content: '❌ You are not in a party. Use /party-invite to form one.' });
      }

      await interaction.editReply({ embeds: [buildPartyStatusEmbed(record)] });
    }

    // ── MOD DEBUG COMMANDS ────────────────────────────────────────────────────

    // /bot-status
    if (interaction.commandName === 'bot-status') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);

      const [mongoConnected, yuniteReachable] = await Promise.all([
        Promise.resolve(db.isConnected()),
        checkYuniteReachable(interaction.guild.id),
      ]);

      const guildId = interaction.guild.id;
      const activeQueues = getTournamentQueueEntries(guildId).length
        + getCreativeQueueEntries(guildId).length
        + getTeamQueueEntries(guildId).length;
      const activeMatches = getPendingMatchCount(guildId) + teamMatchLifecycle.getActiveTeamMatchCount(guildId);
      const activeParties = Object.values(store.parties).filter(p => p.guildId === guildId).length;

      await interaction.editReply({
        embeds: [buildBotStatusEmbed({
          uptimeMs: Date.now() - botStartTime,
          mongoConnected,
          yuniteReachable,
          activeQueues,
          activeMatches,
          activeParties,
        })],
      });
    }

    // /queue-status
    if (interaction.commandName === 'queue-status') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);

      const guildId = interaction.guild.id;
      await interaction.editReply({
        embeds: [buildQueueStatusEmbed({
          tournamentEntries: getTournamentQueueEntries(guildId),
          creativeEntries: getCreativeQueueEntries(guildId),
          teamEntries: getTeamQueueEntries(guildId),
        })],
      });
    }

    // /player-lookup
    if (interaction.commandName === 'player-lookup') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);

      const target = interaction.options.getUser('user');
      const [playerDoc, accessStatus] = await Promise.all([
        playerStore.getPlayer(interaction.guild.id, target.id),
        access.getAccessStatus(target.id),
      ]);

      await interaction.editReply({ embeds: [buildPlayerLookupEmbed(target, playerDoc, accessStatus)] });
    }

    // /clear-queue
    if (interaction.commandName === 'clear-queue') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);

      const guildId = interaction.guild.id;
      const tournamentName = interaction.options.getString('tournament');
      const guildQueues = store.queues[guildId] ?? {};
      const matchedKey = Object.keys(guildQueues).find(k => k.toLowerCase() === tournamentName.toLowerCase());

      if (!matchedKey) {
        return interaction.editReply({ content: `❌ No active queue found for "${tournamentName}".` });
      }

      let cleared = 0;
      for (const region of Object.keys(guildQueues[matchedKey])) {
        cleared += getQueueCount(guildId, matchedKey, region);
        guildQueues[matchedKey][region] = [];
      }
      saveStore(guildId);

      await interaction.editReply({ content: `✅ Cleared **${matchedKey}** — removed ${cleared} player(s) across all regions.` });
    }

    // /force-refresh
    if (interaction.commandName === 'force-refresh') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);

      const target = interaction.options.getUser('user');

      try {
        const member = await interaction.guild.members.fetch(target.id);
        const existing = await playerStore.getPlayer(interaction.guild.id, target.id);
        const { epicUsername, epicId } = await resolveEpicIdentity(interaction.guild, member);
        const region = existing?.region ?? 'EU';

        const fresh = await playerStore.forceRefreshStats(interaction.guild.id, target.id, epicUsername, epicId, region);

        await interaction.editReply({
          content: `✅ Force-refreshed **${target.username}** — Total PR: **${fresh.totalPR}**, This Season PR: **${fresh.thisSeasonPR}**.`,
        });
      } catch (err) {
        console.error('force-refresh error:', err);
        await interaction.editReply({ content: `❌ Failed to refresh stats: ${err.message}` });
      }
    }
  }

  // ── MODAL SUBMISSIONS ────────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'bio_modal') {
      const bio = interaction.fields.getTextInputValue('bio_input');
      await playerStore.upsertPlayer(interaction.guild.id, interaction.user.id, { bio });
      await interaction.reply({ content: `✅ Bio saved: "${bio}"`, flags: 64 });
    }

  }

  // ── SELECT MENUS ─────────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    await interaction.deferReply({ flags: 64 });
    const { user, customId, values, guildId } = interaction;

    if (customId === 'select_region') {
      await playerStore.upsertPlayer(guildId, user.id, { region: values[0] });
      await assignRole(interaction.guild, user.id, regionRoleId(guildId, values[0]));
      // Region is the mandatory minimum for "profile complete" — grant Registered here so
      // queue-join gates unlock as soon as this step is done, not waiting on the optional ones.
      await assignRole(interaction.guild, user.id, getRoleId(guildId, 'Registered'));
      await interaction.editReply({ content: `✅ Primary region set to **${values[0]}**.` });
    }

    if (customId === 'select_extra_regions') {
      await playerStore.upsertPlayer(guildId, user.id, { extraRegions: values });
      for (const region of values) {
        await assignRole(interaction.guild, user.id, regionRoleId(guildId, region));
      }
      await interaction.editReply({ content: `✅ Extra regions unlocked: **${values.join(', ')}**.` });
    }

    if (customId === 'select_ingame_role') {
      await playerStore.upsertPlayer(guildId, user.id, { ingameRoles: values });
      for (const role of values) {
        await assignRole(interaction.guild, user.id, ingameRoleId(guildId, role));
      }
      await interaction.editReply({ content: `✅ In-game role(s) set to: **${values.join(', ')}**.` });
    }

    if (customId === 'select_language') {
      await playerStore.upsertPlayer(guildId, user.id, { language: values[0] });
      await interaction.editReply({ content: `✅ Language set to **${values[0]}**.` });
    }

    if (customId.startsWith('creative_mode_')) {
      const category = customId.replace('creative_mode_', '');
      const key = `${guildId}:${user.id}:${category}`;
      creativeSelections.set(key, { ...creativeSelections.get(key), mode: values[0] });
      await interaction.editReply({ content: `✅ Mode set to **${values[0]}**. Now select a region, then click Queue.` });
    }

    if (customId.startsWith('creative_region_')) {
      const category = customId.replace('creative_region_', '');
      const key = `${guildId}:${user.id}:${category}`;
      creativeSelections.set(key, { ...creativeSelections.get(key), region: values[0] });
      await interaction.editReply({ content: `✅ Region set to **${values[0]}**. Now select a mode (if you haven't), then click Queue.` });
    }
  }

  // ── BUTTON INTERACTIONS ──────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const { customId, user, channelId, guild } = interaction;

    // ── BIO BUTTON ───────────────────────────────────────────────────────────
    if (customId === 'set_bio') {
      const modal = new ModalBuilder()
        .setCustomId('bio_modal')
        .setTitle('Set Your Bio');

      const bioInput = new TextInputBuilder()
        .setCustomId('bio_input')
        .setLabel('Tell teammates about yourself')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Chill vibes, evenings EU, looking to improve')
        .setMaxLength(150)
        .setRequired(false);

      modal.addComponents(new ActionRowBuilder().addComponents(bioInput));
      await interaction.showModal(modal);
    }

    // ── PARTY INVITE BUTTONS ─────────────────────────────────────────────────
    if (customId.startsWith('party_accept_')) {
      const inviteId = customId.replace('party_accept_', '');
      const invite = party.getInvite(inviteId);

      if (!invite) {
        return interaction.reply({ content: '❌ This invite is no longer active.', flags: 64 });
      }
      if (user.id !== invite.invitedId) {
        return interaction.reply({ content: '❌ Only the invited player can accept this invite.', flags: 64 });
      }

      party.acceptInvite(inviteId);

      await interaction.update({
        content: `✅ **${invite.leaderUsername}** and **${invite.invitedUsername}** are now partied up!`,
        embeds: [],
        components: [],
      });

      const instructionsMsg = await interaction.channel.send({ embeds: [buildPartyChannelInstructionsEmbed()] });
      await instructionsMsg.pin().catch(err => console.error('Failed to pin party instructions:', err.message));
    }

    if (customId.startsWith('party_decline_')) {
      const inviteId = customId.replace('party_decline_', '');
      const invite = party.getInvite(inviteId);

      if (!invite) {
        return interaction.reply({ content: '❌ This invite is no longer active.', flags: 64 });
      }
      if (user.id !== invite.invitedId && user.id !== invite.leaderId) {
        return interaction.reply({ content: '❌ You are not part of this invite.', flags: 64 });
      }

      party.declineInvite(inviteId);

      await interaction.update({
        content: '❌ Party invite declined.',
        embeds: [],
        components: [],
      });

      setTimeout(() => interaction.channel.delete().catch(console.error), 10000);
    }

    // ── SOLO QUEUE BUTTONS (duo, or trios solo "Looking for 2") ──────────────
    if (customId === 'queue_duo' || customId === 'queue_lf2') {
      await interaction.deferReply({ flags: 64 });

      const pinned = pinnedMessages[channelId];
      if (!pinned) {
        return interaction.editReply({ content: '❌ Could not find tournament info for this channel.' });
      }

      const { tournamentName, region, isTrios, consoleOnly } = pinned;
      const queueType = customId.replace('queue_', '');

      const member = await guild.members.fetch(user.id);

      if (!member.roles.cache.has(getRoleId(guild.id, 'Registered'))) {
        return interaction.editReply({
          content: `❌ Complete your profile in <#${getChannelId(guild.id, 'getRoles')}> first (set your region).`,
        });
      }

      const platform = getPlatformFromMember(guild.id, member);

      if (consoleOnly && isPCPlayer(guild.id, member)) {
        return interaction.editReply({
          content: '❌ This is a console-only tournament. PC players cannot queue here.',
        });
      }
      if (consoleOnly && !isConsolePlayer(guild.id, member)) {
        return interaction.editReply({
          content: '❌ This is a console-only tournament. You must have the Console role to queue.',
        });
      }

      if (queueType === 'lf2' && party.isInParty(guild.id, user.id)) {
        return interaction.editReply({
          content: '❌ You are in a party — ask your party leader to click "Looking for 1", or run /party-leave to queue solo.',
        });
      }

      if (isInQueue(guild.id, user.id, tournamentName, region)) {
        return interaction.editReply({
          content: '🔍 You are currently in queue. Click to leave.',
          components: [buildLeaveQueueButton()],
        });
      }

      if (isInCreativeActivity(guild.id, user.id)) {
        return interaction.editReply({ content: '❌ You are already in a creative queue or match. Leave it before queueing for a tournament.' });
      }

      const tournamentAccess = await access.checkAccess(user.id);
      if (!tournamentAccess.allowed) {
        return interaction.editReply({
          embeds: [buildNoAccessEmbed(tournamentAccess)],
          components: [buildAccessSubscribeButtons()],
        });
      }

      await interaction.editReply({ content: '⏳ Fetching your stats...' });

      try {
        const { epicUsername, epicId } = await resolveEpicIdentity(guild, member);

        const userData = await playerStore.getPlayer(guild.id, user.id);
        const homeRegion = userData?.region ?? region;

        const player = await buildPlayer({
          guildId: guild.id,
          discordId: user.id,
          discordUsername: user.username,
          epicUsername,
          epicId,
          tournamentName,
          homeRegion,
          queueRegion: region,
          queueType,
          platform,
          consoleOnly,
          ingameRoles: userData?.ingameRoles ?? [],
          language: userData?.language ?? null,
          bio: userData?.bio ?? null,
        });

        await joinQueue({ guildId: guild.id, players: [player], tournamentName, region, queueType });

        await updateQueueEmbed(guild.id, channelId, tournamentName, region, isTrios);

        await interaction.editReply({
          content: `✅ You are now in queue for **${tournamentName}**! We'll DM you the moment a match is found.`,
        });

      } catch (err) {
        console.error('Queue error:', err);
        await interaction.editReply({ content: `❌ Error joining queue: ${err.message}` });
      }
    }

    // ── PARTY QUEUE BUTTON ("Looking for 1", trios only) ──────────────────────
    if (customId === 'queue_lf1') {
      await interaction.deferReply({ flags: 64 });

      const pinned = pinnedMessages[channelId];
      if (!pinned) {
        return interaction.editReply({ content: '❌ Could not find tournament info for this channel.' });
      }

      const { tournamentName, region, isTrios, consoleOnly } = pinned;

      const partyRecord = party.getPartyByDiscordId(guild.id, user.id);
      if (!partyRecord) {
        return interaction.editReply({
          content: '❌ You need an active party to queue here. Use /party-invite in #form-party, or click "Looking for 2" to queue solo.',
        });
      }
      if (partyRecord.leaderId !== user.id) {
        return interaction.editReply({
          content: '❌ Only your party leader can queue the party. Ask them to click "Looking for 1".',
        });
      }
      if (partyRecord.members.length !== 2) {
        return interaction.editReply({
          content: `❌ Trios queueing needs a party of exactly 2 (yours has ${partyRecord.members.length}) — trios teams are fixed at 3 players total.`,
        });
      }

      const partyMembers = await Promise.all(partyRecord.members.map(m => guild.members.fetch(m.discordId)));

      const unregistered = partyMembers.find(m => !m.roles.cache.has(getRoleId(guild.id, 'Registered')));
      if (unregistered) {
        return interaction.editReply({
          content: `❌ **${unregistered.user.username}** needs to complete their profile in <#${getChannelId(guild.id, 'getRoles')}> first (set their region).`,
        });
      }

      for (const member of partyMembers) {
        const platform = getPlatformFromMember(guild.id, member);
        if (consoleOnly && platform === 'PC') {
          return interaction.editReply({
            content: `❌ This is a console-only tournament. **${member.user.username}** is registered as PC and cannot queue here.`,
          });
        }
        if (consoleOnly && platform !== 'Console') {
          return interaction.editReply({
            content: `❌ This is a console-only tournament. **${member.user.username}** must have the Console role to queue.`,
          });
        }
      }

      for (const member of partyMembers) {
        if (isInQueue(guild.id, member.id, tournamentName, region)) {
          return interaction.editReply({ content: `❌ **${member.user.username}** is already in queue for this tournament.` });
        }
        if (getPendingMatchByDiscordId(guild.id, member.id)) {
          return interaction.editReply({ content: `❌ **${member.user.username}** already has a pending match to resolve first.` });
        }
        if (isInCreativeActivity(guild.id, member.id)) {
          return interaction.editReply({ content: `❌ **${member.user.username}** is already in a creative queue or match — leave it before queueing for a tournament.` });
        }
      }

      for (const member of partyMembers) {
        const memberAccess = await access.checkAccess(member.id);
        if (!memberAccess.allowed) {
          return interaction.editReply({
            embeds: [buildNoAccessEmbed(memberAccess)],
            components: [buildAccessSubscribeButtons()],
          });
        }
      }

      await interaction.editReply({ content: '⏳ Fetching stats for both party members...' });

      try {
        const players = await Promise.all(partyMembers.map(async member => {
          const userData = await playerStore.getPlayer(guild.id, member.id);
          const identity = await resolveEpicIdentity(guild, member);
          return buildPlayer({
            guildId: guild.id,
            discordId: member.id,
            discordUsername: member.user.username,
            epicUsername: identity.epicUsername,
            epicId: identity.epicId,
            tournamentName,
            homeRegion: userData?.region ?? region,
            queueRegion: region,
            queueType: 'lf1',
            platform: getPlatformFromMember(guild.id, member),
            consoleOnly,
            ingameRoles: userData?.ingameRoles ?? [],
            language: userData?.language ?? null,
            bio: userData?.bio ?? null,
          });
        }));

        await joinQueue({
          guildId: guild.id,
          players,
          tournamentName,
          region,
          queueType: 'lf1',
          partyId: partyRecord.partyId,
        });

        await updateQueueEmbed(guild.id, channelId, tournamentName, region, isTrios);

        await interaction.editReply({
          content: `✅ Your party is now in queue for **${tournamentName}**! We'll DM you both the moment a third player is found.`,
        });

      } catch (err) {
        console.error('Party queue error:', err);
        await interaction.editReply({ content: `❌ Error joining queue: ${err.message}` });
      }
    }

    // ── LEAVE QUEUE ──────────────────────────────────────────────────────────
    if (customId === 'leave_queue') {
      await interaction.deferReply({ flags: 64 });

      const pinned = pinnedMessages[channelId];
      if (!pinned) return interaction.editReply({ content: '❌ Could not find tournament info.' });

      const { tournamentName, region, isTrios } = pinned;
      const removed = removeFromQueue(guild.id, user.id, tournamentName, region);

      if (removed) {
        await updateQueueEmbed(guild.id, channelId, tournamentName, region, isTrios);
        const inParty = party.isInParty(guild.id, user.id);
        await interaction.editReply({
          content: inParty
            ? '✅ You have left the queue. Your party is still active — queue again anytime.'
            : '✅ You have left the queue.',
        });
      } else {
        await interaction.editReply({ content: '❌ You were not in the queue.' });
      }
    }

    // ── ACCEPT MATCH ─────────────────────────────────────────────────────────
    if (customId.startsWith('accept_')) {
      await interaction.deferReply({ flags: 64 });

      const matchId = customId.replace('accept_', '');
      const result = acceptMatch(matchId, user.id);

      if (result.status === 'not_found') {
        return interaction.editReply({ content: '❌ This match has expired.' });
      }

      if (result.status === 'waiting') {
        return interaction.editReply({
          content: `✅ You accepted! Waiting for ${result.totalCount - result.acceptedCount} more player(s)...`,
        });
      }

      if (result.status === 'confirmed') {
        const { match } = result;
        const players = match.players;
        const isCreative = match.kind === 'creative';

        // Accept is clicked from the DM'd match card, where interaction.guild is null (DMs
        // aren't part of a guild) — resolve the actual guild the match belongs to instead
        // (every match carries its guildId since queue.js/creative-queue.js stamp it on units).
        const matchGuild = interaction.guild ?? client.guilds.cache.get(match.guildId);
        const category = await channelLifecycle.getOrCreateMatchCategory(matchGuild);

        const channelName = `${isCreative ? 'creative' : 'match'}-${players.map(p => p.epicUsername).join('-')}`
          .toLowerCase()
          .replace(/\s+/g, '-')
          .slice(0, 100);

        const modRoleId = getRoleId(matchGuild.id, 'mod');

        const privateChannel = await matchGuild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: [
            { id: matchGuild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel] },
            ...players.map(p => ({ id: p.discordId, allow: [PermissionFlagsBits.ViewChannel] })),
            ...(modRoleId ? [{ id: modRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] : []),
          ],
        });

        if (isCreative) {
          // match.tournamentName holds the creative mode string here — createMatch's third
          // positional arg is generic, notifyCreativeMatchFound just passes `mode` into it.
          await privateChannel.send({
            content: players.map(p => `<@${p.discordId}>`).join(' '),
            embeds: [buildCreativeMatchConfirmedEmbed(players, match.tournamentName)],
            components: [buildCloseChannelButton()],
          });

          const pinMsg = await privateChannel.send('⏰ This channel will automatically delete in 5 minutes.');
          await pinMsg.pin().catch(err => console.error('Failed to pin deletion notice:', err.message));

          channelLifecycle.scheduleChannelDeletion({
            client, guildId: matchGuild.id, textChannelId: privateChannel.id,
            deleteAtMs: Date.now() + 5 * 60 * 1000, kind: 'creative-pairwise',
          });

          // Fixed 2-player roster for the lifetime of this channel — unlike 6s/8s, there's no
          // backfill/vote-kick here, so a plain closure over `players` is enough.
          credits.scheduleCreditTimer(privateChannel.id, () => players);
        } else {
          const voiceChannel = await matchGuild.channels.create({
            name: `vc-${channelName}`.slice(0, 100),
            type: ChannelType.GuildVoice,
            parent: category.id,
            permissionOverwrites: [
              { id: matchGuild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
              { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
              ...players.map(p => ({ id: p.discordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] })),
              ...(modRoleId ? [{ id: modRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
            ],
          });

          await privateChannel.send({ embeds: [buildMatchConfirmedEmbed(players)], components: [buildCloseChannelButton()] });
          await privateChannel.send(
            `${players.map(p => `<@${p.discordId}>`).join(' ')} — Add each other in-game and good luck! 🏆`
          );

          const pinMsg = await privateChannel.send('⏰ This channel and voice channel will automatically delete in 3.5 hours. Good luck!');
          await pinMsg.pin().catch(err => console.error('Failed to pin deletion notice:', err.message));

          channelLifecycle.scheduleChannelDeletion({
            client, guildId: matchGuild.id, textChannelId: privateChannel.id, voiceChannelId: voiceChannel.id,
            deleteAtMs: Date.now() + 3.5 * 60 * 60 * 1000, kind: 'tournament',
          });
        }

        await interaction.editReply({ content: `✅ Match confirmed! Head to ${privateChannel}` });
      }
    }

    // ── CREATIVE QUEUE BUTTON ────────────────────────────────────────────────
    if (customId.startsWith('creative_queue_')) {
      await interaction.deferReply({ flags: 64 });

      const category = customId.replace('creative_queue_', '');
      const selection = creativeSelections.get(`${guild.id}:${user.id}:${category}`);

      if (!selection?.mode || !selection?.region) {
        return interaction.editReply({ content: '❌ Select a mode and region from the menus above first.' });
      }

      const joinKey = `${guild.id}:${user.id}`;

      if (isInCreativeQueue(guild.id, user.id) || creativeJoinInProgress.has(joinKey)) {
        return interaction.editReply({
          content: '🔍 You are already in the creative queue. Click "Leave Queue" first if you want to change your selection.',
        });
      }

      if (isInTournamentActivity(guild.id, user.id)) {
        return interaction.editReply({ content: '❌ You are already in a tournament queue or match. Leave it before queueing for creative.' });
      }

      creativeJoinInProgress.add(joinKey);
      await interaction.editReply({ content: '⏳ Fetching your stats...' });

      try {
        const member = await guild.members.fetch(user.id);

        if (!member.roles.cache.has(getRoleId(guild.id, 'Registered'))) {
          return interaction.editReply({
            content: `❌ Complete your profile in <#${getChannelId(guild.id, 'getRoles')}> first (set your region).`,
          });
        }

        const creativeAccess = await access.checkAccess(user.id);
        if (!creativeAccess.allowed) {
          return interaction.editReply({
            embeds: [buildNoAccessEmbed(creativeAccess)],
            components: [buildAccessSubscribeButtons()],
          });
        }

        const platform = getPlatformFromMember(guild.id, member);
        const { epicUsername, epicId } = await resolveEpicIdentity(guild, member);

        const player = await buildCreativePlayer({
          guildId: guild.id,
          discordId: user.id,
          discordUsername: user.username,
          epicUsername,
          epicId,
          mode: selection.mode,
          region: selection.region,
          platform,
        });

        joinCreativeQueue({ guildId: guild.id, player, mode: selection.mode, region: selection.region });

        await updateCreativeQueueEmbed(guild.id, client, category, QUEUE_CHANNEL_CONFIGS[category]);

        await interaction.editReply({
          content: `✅ You are now in the creative queue for **${selection.mode}** (${selection.region})! We'll ping you here the moment an opponent is found.`,
        });
      } catch (err) {
        console.error('Creative queue error:', err);
        await interaction.editReply({ content: `❌ Error joining queue: ${err.message}` });
      } finally {
        creativeJoinInProgress.delete(joinKey);
      }
    }

    // ── CREATIVE LEAVE QUEUE ─────────────────────────────────────────────────
    if (customId === 'creative_leave_queue') {
      await interaction.deferReply({ flags: 64 });

      const found = findCreativeUnitByDiscordId(guild.id, user.id);
      if (!found) {
        return interaction.editReply({ content: '❌ You are not in the creative queue.' });
      }

      removeFromCreativeQueueAnywhere(guild.id, user.id);

      const category = categoryForAnyMode(found.mode);
      if (category) await updateCreativeQueueEmbed(guild.id, client, category, QUEUE_CHANNEL_CONFIGS[category]);

      await interaction.editReply({ content: '✅ You have left the creative queue.' });
    }

    // ── TEAM QUEUE BUTTON (6s/8s) ────────────────────────────────────────────
    if (customId.startsWith('team_queue_')) {
      await interaction.deferReply({ flags: 64 });

      const category = customId.replace('team_queue_', '');
      const selection = creativeSelections.get(`${guild.id}:${user.id}:${category}`);

      if (!selection?.mode || !selection?.region) {
        return interaction.editReply({ content: '❌ Select a mode and region from the menus above first.' });
      }

      const existingParty = party.getPartyByDiscordId(guild.id, user.id);
      if (existingParty && existingParty.leaderId !== user.id) {
        return interaction.editReply({ content: '❌ Only your party leader can queue the party.' });
      }

      const partyMembersRaw = existingParty ? existingParty.members : [{ discordId: user.id, username: user.username }];

      const alreadyBusy = partyMembersRaw.some(m =>
        isInCreativeQueue(guild.id, m.discordId)
        || creativeTeamQueue.isInTeamQueue(guild.id, m.discordId)
        || teamJoinInProgress.has(`${guild.id}:${m.discordId}`)
        || teamMatchLifecycle.isPlayerInActiveTeamMatch(guild.id, m.discordId)
      );
      if (alreadyBusy) {
        return interaction.editReply({ content: '❌ One or more of your party members is already queued or in an active match.' });
      }

      const busyWithTournament = partyMembersRaw.find(m => isInTournamentActivity(guild.id, m.discordId));
      if (busyWithTournament) {
        return interaction.editReply({
          content: `❌ **${busyWithTournament.username}** is already in a tournament queue or match — leave it before queueing for creative.`,
        });
      }

      for (const m of partyMembersRaw) teamJoinInProgress.add(`${guild.id}:${m.discordId}`);
      await interaction.editReply({ content: `⏳ Fetching stats for ${partyMembersRaw.length} player(s)...` });

      try {
        const members = await Promise.all(partyMembersRaw.map(m => guild.members.fetch(m.discordId)));

        const unregistered = members.find(m => !m.roles.cache.has(getRoleId(guild.id, 'Registered')));
        if (unregistered) {
          return interaction.editReply({
            content: `❌ **${unregistered.user.username}** needs to complete their profile in <#${getChannelId(guild.id, 'getRoles')}> first (set their region).`,
          });
        }

        for (const member of members) {
          const memberAccess = await access.checkAccess(member.id);
          if (!memberAccess.allowed) {
            return interaction.editReply({
              embeds: [buildNoAccessEmbed(memberAccess)],
              components: [buildAccessSubscribeButtons()],
            });
          }
        }

        const players = await Promise.all(members.map(async member => {
          const platform = getPlatformFromMember(guild.id, member);
          const { epicUsername, epicId } = await resolveEpicIdentity(guild, member);
          return buildCreativePlayer({
            guildId: guild.id,
            discordId: member.id,
            discordUsername: member.user.username,
            epicUsername,
            epicId,
            mode: selection.mode,
            region: selection.region,
            platform,
          });
        }));

        creativeTeamQueue.queueUnit(guild.id, players, selection.mode, selection.region);

        await updateCreativeQueueEmbed(guild.id, client, category, QUEUE_CHANNEL_CONFIGS[category]);

        const targetSize = creativeTeamQueue.targetSizeForMode(selection.mode);
        const needed = targetSize - players.length;
        await interaction.editReply({
          content: needed > 0
            ? `✅ Queued for **${selection.mode}** (${selection.region}) — LF${needed}. We'll ping the match channel once it fills.`
            : `✅ Queued for **${selection.mode}** (${selection.region})! We'll ping the match channel shortly.`,
        });
      } catch (err) {
        console.error('Team queue error:', err);
        await interaction.editReply({ content: `❌ Error joining queue: ${err.message}` });
      } finally {
        for (const m of partyMembersRaw) teamJoinInProgress.delete(`${guild.id}:${m.discordId}`);
      }
    }

    // ── TEAM LEAVE QUEUE (6s/8s) ─────────────────────────────────────────────
    if (customId === 'team_leave_queue') {
      await interaction.deferReply({ flags: 64 });

      const found = creativeTeamQueue.findUnitByDiscordId(guild.id, user.id);
      if (!found) {
        return interaction.editReply({ content: '❌ You are not in the 6s/8s queue.' });
      }

      creativeTeamQueue.removeFromTeamQueueAnywhere(guild.id, user.id);

      const category = categoryForAnyMode(found.mode);
      if (category) await updateCreativeQueueEmbed(guild.id, client, category, QUEUE_CHANNEL_CONFIGS[category]);

      await interaction.editReply({ content: '✅ You (and your party) have left the 6s/8s queue.' });
    }

    // ── TEAM METHOD VOTE BUTTONS ──────────────────────────────────────────────
    if (customId === 'team_method_choose' || customId === 'team_method_balanced') {
      const choice = customId === 'team_method_choose' ? 'choose' : 'balanced';
      const result = teamMatchLifecycle.handleTeamMethodVoteButton(channelId, user.id, choice);

      if (result.status === 'not_found') {
        return interaction.reply({ content: '❌ This vote has ended.', flags: 64 });
      }
      if (result.status === 'not_participant') {
        return interaction.reply({ content: '❌ You are not part of this match.', flags: 64 });
      }

      await interaction.reply({ content: `✅ Vote recorded (👥${result.chooseCount} / ⚡${result.balancedCount}).`, flags: 64 });
      await interaction.message.edit({
        embeds: [buildTeamMethodVoteEmbed(result.chooseCount, result.balancedCount, result.totalCount)],
      }).catch(console.error);
    }

    // ── TEAM PICK BUTTONS ─────────────────────────────────────────────────────
    if (customId === 'team_pick_1' || customId === 'team_pick_2') {
      const teamNumber = customId === 'team_pick_1' ? 1 : 2;
      const result = teamMatchLifecycle.handleTeamPickButton(channelId, user.id, teamNumber);

      if (result.status === 'not_found') {
        return interaction.reply({ content: '❌ Team picking has ended.', flags: 64 });
      }
      if (result.status === 'not_participant') {
        return interaction.reply({ content: '❌ You are not part of this match.', flags: 64 });
      }

      await interaction.reply({ content: `✅ You joined Team ${teamNumber}.`, flags: 64 });
      await interaction.message.edit({
        embeds: [buildTeamChoiceEmbed(result.team1, result.team2, result.undecided)],
      }).catch(console.error);
    }

    // ── TEAM READY CHECK BUTTON ──────────────────────────────────────────────
    if (customId === 'team_ready') {
      const result = teamMatchLifecycle.handleReadyButton(channelId, user.id);

      if (result.status === 'not_found' || result.status === 'not_active') {
        return interaction.reply({ content: '❌ There is no active ready check here.', flags: 64 });
      }
      if (result.status === 'not_participant') {
        return interaction.reply({ content: '❌ You are not part of this match.', flags: 64 });
      }

      await interaction.reply({ content: `✅ Marked ready (${result.readyCount}/${result.totalCount}).`, flags: 64 });
      await interaction.message.edit({ embeds: [buildReadyCheckEmbed(result.readyCount, result.totalCount)] }).catch(console.error);
    }

    // ── VOTE KICK BUTTONS ─────────────────────────────────────────────────────
    if (customId.startsWith('votekick_yes_') || customId.startsWith('votekick_no_')) {
      const choice = customId.startsWith('votekick_yes_') ? 'yes' : 'no';
      const voteId = customId.replace(`votekick_${choice}_`, '');

      const result = teamMatchLifecycle.handleVoteKickButton(channelId, voteId, user.id, choice);

      if (result.status === 'not_found') {
        return interaction.reply({ content: '❌ This vote has ended.', flags: 64 });
      }
      if (result.status === 'cannot_vote_self') {
        return interaction.reply({ content: '❌ You cannot vote on your own kick.', flags: 64 });
      }
      if (result.status === 'not_participant') {
        return interaction.reply({ content: '❌ You are not part of this match.', flags: 64 });
      }

      await interaction.reply({ content: `✅ Vote recorded (✅${result.yesCount} / ❌${result.noCount}).`, flags: 64 });
    }

    // ── CLOSE CREATIVE MATCH CHANNEL ─────────────────────────────────────────
    if (customId === 'close_creative_channel') {
      teamMatchLifecycle.endTeamMatch(channelId);
      credits.cancelCreditTimer(channelId);
      const cancelled = channelLifecycle.cancelChannelDeletion(channelId);

      await interaction.reply({ content: '🔒 Closing this channel in 10 seconds...' });
      setTimeout(() => {
        interaction.channel.delete().catch(console.error);
        if (cancelled?.voiceChannelId) {
          client.channels.fetch(cancelled.voiceChannelId)
            .then(vc => vc.delete())
            .catch(console.error);
        }
      }, 10000);
    }

    // ── REJECT MATCH ─────────────────────────────────────────────────────────
    if (customId.startsWith('reject_')) {
      await interaction.deferReply({ flags: 64 });

      const matchId = customId.replace('reject_', '');
      const result = rejectMatch(matchId, user.id);

      if (result.status === 'not_found') {
        return interaction.editReply({ content: '❌ This match has expired.' });
      }

      if (result.status === 'rejected') {
        return interaction.editReply({ content: '❌ Match declined. You have been re-queued automatically.' });
      }
    }

    // ── CHECK MY ACCESS ──────────────────────────────────────────────────────
    if (customId === 'access_check') {
      await interaction.deferReply({ flags: 64 });
      const status = await access.getAccessStatus(user.id);
      await interaction.editReply({
        embeds: [buildAccessStatusEmbed(status)],
        components: [buildAccessSubscribeButtons()],
      });
    }

    // ── SUBSCRIBE BUTTONS ─────────────────────────────────────────────────────
    // Same two IDs are used both on the persistent #access embed and on the "no access" blocking
    // embed shown at every gating point — the action is identical regardless of entry point:
    // generate a fresh Checkout Session for whoever clicked and hand back a Link button, since a
    // Checkout URL is single-use and can't be baked into a static persistent embed.
    if (customId === 'access_subscribe_monthly' || customId === 'access_subscribe_yearly') {
      await interaction.deferReply({ flags: 64 });
      const plan = customId === 'access_subscribe_monthly' ? 'monthly' : 'yearly';

      try {
        const checkoutUrl = await billing.createCheckoutSession(user.id, plan);
        const linkButton = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setURL(checkoutUrl)
            .setLabel(`Complete ${plan === 'monthly' ? 'Monthly' : 'Yearly'} Checkout ↗`),
        );
        await interaction.editReply({
          content: 'Click below to complete checkout (opens Stripe):',
          components: [linkButton],
        });
      } catch (err) {
        await interaction.editReply({ content: `❌ ${err.message}` });
      }
    }
  }
}

// ── ROLE ID HELPERS ───────────────────────────────────────────────────────────
function regionRoleId(guildId, region) {
  return getRoleId(guildId, region);
}

function ingameRoleId(guildId, role) {
  // 'Support' is offered as a select option but wasn't previously mapped to a role at all —
  // now that /matchmaker-setup actually creates a Support role, wire it up.
  return getRoleId(guildId, role);
}

function platformRoleId(guildId, platform) {
  const map = {
    PC: getRoleId(guildId, 'PC'),
    PS4: getRoleId(guildId, 'Console'),
    XB1: getRoleId(guildId, 'Console'),
    SWITCH: getRoleId(guildId, 'Console'),
    MOBILE: getRoleId(guildId, 'Mobile'),
  };
  return map[platform] ?? null;
}

// ── HELPER: ASSIGN ROLE ───────────────────────────────────────────────────────
async function assignRole(guild, discordId, roleId) {
  if (!roleId) return;
  try {
    const member = await guild.members.fetch(discordId);
    await member.roles.add(roleId);
  } catch (err) {
    console.error(`Failed to assign role ${roleId}:`, err.message);
  }
}

// ── HELPER: RESOLVE EPIC IDENTITY (Yunite lookup, falls back to Discord name) ──
async function resolveEpicIdentity(guild, member) {
  try {
    const yuniteData = await getEpicFromDiscord(member.id, guild.id);
    if (yuniteData.platform) {
      await assignRole(guild, member.id, platformRoleId(guild.id, yuniteData.platform));
    }
    return { epicUsername: yuniteData.epicName, epicId: yuniteData.epicId };
  } catch (yuniteErr) {
    console.warn('Yunite lookup failed, falling back to Discord username:', yuniteErr.message);
    return {
      epicUsername: member.nickname ?? member.user.globalName ?? member.user.username,
      epicId: null,
    };
  }
}

// ── HELPER: DM A PLAYER (best-effort, swallows failures) ───────────────────────
async function dmPlayer(guild, discordId, payload) {
  try {
    const member = await guild.members.fetch(discordId);
    await member.send(payload);
  } catch (err) {
    console.error(`Could not DM player ${discordId}:`, err.message);
  }
}

// ── HELPER: UPDATE QUEUE EMBED ────────────────────────────────────────────────
async function updateQueueEmbed(guildId, channelId, tournamentName, region, isTrios) {
  try {
    const channel = await client.channels.fetch(channelId);
    const pinned = pinnedMessages[channelId];
    if (!pinned) return;

    const msg = await channel.messages.fetch(pinned.messageId);
    const count = getQueueCount(guildId, tournamentName, region);
    const newEmbed = buildTournamentEmbed(tournamentName, region, count, isTrios, pinned.beginTime, pinned.deleteAt);
    await msg.edit({ embeds: [newEmbed], components: msg.components });
  } catch (err) {
    console.error('Failed to update queue embed:', err);
  }
}

// ── HELPER: NOTIFY MATCH FOUND ────────────────────────────────────────────────
// Fired for every match, whether found instantly on join or later via a reject-triggered
// requeue or the periodic sweep — there's no single "triggering interaction" to reply to
// once matching is asynchronous, so every participant is notified uniformly via DM.
async function notifyMatchFound(unitA, unitB, tournamentName, region, guild) {
  const matchId = createMatch(unitA, unitB, tournamentName, region);
  const buttons = buildMatchButtons(matchId);

  for (const viewer of unitA.members) {
    await dmPlayer(guild, viewer.discordId, {
      content: `🎯 Potential teammate${unitB.members.length > 1 ? 's' : ''} found for **${tournamentName}**!`,
      embeds: unitB.members.map(p => buildMatchCard(p, tournamentName)),
      components: [buttons],
    });
  }

  for (const viewer of unitB.members) {
    await dmPlayer(guild, viewer.discordId, {
      content: `🎯 Potential teammate${unitA.members.length > 1 ? 's' : ''} found for **${tournamentName}**!`,
      embeds: unitA.members.map(p => buildMatchCard(p, tournamentName)),
      components: [buttons],
    });
  }
}

// ── HELPER: NOTIFY CREATIVE MATCH FOUND ───────────────────────────────────────
// Both units are already spliced out of the pool by the time this fires (attemptMatchingForQueue
// does that synchronously), so the queue embed count is updated here regardless of what happens
// next. The match itself still needs both players to accept — same pending-match flow as
// tournament matches, just with a 2-minute expiry and creative's own requeue-on-reject/expiry.
async function notifyCreativeMatchFound(unitA, unitB, mode, region, guild) {
  const matchId = createMatch(unitA, unitB, mode, region, {
    requeueFn: requeueCreativeUnit,
    kind: 'creative',
    expiryMs: 2 * 60 * 1000,
  });
  const buttons = buildMatchButtons(matchId);

  const playerA = unitA.members[0];
  const playerB = unitB.members[0];

  await dmPlayer(guild, playerA.discordId, {
    content: `🎯 Opponent found for **${mode}**!`,
    embeds: [buildCreativeMatchCard(playerB)],
    components: [buttons],
  });

  await dmPlayer(guild, playerB.discordId, {
    content: `🎯 Opponent found for **${mode}**!`,
    embeds: [buildCreativeMatchCard(playerA)],
    components: [buttons],
  });

  const category = categoryForAnyMode(mode);
  if (category) await updateCreativeQueueEmbed(guild.id, client, category, QUEUE_CHANNEL_CONFIGS[category]);
}

startWebhookServer(client);

store.init()
  .catch(err => console.error('[Store] init() failed unexpectedly:', err.message))
  .finally(() => client.login(process.env.DISCORD_TOKEN));
