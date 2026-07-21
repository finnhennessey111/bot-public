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
const { createMatch, acceptMatch, rejectMatch, getPendingMatchByDiscordId } = require('./matching');
const { getUser, updateUser, isRegistered } = require('./database');
const { getEpicFromDiscord } = require('./yunite');
const { startScheduler, checkAndCreateChannels } = require('./channel-manager');
const { enforcePermissions } = require('./permissions');
const {
  buildTournamentEmbed, buildQueueButtons, buildLeaveQueueButton,
  buildMatchCard, buildMatchButtons, buildMatchConfirmedEmbed,
  buildPartyInviteEmbed, buildPartyInviteButtons, buildPartyStatusEmbed,
  buildFormPartyInstructionsEmbed, buildPartyChannelInstructionsEmbed,
  buildCreativeMatchConfirmedEmbed, buildCloseChannelButton, buildCreativeMatchCard,
  buildReadyCheckEmbed, buildTeamMethodVoteEmbed, buildTeamChoiceEmbed,
  buildVoteKickEmbed, buildVoteKickButtons,
  buildHowtoEmbed,
} = require('./embeds');
const store = require('./store');
const { pinnedMessages, save: saveStore } = store;
const party = require('./party');
const {
  MODES: CREATIVE_MODES, buildCreativePlayer, joinCreativeQueue, requeueCreativeUnit,
  removeFromCreativeQueueAnywhere, findCreativeUnitByDiscordId, isInCreativeQueue,
  startCreativeMatchSweep, creativeMatchEvents, getCreativeQueueCount,
} = require('./creative-queue');
const { postCreativeQueueChannel, updateCreativeQueueEmbed } = require('./creative-channel');
const creativeTeamQueue = require('./creative-team-queue');
const teamMatchLifecycle = require('./team-match-lifecycle');
const channelLifecycle = require('./channel-lifecycle');

// discordId:category -> { mode, region } — pending selections from the creative queue's
// select menus, held here since Queue is a separate interaction from picking mode/region.
const creativeSelections = new Map();

// discordIds currently mid-join (stats fetch in flight) — closes the race where a double
// click on Queue passes the isInCreativeQueue check twice before the first join lands,
// ending up with two units for the same player and, in the worst case, a self-match.
const creativeJoinInProgress = new Set();
const teamJoinInProgress = new Set();

// Per-category config for the shared creative-channel.js lifecycle — 1v1/2v2 are backed by
// creative-queue.js's pairwise engine, 6s/8s by creative-team-queue.js's partial-fill engine.
const QUEUE_CHANNEL_CONFIGS = {
  '1v1': {
    modes: CREATIVE_MODES['1v1'], countFn: getCreativeQueueCount,
    queueButtonPrefix: 'creative_queue_', leaveButtonId: 'creative_leave_queue',
  },
  '2v2': {
    modes: CREATIVE_MODES['2v2'], countFn: getCreativeQueueCount,
    queueButtonPrefix: 'creative_queue_', leaveButtonId: 'creative_leave_queue',
  },
  '6s': {
    modes: creativeTeamQueue.MODES['6s'], countFn: creativeTeamQueue.getTeamQueueWaitingCount,
    queueButtonPrefix: 'team_queue_', leaveButtonId: 'team_leave_queue',
  },
  '8s': {
    modes: creativeTeamQueue.MODES['8s'], countFn: creativeTeamQueue.getTeamQueueWaitingCount,
    queueButtonPrefix: 'team_queue_', leaveButtonId: 'team_leave_queue',
  },
};

function categoryForAnyMode(mode) {
  return Object.keys(QUEUE_CHANNEL_CONFIGS).find(category => QUEUE_CHANNEL_CONFIGS[category].modes.includes(mode));
}

// Cross-queue exclusivity: a player can't be queued (or mid-match) in both the tournament
// system and any creative queue (1v1/2v2 or 6s/8s) at once. Pending matches are tagged by
// `kind` (matching.js) so a pending creative accept/reject doesn't count as tournament activity
// and vice versa.
function isInTournamentActivity(discordId) {
  if (findUnitByDiscordId(discordId)) return true;
  const pending = getPendingMatchByDiscordId(discordId);
  return !!pending && pending.match.kind !== 'creative';
}

function isInCreativeActivity(discordId) {
  if (isInCreativeQueue(discordId)) return true;
  if (creativeTeamQueue.isInTeamQueue(discordId)) return true;
  if (teamMatchLifecycle.isPlayerInActiveTeamMatch(discordId)) return true;
  const pending = getPendingMatchByDiscordId(discordId);
  return !!pending && pending.match.kind === 'creative';
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once('clientReady', () => {
  console.log(`✅ MatchMaker bot is online as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (guild) {
    enforcePermissions(guild).catch(console.error);
    startScheduler(guild, pinnedMessages);
    startMatchSweep();
    matchEvents.on('matchFound', ({ unitA, unitB, tournamentName, region }) => {
      notifyMatchFound(unitA, unitB, tournamentName, region, guild).catch(console.error);
    });

    startCreativeMatchSweep();
    creativeMatchEvents.on('matchFound', ({ unitA, unitB, mode, region }) => {
      notifyCreativeMatchFound(unitA, unitB, mode, region, guild).catch(console.error);
    });

    creativeTeamQueue.startCreativeTeamMatchSweep();
    creativeTeamQueue.creativeTeamMatchEvents.on('matchFormed', ({ units, mode, region }) => {
      teamMatchLifecycle.startTeamMatch(units, mode, region, guild, client).catch(console.error);
    });

    channelLifecycle.restoreScheduledDeletions(client);
    channelLifecycle.channelLifecycleEvents.on('channelDeleted', ({ textChannelId, kind }) => {
      if (kind === 'creative-team') teamMatchLifecycle.endTeamMatch(textChannelId);
    });
  }
});

// ── PLATFORM HELPERS ──────────────────────────────────────────────────────────

function isConsolePlayer(member) {
  return member.roles.cache.has(process.env.ROLE_CONSOLE);
}

function isPCPlayer(member) {
  return member.roles.cache.has(process.env.ROLE_PC);
}

function getPlatformFromMember(member) {
  if (member.roles.cache.has(process.env.ROLE_PC)) return 'PC';
  if (member.roles.cache.has(process.env.ROLE_CONSOLE)) return 'Console';
  if (member.roles.cache.has(process.env.ROLE_MOBILE)) return 'Mobile';
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

      const tournamentName = interaction.options.getString('tournament');
      const region = interaction.options.getString('region');
      const isTrios = interaction.options.getBoolean('trios') ?? false;

      const embed = buildTournamentEmbed(tournamentName, region, 0, isTrios);
      const buttons = buildQueueButtons(isTrios);

      const msg = await interaction.channel.send({ embeds: [embed], components: [buttons] });
      await msg.pin();

      pinnedMessages[interaction.channelId] = {
        messageId: msg.id,
        tournamentName,
        region,
        isTrios,
        consoleOnly: false,
      };
      saveStore();

      await interaction.editReply({
        content: `✅ Tournament embed created for **${tournamentName}** (${region})`,
      });
    }

    // /setup-roles
    if (interaction.commandName === 'setup-roles') {
      await interaction.deferReply({ flags: 64 });
      await postRolesEmbed(interaction.channel);
      await interaction.editReply({ content: '✅ Roles embed posted.' });
    }

    // /setup-party-channel
    if (interaction.commandName === 'setup-party-channel') {
      await interaction.deferReply({ flags: 64 });
      const msg = await interaction.channel.send({ embeds: [buildFormPartyInstructionsEmbed()] });
      await msg.pin();
      await interaction.editReply({ content: '✅ Party instructions posted and pinned.' });
    }

    // /setup-creative-1v1, /setup-creative-2v2
    if (interaction.commandName === 'setup-creative-1v1' || interaction.commandName === 'setup-creative-2v2') {
      await interaction.deferReply({ flags: 64 });
      const category = interaction.commandName === 'setup-creative-1v1' ? '1v1' : '2v2';
      await postCreativeQueueChannel(interaction.channel, category, QUEUE_CHANNEL_CONFIGS[category]);
      await interaction.editReply({ content: `✅ Creative ${category} queue embed posted and pinned.` });
    }

    // /setup-creative-6s, /setup-creative-8s — always post into the fixed env-var channel,
    // regardless of where the command is run (unlike 1v1/2v2's "post wherever run").
    if (interaction.commandName === 'setup-creative-6s' || interaction.commandName === 'setup-creative-8s') {
      await interaction.deferReply({ flags: 64 });
      const category = interaction.commandName === 'setup-creative-6s' ? '6s' : '8s';
      const envVar = category === '6s' ? 'CREATIVE_6S_CHANNEL_ID' : 'CREATIVE_8S_CHANNEL_ID';
      const channelId = process.env[envVar];

      if (!channelId) {
        return interaction.editReply({ content: `❌ ${envVar} is not set in .env.` });
      }

      try {
        const targetChannel = await client.channels.fetch(channelId);
        await postCreativeQueueChannel(targetChannel, category, QUEUE_CHANNEL_CONFIGS[category]);
        await interaction.editReply({ content: `✅ Creative ${category} queue embed posted and pinned in ${targetChannel}.` });
      } catch (err) {
        console.error(`Failed to post creative ${category} queue channel:`, err.message);
        await interaction.editReply({ content: `❌ Failed to post to <#${channelId}> — check ${envVar} is a valid channel ID the bot can see.` });
      }
    }

    // /setup-howto — always posts into the fixed HOWTO_CHANNEL_ID env-var channel
    if (interaction.commandName === 'setup-howto') {
      await interaction.deferReply({ flags: 64 });
      const channelId = process.env.HOWTO_CHANNEL_ID;

      if (!channelId) {
        return interaction.editReply({ content: '❌ HOWTO_CHANNEL_ID is not set in .env.' });
      }

      try {
        const targetChannel = await client.channels.fetch(channelId);
        const msg = await targetChannel.send({ embeds: [buildHowtoEmbed()] });
        await msg.pin();
        await interaction.editReply({ content: `✅ How-to embed posted and pinned in ${targetChannel}.` });
      } catch (err) {
        console.error('Failed to post how-to embed:', err.message);
        await interaction.editReply({ content: '❌ Failed to post to <#' + channelId + '> — check HOWTO_CHANNEL_ID is a valid channel ID the bot can see.' });
      }
    }

    // /votekick — only usable inside an active 6s/8s team match channel
    if (interaction.commandName === 'votekick') {
      await interaction.deferReply({ flags: 64 });

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

    // /cancel-tournament
    if (interaction.commandName === 'cancel-tournament') {
      await interaction.deferReply({ flags: 64 });

      const pinned = pinnedMessages[interaction.channelId];
      if (!pinned) {
        return interaction.editReply({ content: '❌ No tournament found in this channel.' });
      }

      const { tournamentName, region } = pinned;
      const count = getQueueCount(tournamentName, region);
      if (count > 0) {
        await interaction.channel.send(
          `⚠️ **${tournamentName}** has been cancelled. All queued players have been removed.`
        );
      }

      await interaction.editReply({ content: `✅ Tournament cancelled. Channel will be deleted in 10 seconds.` });
      delete pinnedMessages[interaction.channelId];
      saveStore();
      setTimeout(() => interaction.channel.delete().catch(console.error), 10000);
    }

    // /check-tournaments
    if (interaction.commandName === 'check-tournaments') {
      await interaction.reply({ content: '🔍 Checking tournaments in background... check #master-tournaments shortly.', flags: 64 });
      checkAndCreateChannels(interaction.guild, pinnedMessages).catch(console.error);
    }

    // /party-invite
    if (interaction.commandName === 'party-invite') {
      await interaction.deferReply({ flags: 64 });

      if (interaction.channelId !== process.env.FORM_PARTY_CHANNEL_ID) {
        return interaction.editReply({
          content: `❌ Use this command in <#${process.env.FORM_PARTY_CHANNEL_ID}>.`,
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
      if (party.hasPendingInvite(leader.id)) {
        return interaction.editReply({ content: '❌ You already have a pending invite out. Wait for it to resolve first.' });
      }
      if (!party.canAddMember(leader.id)) {
        return interaction.editReply({ content: `❌ Your party is already at the ${party.MAX_PARTY_SIZE}-member cap.` });
      }
      if (party.isInParty(invited.id) || party.hasPendingInvite(invited.id)) {
        return interaction.editReply({ content: `❌ **${invited.username}** is already in a party or has a pending invite.` });
      }

      const existingParty = party.getPartyByDiscordId(leader.id);
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

      const record = party.getPartyByDiscordId(interaction.user.id);
      if (!record) {
        return interaction.editReply({ content: '❌ You are not in a party.' });
      }

      const memberIds = record.members.map(m => m.discordId);

      // Reject any pending match first (requeues both units in that match)...
      for (const discordId of memberIds) {
        const pending = getPendingMatchByDiscordId(discordId);
        if (pending) rejectMatch(pending.matchId, discordId);
      }
      // ...then pull the disbanding unit back out again, wherever it ended up.
      for (const discordId of memberIds) {
        removeFromQueueAnywhere(discordId);
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

      const record = party.getPartyByDiscordId(interaction.user.id);
      if (!record) {
        return interaction.editReply({ content: '❌ You are not in a party. Use /party-invite to form one.' });
      }

      await interaction.editReply({ embeds: [buildPartyStatusEmbed(record)] });
    }
  }

  // ── MODAL SUBMISSIONS ────────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'bio_modal') {
      const bio = interaction.fields.getTextInputValue('bio_input');
      updateUser(interaction.user.id, { bio });
      await interaction.reply({ content: `✅ Bio saved: "${bio}"`, flags: 64 });
    }

  }

  // ── SELECT MENUS ─────────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    await interaction.deferReply({ flags: 64 });
    const { user, customId, values } = interaction;

    if (customId === 'select_region') {
      updateUser(user.id, { region: values[0] });
      await assignRole(interaction.guild, user.id, regionRoleId(values[0]));
      await interaction.editReply({ content: `✅ Primary region set to **${values[0]}**.` });
    }

    if (customId === 'select_extra_regions') {
      updateUser(user.id, { extraRegions: values });
      for (const region of values) {
        await assignRole(interaction.guild, user.id, regionRoleId(region));
      }
      await interaction.editReply({ content: `✅ Extra regions unlocked: **${values.join(', ')}**.` });
    }

    if (customId === 'select_ingame_role') {
      updateUser(user.id, { roles: values });
      for (const role of values) {
        await assignRole(interaction.guild, user.id, ingameRoleId(role));
      }
      await interaction.editReply({ content: `✅ In-game role(s) set to: **${values.join(', ')}**.` });
    }

    if (customId === 'select_language') {
      updateUser(user.id, { language: values[0] });
      await interaction.editReply({ content: `✅ Language set to **${values[0]}**.` });
    }

    if (customId.startsWith('creative_mode_')) {
      const category = customId.replace('creative_mode_', '');
      const key = `${user.id}:${category}`;
      creativeSelections.set(key, { ...creativeSelections.get(key), mode: values[0] });
      await interaction.editReply({ content: `✅ Mode set to **${values[0]}**. Now select a region, then click Queue.` });
    }

    if (customId.startsWith('creative_region_')) {
      const category = customId.replace('creative_region_', '');
      const key = `${user.id}:${category}`;
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
      const platform = getPlatformFromMember(member);

      if (consoleOnly && isPCPlayer(member)) {
        return interaction.editReply({
          content: '❌ This is a console-only tournament. PC players cannot queue here.',
        });
      }
      if (consoleOnly && !isConsolePlayer(member)) {
        return interaction.editReply({
          content: '❌ This is a console-only tournament. You must have the Console role to queue.',
        });
      }

      if (queueType === 'lf2' && party.isInParty(user.id)) {
        return interaction.editReply({
          content: '❌ You are in a party — ask your party leader to click "Looking for 1", or run /party-leave to queue solo.',
        });
      }

      if (isInQueue(user.id, tournamentName, region)) {
        return interaction.editReply({
          content: '🔍 You are currently in queue. Click to leave.',
          components: [buildLeaveQueueButton()],
        });
      }

      if (isInCreativeActivity(user.id)) {
        return interaction.editReply({ content: '❌ You are already in a creative queue or match. Leave it before queueing for a tournament.' });
      }

      await interaction.editReply({ content: '⏳ Fetching your stats...' });

      try {
        const { epicUsername, epicId } = await resolveEpicIdentity(guild, member);

        const userData = getUser(user.id);
        const homeRegion = userData?.region ?? region;

        const player = await buildPlayer({
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
          ingameRoles: userData?.roles ?? [],
          language: userData?.language ?? null,
          bio: userData?.bio ?? null,
        });

        await joinQueue({ players: [player], tournamentName, region, queueType });

        await updateQueueEmbed(channelId, tournamentName, region, isTrios);

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

      const partyRecord = party.getPartyByDiscordId(user.id);
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

      for (const member of partyMembers) {
        const platform = getPlatformFromMember(member);
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
        if (isInQueue(member.id, tournamentName, region)) {
          return interaction.editReply({ content: `❌ **${member.user.username}** is already in queue for this tournament.` });
        }
        if (getPendingMatchByDiscordId(member.id)) {
          return interaction.editReply({ content: `❌ **${member.user.username}** already has a pending match to resolve first.` });
        }
        if (isInCreativeActivity(member.id)) {
          return interaction.editReply({ content: `❌ **${member.user.username}** is already in a creative queue or match — leave it before queueing for a tournament.` });
        }
      }

      await interaction.editReply({ content: '⏳ Fetching stats for both party members...' });

      try {
        const players = await Promise.all(partyMembers.map(async member => {
          const userData = getUser(member.id);
          const identity = await resolveEpicIdentity(guild, member);
          return buildPlayer({
            discordId: member.id,
            discordUsername: member.user.username,
            epicUsername: identity.epicUsername,
            epicId: identity.epicId,
            tournamentName,
            homeRegion: userData?.region ?? region,
            queueRegion: region,
            queueType: 'lf1',
            platform: getPlatformFromMember(member),
            consoleOnly,
            ingameRoles: userData?.roles ?? [],
            language: userData?.language ?? null,
            bio: userData?.bio ?? null,
          });
        }));

        await joinQueue({
          players,
          tournamentName,
          region,
          queueType: 'lf1',
          partyId: partyRecord.partyId,
        });

        await updateQueueEmbed(channelId, tournamentName, region, isTrios);

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
      const removed = removeFromQueue(user.id, tournamentName, region);

      if (removed) {
        await updateQueueEmbed(channelId, tournamentName, region, isTrios);
        const inParty = party.isInParty(user.id);
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
        // aren't part of a guild) — resolve the actual guild the same way clientReady does.
        const matchGuild = interaction.guild ?? client.guilds.cache.first();
        const category = await channelLifecycle.getOrCreateMatchCategory(matchGuild);

        const channelName = `${isCreative ? 'creative' : 'match'}-${players.map(p => p.epicUsername).join('-')}`
          .toLowerCase()
          .replace(/\s+/g, '-')
          .slice(0, 100);

        const modRoleId = process.env.MOD_ROLE_ID;

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
      const selection = creativeSelections.get(`${user.id}:${category}`);

      if (!selection?.mode || !selection?.region) {
        return interaction.editReply({ content: '❌ Select a mode and region from the menus above first.' });
      }

      if (isInCreativeQueue(user.id) || creativeJoinInProgress.has(user.id)) {
        return interaction.editReply({
          content: '🔍 You are already in the creative queue. Click "Leave Queue" first if you want to change your selection.',
        });
      }

      if (isInTournamentActivity(user.id)) {
        return interaction.editReply({ content: '❌ You are already in a tournament queue or match. Leave it before queueing for creative.' });
      }

      creativeJoinInProgress.add(user.id);
      await interaction.editReply({ content: '⏳ Fetching your stats...' });

      try {
        const member = await guild.members.fetch(user.id);
        const platform = getPlatformFromMember(member);
        const { epicUsername, epicId } = await resolveEpicIdentity(guild, member);

        const player = await buildCreativePlayer({
          discordId: user.id,
          discordUsername: user.username,
          epicUsername,
          epicId,
          mode: selection.mode,
          region: selection.region,
          platform,
        });

        joinCreativeQueue({ player, mode: selection.mode, region: selection.region });

        await updateCreativeQueueEmbed(client, category, QUEUE_CHANNEL_CONFIGS[category]);

        await interaction.editReply({
          content: `✅ You are now in the creative queue for **${selection.mode}** (${selection.region})! We'll ping you here the moment an opponent is found.`,
        });
      } catch (err) {
        console.error('Creative queue error:', err);
        await interaction.editReply({ content: `❌ Error joining queue: ${err.message}` });
      } finally {
        creativeJoinInProgress.delete(user.id);
      }
    }

    // ── CREATIVE LEAVE QUEUE ─────────────────────────────────────────────────
    if (customId === 'creative_leave_queue') {
      await interaction.deferReply({ flags: 64 });

      const found = findCreativeUnitByDiscordId(user.id);
      if (!found) {
        return interaction.editReply({ content: '❌ You are not in the creative queue.' });
      }

      removeFromCreativeQueueAnywhere(user.id);

      const category = categoryForAnyMode(found.mode);
      if (category) await updateCreativeQueueEmbed(client, category, QUEUE_CHANNEL_CONFIGS[category]);

      await interaction.editReply({ content: '✅ You have left the creative queue.' });
    }

    // ── TEAM QUEUE BUTTON (6s/8s) ────────────────────────────────────────────
    if (customId.startsWith('team_queue_')) {
      await interaction.deferReply({ flags: 64 });

      const category = customId.replace('team_queue_', '');
      const selection = creativeSelections.get(`${user.id}:${category}`);

      if (!selection?.mode || !selection?.region) {
        return interaction.editReply({ content: '❌ Select a mode and region from the menus above first.' });
      }

      const existingParty = party.getPartyByDiscordId(user.id);
      if (existingParty && existingParty.leaderId !== user.id) {
        return interaction.editReply({ content: '❌ Only your party leader can queue the party.' });
      }

      const partyMembersRaw = existingParty ? existingParty.members : [{ discordId: user.id, username: user.username }];

      const alreadyBusy = partyMembersRaw.some(m =>
        isInCreativeQueue(m.discordId)
        || creativeTeamQueue.isInTeamQueue(m.discordId)
        || teamJoinInProgress.has(m.discordId)
        || teamMatchLifecycle.isPlayerInActiveTeamMatch(m.discordId)
      );
      if (alreadyBusy) {
        return interaction.editReply({ content: '❌ One or more of your party members is already queued or in an active match.' });
      }

      const busyWithTournament = partyMembersRaw.find(m => isInTournamentActivity(m.discordId));
      if (busyWithTournament) {
        return interaction.editReply({
          content: `❌ **${busyWithTournament.username}** is already in a tournament queue or match — leave it before queueing for creative.`,
        });
      }

      for (const m of partyMembersRaw) teamJoinInProgress.add(m.discordId);
      await interaction.editReply({ content: `⏳ Fetching stats for ${partyMembersRaw.length} player(s)...` });

      try {
        const members = await Promise.all(partyMembersRaw.map(m => guild.members.fetch(m.discordId)));

        const players = await Promise.all(members.map(async member => {
          const platform = getPlatformFromMember(member);
          const { epicUsername, epicId } = await resolveEpicIdentity(guild, member);
          return buildCreativePlayer({
            discordId: member.id,
            discordUsername: member.user.username,
            epicUsername,
            epicId,
            mode: selection.mode,
            region: selection.region,
            platform,
          });
        }));

        creativeTeamQueue.queueUnit(players, selection.mode, selection.region);

        await updateCreativeQueueEmbed(client, category, QUEUE_CHANNEL_CONFIGS[category]);

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
        for (const m of partyMembersRaw) teamJoinInProgress.delete(m.discordId);
      }
    }

    // ── TEAM LEAVE QUEUE (6s/8s) ─────────────────────────────────────────────
    if (customId === 'team_leave_queue') {
      await interaction.deferReply({ flags: 64 });

      const found = creativeTeamQueue.findUnitByDiscordId(user.id);
      if (!found) {
        return interaction.editReply({ content: '❌ You are not in the 6s/8s queue.' });
      }

      creativeTeamQueue.removeFromTeamQueueAnywhere(user.id);

      const category = categoryForAnyMode(found.mode);
      if (category) await updateCreativeQueueEmbed(client, category, QUEUE_CHANNEL_CONFIGS[category]);

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
  }
}

// ── POST ROLES EMBED ──────────────────────────────────────────────────────────
async function postRolesEmbed(channel) {
  const embed = new EmbedBuilder()
    .setTitle('🎮 Set Up Your Profile')
    .setDescription('Use the menus below to customise your MatchMaker profile.\n\n**Region is mandatory** — everything else is optional.')
    .setColor(0x1E3A5F)
    .setFooter({ text: 'MatchMaker • Complete your profile to queue' });

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

  await channel.send({
    embeds: [embed],
    components: [regionMenu, extraRegionMenu, ingameRoleMenu, languageMenu, bioButton],
  });
}

// ── ROLE ID HELPERS ───────────────────────────────────────────────────────────
function regionRoleId(region) {
  const map = {
    EU: process.env.ROLE_EU,
    NAC: process.env.ROLE_NAC,
    ME: process.env.ROLE_ME,
  };
  return map[region] ?? null;
}

function ingameRoleId(role) {
  const map = {
    Fragger: process.env.ROLE_FRAGGER,
    IGL: process.env.ROLE_IGL,
  };
  return map[role] ?? null;
}

function platformRoleId(platform) {
  const map = {
    PC: process.env.ROLE_PC,
    PS4: process.env.ROLE_CONSOLE,
    XB1: process.env.ROLE_CONSOLE,
    SWITCH: process.env.ROLE_CONSOLE,
    MOBILE: process.env.ROLE_MOBILE,
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
    const yuniteData = await getEpicFromDiscord(member.id);
    if (yuniteData.platform) {
      await assignRole(guild, member.id, platformRoleId(yuniteData.platform));
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
async function updateQueueEmbed(channelId, tournamentName, region, isTrios) {
  try {
    const channel = await client.channels.fetch(channelId);
    const pinned = pinnedMessages[channelId];
    if (!pinned) return;

    const msg = await channel.messages.fetch(pinned.messageId);
    const count = getQueueCount(tournamentName, region);
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
  if (category) await updateCreativeQueueEmbed(client, category, QUEUE_CHANNEL_CONFIGS[category]);
}

store.init()
  .catch(err => console.error('[Store] init() failed unexpectedly:', err.message))
  .finally(() => client.login(process.env.DISCORD_TOKEN));
