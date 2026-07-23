// index.js - Main bot entry point

require('dotenv').config();
const {
  Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, AuditLogEvent,
  EmbedBuilder, ActionRowBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');

const {
  buildPlayer, joinQueue, removeFromQueue, removeFromQueueAnywhere,
  getQueueCount, startMatchSweep, matchEvents, findUnitByDiscordId,
} = require('./queue');
const matching = require('./matching');
const {
  createMatch, acceptMatch, rejectMatch, getPendingMatchByDiscordId, getPendingMatchCount,
} = matching;
const { createMatchChannelsForMatch } = require('./match-channels');
// Named playerStore (not `players`) — this file uses `players` extensively as a local variable
// name for arrays of built player objects, which would otherwise shadow this module import.
const playerStore = require('./players');
const { getEpicFromDiscord, checkYuniteReachable } = require('./yunite');
const epicOAuth = require('./epic-oauth');
const { startScheduler, checkAndCreateChannels } = require('./channel-manager');
const { enforcePermissions } = require('./permissions');
const guildConfig = require('./guild-config');
const { getRoleId, getChannelId } = guildConfig;
const { runMatchmakerSetup } = require('./matchmaker-setup');
const {
  buildTournamentEmbed, buildQueueButtons, buildLeaveQueueButton,
  buildMatchConfirmedEmbed,
  buildPartyInviteEmbed, buildPartyInviteButtons, buildPartyStatusEmbed,
  buildFormPartyInstructionsEmbed, buildPartyInviteOpenButtonRow, buildUserSelectRow,
  buildPartyChannelInstructionsEmbed, buildPartyChannelButtonRow,
  buildCreativeMatchConfirmedEmbed, buildCloseChannelButton,
  buildHowtoEmbed, buildRolesEmbed, buildRolesComponents,
  buildAccessStatusEmbed, buildAccessSubscribeButtons, buildNoAccessEmbed,
  buildUseCreditsButton, buildCreditWindowStartedDmEmbed,
  buildBotStatusEmbed, buildQueueStatusEmbed, buildPlayerLookupEmbed,
  buildEpicAuthorizeLinkRow,
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
const { dmUser } = require('./discord-dm');
const { startWebhookServer, simulateCheckoutCompleted } = require('./webhook-server');
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

// Queue join/leave ephemeral replies auto-dismiss after 10s so repeat queue/leave clicks don't
// leave a stack of dismiss-it-yourself messages in the channel. Fire-and-forget delete — errors
// (e.g. the interaction token already expired) are swallowed, nothing depends on it succeeding.
const EPHEMERAL_AUTO_DISMISS_MS = 10000;
async function replyAndDismiss(interaction, payload, ms = EPHEMERAL_AUTO_DISMISS_MS) {
  await interaction.editReply(payload);
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
}

// Persistent "you are in queue" ephemeral status, shared by the tournament, creative 1v1/2v2,
// and 6s/8s team queues. Unlike replyAndDismiss, this message stays up and re-renders its wait
// time every minute (via the same interaction's editReply — interaction tokens are only good for
// ~15 minutes, so a tick that fails past that point just stops quietly rather than erroring).
// Keyed by `${guildId}:${discordId}` so a repeat Queue click (or the player re-clicking after
// switching channels) replaces rather than doubles up the running timer.
const queueStatusTimers = new Map();

function stopQueueStatusMessage(guildId, discordId) {
  const key = `${guildId}:${discordId}`;
  const timer = queueStatusTimers.get(key);
  if (timer) {
    clearInterval(timer);
    queueStatusTimers.delete(key);
  }
}

function formatWaitTime(joinedAt) {
  const elapsedSec = Math.max(0, Math.floor((Date.now() - new Date(joinedAt).getTime()) / 1000));
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const ss = String(elapsedSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

async function sendQueueStatusMessage(interaction, guildId, discordId, label, joinedAt, leaveCustomId) {
  stopQueueStatusMessage(guildId, discordId);

  const render = () => ({
    content: `🔍 You are in queue for **${label}** — waiting ${formatWaitTime(joinedAt)}`,
    components: [buildLeaveQueueButton(leaveCustomId)],
  });

  await interaction.editReply(render());

  const key = `${guildId}:${discordId}`;
  const timer = setInterval(async () => {
    try {
      await interaction.editReply(render());
    } catch (err) {
      clearInterval(timer);
      queueStatusTimers.delete(key);
    }
  }, 60 * 1000);

  queueStatusTimers.set(key, timer);
}

// Shared by the /party-invite command and the ➕ Invite to Party button + user-select flow —
// `interaction` just needs to already be deferred (deferReply for the command, deferUpdate for
// the select menu) with editReply available; `invited` is the target User either way.
async function handlePartyInviteRequest(interaction, invited) {
  const guild = interaction.guild;
  const leader = interaction.user;

  if (interaction.channelId !== getChannelId(guild.id, 'formParty')) {
    return interaction.editReply({
      content: `❌ Use this in <#${getChannelId(guild.id, 'formParty')}>.`,
    });
  }

  if (invited.id === leader.id) {
    return interaction.editReply({ content: '❌ You cannot invite yourself.' });
  }
  if (invited.bot) {
    return interaction.editReply({ content: '❌ You cannot invite a bot.' });
  }
  if (party.hasPendingInvite(guild.id, leader.id)) {
    return interaction.editReply({ content: '❌ You already have a pending invite out. Wait for it to resolve first.' });
  }
  if (!party.canAddMember(guild.id, leader.id)) {
    return interaction.editReply({ content: `❌ Your party is already at the ${party.MAX_PARTY_SIZE}-member cap.` });
  }
  if (party.isInParty(guild.id, invited.id) || party.hasPendingInvite(guild.id, invited.id)) {
    return interaction.editReply({ content: `❌ **${invited.username}** is already in a party or has a pending invite.` });
  }

  const existingParty = party.getPartyByDiscordId(guild.id, leader.id);
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
      privateChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: formPartyChannel.parentId ?? null,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
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
    guildId: guild.id,
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

// Shared by /party-leave and the 🚪 Leave Party button posted in the party's private channel —
// looked up by discordId, not by channel, so it works from either place (or anywhere else).
async function handlePartyLeaveRequest(interaction) {
  const guild = interaction.guild;
  const record = party.getPartyByDiscordId(guild.id, interaction.user.id);
  if (!record) {
    return interaction.editReply({ content: '❌ You are not in a party.' });
  }

  const memberIds = record.members.map(m => m.discordId);

  // Reject any pending match first (requeues both units in that match, and tears down its
  // channel cluster — the match channel now exists from the moment a match is found, not
  // just after confirm, so this can't be skipped anymore).
  for (const discordId of memberIds) {
    const pending = getPendingMatchByDiscordId(guild.id, discordId);
    if (pending) {
      const result = rejectMatch(pending.matchId, discordId);
      if (result.status === 'rejected') {
        await closeMatchChannelCluster(result.channelsByGuildId, '❌ Match declined — a party member disbanded. This channel will close shortly.');
      }
    }
  }
  // ...then pull the disbanding unit back out again, wherever it ended up.
  for (const discordId of memberIds) {
    removeFromQueueAnywhere(guild.id, discordId);
    stopQueueStatusMessage(guild.id, discordId);
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

// Shared by /party-status and the ℹ️ Party Status button posted in the party's private channel.
async function handlePartyStatusRequest(interaction) {
  const record = party.getPartyByDiscordId(interaction.guild.id, interaction.user.id);
  if (!record) {
    return interaction.editReply({ content: '❌ You are not in a party. Use /party-invite (or the button in #form-party) to form one.' });
  }

  await interaction.editReply({ embeds: [buildPartyStatusEmbed(record)] });
}

// Shared by /votekick and the 🗳️ Vote Kick button + user-select posted in the match channel
// itself — only usable inside a private match channel (tournament "match-...", or a 6s/8s team
// match "team-6s-.../team-8s-..." — see team-match-lifecycle.js's channel naming).
// handleVoteKickCommand is the authoritative check (an active team match must actually exist for
// this channel); the name check here is just a fast, clear rejection for anyone triggering it
// somewhere obviously wrong.
async function handleVoteKickRequest(interaction, target) {
  const name = interaction.channel.name;
  if (!(name.startsWith('match-') || name.includes('6s-') || name.includes('8s-'))) {
    return interaction.editReply({ content: '❌ This only works inside a private match channel.' });
  }

  const result = teamMatchLifecycle.handleVoteKickCommand(interaction.channelId, interaction.user.id, target.id);

  if (result.status === 'not_in_match') {
    return interaction.editReply({ content: '❌ This only works inside an active 6s/8s match channel.' });
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

  // Broadcast to every channel in the match's cluster, not just this one — anyone in any
  // involved guild's channel should be able to vote.
  await teamMatchLifecycle.broadcastVoteKickStart(
    result.matchState, client, interaction.user.username, target.username, result.voteId, result.eligibleCount
  );

  teamMatchLifecycle.startVoteResolutionTimer(interaction.channelId, result.voteId, client);
}

// Shared by /refresh-stats and the 🔄 Refresh Stats button posted in #access.
async function handleRefreshStatsRequest(interaction) {
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

// Fires the one-time "your trial has ended" DM the moment a player's credit window actually
// starts (access.js's ensureCreditWindowStarted, surfaced via checkAccess/getAccessStatus's
// creditWindowJustStarted flag) — a player-triggered event, not something a periodic sweep
// should discover after the fact, so this is called directly from every access-gating call site
// and the Check My Access handler rather than from notifications.js.
async function notifyCreditWindowStartedIfNeeded(client, discordId, accessResult) {
  if (!accessResult?.creditWindowJustStarted) return;
  const { creditsEarned, estimatedDays } = accessResult.windowStartInfo;
  await dmUser(client, discordId, { embeds: [buildCreditWindowStartedDmEmbed(creditsEarned, estimatedDays)] });
}

// Non-empty queue buckets, one entry per tournament/mode+region combo currently holding at
// least one player — shared by /bot-status (just the count) and /queue-status (the full list).
// The queue pool is global (cross-server matchmaking), so these are global counts, not scoped to
// the calling guild — guildId is kept as a parameter for call-site compatibility but unused.
function getTournamentQueueEntries(guildId) {
  const entries = [];
  for (const tournamentName of Object.keys(store.queues)) {
    for (const region of Object.keys(store.queues[tournamentName])) {
      const count = getQueueCount(guildId, tournamentName, region);
      if (count > 0) entries.push({ label: `${tournamentName} / ${region}`, count });
    }
  }
  return entries;
}

function getCreativeQueueEntries(guildId) {
  const entries = [];
  for (const mode of Object.keys(store.creativeQueues)) {
    for (const region of Object.keys(store.creativeQueues[mode])) {
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
  // The queue pool is global (cross-server matchmaking) — a match's involved guild(s) come from
  // the matched players themselves, not one event-level guildId, so these listeners hand off to
  // `client` and let notifyMatchFound/notifyCreativeMatchFound/startTeamMatch resolve guilds
  // per-player via match-channels.js / team-match-lifecycle.js.
  matchEvents.on('matchFound', ({ unitA, unitB, tournamentName, region }) => {
    for (const p of [...unitA.members, ...unitB.members]) stopQueueStatusMessage(p.guildId, p.discordId);
    notifyMatchFound(unitA, unitB, tournamentName, region, client).catch(console.error);
  });

  startCreativeMatchSweep();
  creativeMatchEvents.on('matchFound', ({ unitA, unitB, mode, region }) => {
    for (const p of [...unitA.members, ...unitB.members]) stopQueueStatusMessage(p.guildId, p.discordId);
    notifyCreativeMatchFound(unitA, unitB, mode, region, client).catch(console.error);
  });

  creativeTeamQueue.startCreativeTeamMatchSweep();
  creativeTeamQueue.creativeTeamMatchEvents.on('matchFormed', ({ units, players, mode, region, completingGuildId }) => {
    for (const p of players) stopQueueStatusMessage(p.guildId, p.discordId);
    teamMatchLifecycle.startTeamMatch(units, mode, region, completingGuildId, client).catch(console.error);
  });

  matching.matchLifecycleEvents.on('expired', ({ channelsByGuildId }) => {
    closeMatchChannelCluster(channelsByGuildId, '⌛ This match expired with no response — you have been re-queued automatically.').catch(console.error);
  });

  channelLifecycle.restoreScheduledDeletions(client);
  channelLifecycle.channelLifecycleEvents.on('channelDeleted', ({ channels, kind }) => {
    if (kind === 'creative-team') {
      for (const c of channels) teamMatchLifecycle.endTeamMatch(c.textChannelId);
    }
  });

  startAccessScheduler(client);
});

// Only fires for guilds joined WHILE the bot is running — guildConfig.init() (above) handles
// backfilling config for guilds already joined at startup, without sending a DM for those.
client.on('guildCreate', guild => guildConfig.handleNewGuild(guild).catch(console.error));

// ── MOD ROLE GRANT GUARD ────────────────────────────────────────────────────────
// The only sanctioned ways to hold the MatchMaker Mod role are /grant-mod (owner-only — see the
// interaction handler above) or a server Administrator assigning it by hand in Discord. Anyone
// else adding it — e.g. a non-admin with Manage Roles poking it on in the member list — gets it
// immediately stripped back off and a DM explaining why, rather than silently letting it stand
// until someone notices.
client.on('guildMemberUpdate', (oldMember, newMember) => {
  guardModRoleGrant(oldMember, newMember).catch(console.error);
});

async function guardModRoleGrant(oldMember, newMember) {
  const guild = newMember.guild;
  const modRoleId = getRoleId(guild.id, 'mod');
  if (!modRoleId) return;

  // Only care about the role being newly gained, not lost or untouched.
  if (oldMember.roles.cache.has(modRoleId) || !newMember.roles.cache.has(modRoleId)) return;

  let executor = null;
  try {
    const auditLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 5 });
    const entry = auditLogs.entries.find(e =>
      e.target?.id === newMember.id
      && e.changes?.some(c => c.key === '$add' && Array.isArray(c.new) && c.new.some(r => r.id === modRoleId))
    );
    executor = entry?.executor ?? null;
  } catch (err) {
    console.error('Failed to fetch audit logs for MatchMaker Mod grant check:', err.message);
  }

  if (!executor) {
    console.warn(`⚠️ MatchMaker Mod role was granted to ${newMember.user.tag} but the assigner could not be determined from audit logs — leaving it as-is.`);
    return;
  }

  // /grant-mod performs the role add via the bot's own API call, so it shows up in the audit log
  // with the bot itself as executor, not the owner who ran the command — that path is already
  // gated to the guild owner in the command handler above, so it's exempt here.
  if (executor.id === client.user.id) return;

  const executorMember = await guild.members.fetch(executor.id).catch(() => null);
  if (executorMember?.permissions.has(PermissionFlagsBits.Administrator)) return;

  try {
    await newMember.roles.remove(modRoleId, `Unauthorized MatchMaker Mod grant by ${executor.tag ?? executor.id}`);
  } catch (err) {
    console.error('Failed to remove unauthorized MatchMaker Mod role grant:', err.message);
  }

  await dmUser(client, executor.id, {
    content: 'You do not have permission to assign the MatchMaker Mod role — only server administrators can do this.',
  });

  console.log(`🚫 Reverted unauthorized MatchMaker Mod grant: ${executor.tag ?? executor.id} tried to assign it to ${newMember.user.tag}.`);
}

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
      const msg = await interaction.channel.send({
        embeds: [buildFormPartyInstructionsEmbed()],
        components: [buildPartyInviteOpenButtonRow()],
      });
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

    // /votekick — fallback for handleVoteKickRequest below (the primary path is now the
    // 🗳️ Vote Kick button + user-select posted in the match channel itself).
    if (interaction.commandName === 'votekick') {
      await interaction.deferReply({ flags: 64 });
      await handleVoteKickRequest(interaction, interaction.options.getUser('player'));
    }

    // /refresh-stats — force a rescrape of the caller's own stats, rate-limited to once/hour
    // (players.js's refreshPlayerStats) so this can't be used to hammer FT Tracker.
    // Fallback for handleRefreshStatsRequest below (the primary path is now the 🔄 Refresh Stats
    // button posted in #access).
    if (interaction.commandName === 'refresh-stats') {
      await interaction.deferReply({ flags: 64 });
      await handleRefreshStatsRequest(interaction);
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
      const yuniteVerifiedRole = interaction.options.getRole('yunite-verified-role');

      try {
        const result = await runMatchmakerSetup(interaction.guild, yuniteToken, yuniteVerifiedRole?.id ?? null);
        await interaction.editReply({ content: result.summary });
      } catch (err) {
        console.error('matchmaker-setup failed:', err.message);
        await interaction.editReply({ content: `❌ Setup failed: ${err.message}` });
      }
    }

    // /party-invite — fallback for handlePartyInviteRequest below (the primary path is now the
    // ➕ Invite to Party button + user-select in #form-party).
    if (interaction.commandName === 'party-invite') {
      await interaction.deferReply({ flags: 64 });
      await handlePartyInviteRequest(interaction, interaction.options.getUser('user'));
    }

    // /party-leave — fallback for handlePartyLeaveRequest below (the primary path is now the
    // 🚪 Leave Party button posted in the party's own private channel).
    if (interaction.commandName === 'party-leave') {
      await interaction.deferReply({ flags: 64 });
      await handlePartyLeaveRequest(interaction);
    }

    // /party-status — fallback for handlePartyStatusRequest below (the primary path is now the
    // ℹ️ Party Status button posted in the party's own private channel).
    if (interaction.commandName === 'party-status') {
      await interaction.deferReply({ flags: 64 });
      await handlePartyStatusRequest(interaction);
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
        access.getAccessStatus(target.id, { allowWindowStart: false }),
      ]);

      await interaction.editReply({ embeds: [buildPlayerLookupEmbed(target, playerDoc, accessStatus)] });
    }

    // /clear-queue — the queue pool is global (cross-server matchmaking), so this clears the
    // tournament's queue everywhere, not just for this guild's players.
    if (interaction.commandName === 'clear-queue') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);

      const guildId = interaction.guild.id;
      const tournamentName = interaction.options.getString('tournament');
      const matchedKey = Object.keys(store.queues).find(k => k.toLowerCase() === tournamentName.toLowerCase());

      if (!matchedKey) {
        return interaction.editReply({ content: `❌ No active queue found for "${tournamentName}".` });
      }

      let cleared = 0;
      for (const region of Object.keys(store.queues[matchedKey])) {
        cleared += getQueueCount(guildId, matchedKey, region);
        store.queues[matchedKey][region] = [];
      }
      saveStore(guildId);

      await interaction.editReply({ content: `✅ Cleared **${matchedKey}** globally — removed ${cleared} player(s) across all regions and servers.` });
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

    // /grant-mod — server-owner-only, not gated by isModMember like the other mod commands above.
    // This is the only path in the bot that assigns the MatchMaker Mod role — anyone who already
    // holds it could otherwise grant it to others (or themselves again) indefinitely, so the
    // check is against the actual Discord guild owner rather than the mod role itself.
    if (interaction.commandName === 'grant-mod') {
      await interaction.deferReply({ flags: 64 });

      if (interaction.guild.ownerId !== interaction.user.id) {
        return interaction.editReply({ content: '❌ Only the server owner can grant the MatchMaker Mod role.' });
      }

      const modRoleId = getRoleId(interaction.guild.id, 'mod');
      if (!modRoleId) {
        return interaction.editReply({ content: '❌ No MatchMaker Mod role configured for this server — run /matchmaker-setup first.' });
      }

      const target = interaction.options.getUser('user');
      try {
        const member = await interaction.guild.members.fetch(target.id);
        await member.roles.add(modRoleId);
        await interaction.editReply({ content: `✅ Granted MatchMaker Mod to **${target.username}**.` });
      } catch (err) {
        console.error('grant-mod error:', err);
        await interaction.editReply({ content: `❌ Failed to grant MatchMaker Mod: ${err.message}` });
      }
    }

    // /test-webhook — manually runs the same DB-write + cache-invalidation path a real Stripe
    // checkout.session.completed webhook would, with a fabricated expiry instead of a real
    // Stripe subscription (see webhook-server.js's simulateCheckoutCompleted). Lets mods verify
    // #access/the credit-gate reflects an active subscription without a real payment.
    if (interaction.commandName === 'test-webhook') {
      await interaction.deferReply({ flags: 64 });
      if (!isModMember(interaction.guild.id, interaction)) return replyModOnly(interaction);

      const target = interaction.options.getUser('user') ?? interaction.user;
      const plan = interaction.options.getString('plan') ?? 'monthly';

      try {
        const subscriptionExpiry = await simulateCheckoutCompleted(target.id, plan);
        await interaction.editReply({
          content: `✅ Simulated a **${plan}** checkout.session.completed for **${target.username}** — access active until **${subscriptionExpiry.toISOString()}**. Check #access or the Subscription collection to verify.`,
        });
      } catch (err) {
        console.error('test-webhook error:', err);
        await interaction.editReply({ content: `❌ Failed to simulate webhook event: ${err.message}` });
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
      await playerStore.upsertPlayer(guildId, user.id, { languages: values });
      await interaction.editReply({ content: `✅ Language(s) set to **${values.join(', ')}**.` });
    }

    if (customId === 'select_age_bracket') {
      await playerStore.upsertPlayer(guildId, user.id, { ageBracket: values[0] });
      await interaction.editReply({ content: `✅ Age bracket set to **${values[0]}**.` });
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

  // ── USER SELECT MENUS ─────────────────────────────────────────────────────────
  if (interaction.isUserSelectMenu()) {
    if (interaction.customId === 'party_invite_select') {
      await interaction.deferUpdate();
      const invited = interaction.users.first();
      await handlePartyInviteRequest(interaction, invited);
    }

    if (interaction.customId === 'votekick_select') {
      await interaction.deferUpdate();
      const target = interaction.users.first();
      await handleVoteKickRequest(interaction, target);
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

    // ── EPIC ACCOUNT LINK (posted in #register) ───────────────────────────────
    if (customId === 'epic_link_open') {
      if (channelId !== getChannelId(guild.id, 'register')) {
        return interaction.reply({
          content: `❌ Use this in <#${getChannelId(guild.id, 'register')}>.`,
          flags: 64,
        });
      }
      if (!epicOAuth.isConfigured()) {
        return interaction.reply({
          content: '❌ Epic account linking isn\'t set up for this bot yet — link via Yunite in this channel instead.',
          flags: 64,
        });
      }

      const url = epicOAuth.buildAuthorizeUrl(user.id, guild.id);
      await interaction.reply({
        content: '🔗 Click below to link your Epic account. This link expires in 10 minutes.',
        components: [buildEpicAuthorizeLinkRow(url)],
        flags: 64,
      });
    }

    // ── PARTY INVITE OPEN (button + user-select, primary path for /party-invite) ─────────────
    if (customId === 'party_invite_open') {
      if (channelId !== getChannelId(guild.id, 'formParty')) {
        return interaction.reply({
          content: `❌ Use this in <#${getChannelId(guild.id, 'formParty')}>.`,
          flags: 64,
        });
      }
      await interaction.reply({
        content: 'Select a player to invite to your party:',
        components: [buildUserSelectRow('party_invite_select', 'Choose a player to invite')],
        flags: 64,
      });
    }

    // ── PARTY LEAVE / STATUS BUTTONS (posted in the party's own private channel) ──────────────
    if (customId === 'party_leave_btn') {
      await interaction.deferReply({ flags: 64 });
      await handlePartyLeaveRequest(interaction);
    }

    if (customId === 'party_status_btn') {
      await interaction.deferReply({ flags: 64 });
      await handlePartyStatusRequest(interaction);
    }

    // ── REFRESH STATS BUTTON (posted in #access) ──────────────────────────────────────────────
    if (customId === 'access_refresh_stats') {
      await interaction.deferReply({ flags: 64 });
      await handleRefreshStatsRequest(interaction);
    }

    // ── VOTE KICK OPEN (button + user-select, primary path for /votekick) ────────────────────
    if (customId === 'votekick_open') {
      const name = interaction.channel.name;
      if (!(name.startsWith('match-') || name.includes('6s-') || name.includes('8s-'))) {
        return interaction.reply({ content: '❌ This only works inside a private match channel.', flags: 64 });
      }
      await interaction.reply({
        content: 'Select a player to vote-kick:',
        components: [buildUserSelectRow('votekick_select', 'Choose a player to vote-kick')],
        flags: 64,
      });
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

      const instructionsMsg = await interaction.channel.send({
        embeds: [buildPartyChannelInstructionsEmbed()],
        components: [buildPartyChannelButtonRow()],
      });
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
        return replyAndDismiss(interaction, { content: '❌ Could not find tournament info for this channel.' });
      }

      const { tournamentName, region, isTrios, consoleOnly } = pinned;
      const queueType = customId.replace('queue_', '');

      const member = await guild.members.fetch(user.id);

      if (!member.roles.cache.has(getRoleId(guild.id, 'Registered'))) {
        return replyAndDismiss(interaction, {
          content: `❌ Complete your profile in <#${getChannelId(guild.id, 'getRoles')}> first (set your region).`,
        });
      }

      const platform = getPlatformFromMember(guild.id, member);

      if (consoleOnly && isPCPlayer(guild.id, member)) {
        return replyAndDismiss(interaction, {
          content: '❌ This is a console-only tournament. PC players cannot queue here.',
        });
      }
      if (consoleOnly && !isConsolePlayer(guild.id, member)) {
        return replyAndDismiss(interaction, {
          content: '❌ This is a console-only tournament. You must have the Console role to queue.',
        });
      }

      if (queueType === 'lf2' && party.isInParty(guild.id, user.id)) {
        return replyAndDismiss(interaction, {
          content: '❌ You are in a party — ask your party leader to click "Looking for 1", or run /party-leave to queue solo.',
        });
      }

      const existingTournamentUnit = findUnitByDiscordId(guild.id, user.id);
      if (existingTournamentUnit) {
        if (existingTournamentUnit.tournamentName === tournamentName && existingTournamentUnit.region === region) {
          return sendQueueStatusMessage(
            interaction, guild.id, user.id, tournamentName, existingTournamentUnit.unit.joinedAt, 'leave_queue'
          );
        }
        return replyAndDismiss(interaction, {
          content: `❌ You are already queued for **${existingTournamentUnit.tournamentName}** (${existingTournamentUnit.region}) — leave that queue before joining another.`,
        });
      }

      if (isInCreativeActivity(guild.id, user.id)) {
        return replyAndDismiss(interaction, { content: '❌ You are already in a creative queue or match. Leave it before queueing for a tournament.' });
      }

      const tournamentAccess = await access.checkAccess(user.id);
      if (!tournamentAccess.allowed) {
        await notifyCreditWindowStartedIfNeeded(client, user.id, tournamentAccess);
        return replyAndDismiss(interaction, {
          embeds: [buildNoAccessEmbed(tournamentAccess)],
          components: [buildAccessSubscribeButtons()],
        });
      }

      await replyAndDismiss(interaction, { content: '⏳ Fetching your stats...' });

      try {
        const { epicUsername, epicId } = await resolveEpicIdentity(guild, member);

        const userData = await playerStore.getPlayer(guild.id, user.id);
        const homeRegion = userData?.region ?? region;

        const player = await buildPlayer({
          guildId: guild.id,
          guildName: guild.name,
          discordId: user.id,
          discordUsername: user.username,
          discordTag: user.tag,
          epicUsername,
          epicId,
          tournamentName,
          homeRegion,
          queueRegion: region,
          queueType,
          platform,
          consoleOnly,
          ingameRoles: userData?.ingameRoles ?? [],
          languages: userData?.languages ?? [],
          ageBracket: userData?.ageBracket ?? null,
          bio: userData?.bio ?? null,
        });

        const { unit } = await joinQueue({ guildId: guild.id, players: [player], tournamentName, region, queueType });

        await updateQueueEmbed(guild.id, channelId, tournamentName, region, isTrios);

        await sendQueueStatusMessage(interaction, guild.id, user.id, tournamentName, unit.joinedAt, 'leave_queue');

      } catch (err) {
        console.error('Queue error:', err);
        await replyAndDismiss(interaction, { content: `❌ Error joining queue: ${err.message}` });
      }
    }

    // ── PARTY QUEUE BUTTON ("Looking for 1", trios only) ──────────────────────
    if (customId === 'queue_lf1') {
      await interaction.deferReply({ flags: 64 });

      const pinned = pinnedMessages[channelId];
      if (!pinned) {
        return replyAndDismiss(interaction, { content: '❌ Could not find tournament info for this channel.' });
      }

      const { tournamentName, region, isTrios, consoleOnly } = pinned;

      const partyRecord = party.getPartyByDiscordId(guild.id, user.id);
      if (!partyRecord) {
        return replyAndDismiss(interaction, {
          content: '❌ You need an active party to queue here. Use /party-invite in #form-party, or click "Looking for 2" to queue solo.',
        });
      }
      if (partyRecord.leaderId !== user.id) {
        return replyAndDismiss(interaction, {
          content: '❌ Only your party leader can queue the party. Ask them to click "Looking for 1".',
        });
      }
      if (partyRecord.members.length !== 2) {
        return replyAndDismiss(interaction, {
          content: `❌ Trios queueing needs a party of exactly 2 (yours has ${partyRecord.members.length}) — trios teams are fixed at 3 players total.`,
        });
      }

      const partyMembers = await Promise.all(partyRecord.members.map(m => guild.members.fetch(m.discordId)));

      const unregistered = partyMembers.find(m => !m.roles.cache.has(getRoleId(guild.id, 'Registered')));
      if (unregistered) {
        return replyAndDismiss(interaction, {
          content: `❌ **${unregistered.user.username}** needs to complete their profile in <#${getChannelId(guild.id, 'getRoles')}> first (set their region).`,
        });
      }

      for (const member of partyMembers) {
        const platform = getPlatformFromMember(guild.id, member);
        if (consoleOnly && platform === 'PC') {
          return replyAndDismiss(interaction, {
            content: `❌ This is a console-only tournament. **${member.user.username}** is registered as PC and cannot queue here.`,
          });
        }
        if (consoleOnly && platform !== 'Console') {
          return replyAndDismiss(interaction, {
            content: `❌ This is a console-only tournament. **${member.user.username}** must have the Console role to queue.`,
          });
        }
      }

      for (const member of partyMembers) {
        const memberUnit = findUnitByDiscordId(guild.id, member.id);
        if (memberUnit) {
          if (member.id === user.id && memberUnit.tournamentName === tournamentName && memberUnit.region === region) {
            return sendQueueStatusMessage(
              interaction, guild.id, user.id, tournamentName, memberUnit.unit.joinedAt, 'leave_queue'
            );
          }
          return replyAndDismiss(interaction, { content: `❌ **${member.user.username}** is already queued for **${memberUnit.tournamentName}** (${memberUnit.region}) — leave that queue first.` });
        }
        if (getPendingMatchByDiscordId(guild.id, member.id)) {
          return replyAndDismiss(interaction, { content: `❌ **${member.user.username}** already has a pending match to resolve first.` });
        }
        if (isInCreativeActivity(guild.id, member.id)) {
          return replyAndDismiss(interaction, { content: `❌ **${member.user.username}** is already in a creative queue or match — leave it before queueing for a tournament.` });
        }
      }

      for (const member of partyMembers) {
        const memberAccess = await access.checkAccess(member.id);
        if (!memberAccess.allowed) {
          await notifyCreditWindowStartedIfNeeded(client, member.id, memberAccess);
          return replyAndDismiss(interaction, {
            embeds: [buildNoAccessEmbed(memberAccess)],
            components: [buildAccessSubscribeButtons()],
          });
        }
      }

      await replyAndDismiss(interaction, { content: '⏳ Fetching stats for both party members...' });

      try {
        const players = await Promise.all(partyMembers.map(async member => {
          const userData = await playerStore.getPlayer(guild.id, member.id);
          const identity = await resolveEpicIdentity(guild, member);
          return buildPlayer({
            guildId: guild.id,
            guildName: guild.name,
            discordId: member.id,
            discordUsername: member.user.username,
            discordTag: member.user.tag,
            epicUsername: identity.epicUsername,
            epicId: identity.epicId,
            tournamentName,
            homeRegion: userData?.region ?? region,
            queueRegion: region,
            queueType: 'lf1',
            platform: getPlatformFromMember(guild.id, member),
            consoleOnly,
            ingameRoles: userData?.ingameRoles ?? [],
            languages: userData?.languages ?? [],
            ageBracket: userData?.ageBracket ?? null,
            bio: userData?.bio ?? null,
          });
        }));

        const { unit } = await joinQueue({
          guildId: guild.id,
          players,
          tournamentName,
          region,
          queueType: 'lf1',
          partyId: partyRecord.partyId,
        });

        await updateQueueEmbed(guild.id, channelId, tournamentName, region, isTrios);

        await sendQueueStatusMessage(interaction, guild.id, user.id, tournamentName, unit.joinedAt, 'leave_queue');

      } catch (err) {
        console.error('Party queue error:', err);
        await replyAndDismiss(interaction, { content: `❌ Error joining queue: ${err.message}` });
      }
    }

    // ── LEAVE QUEUE ──────────────────────────────────────────────────────────
    if (customId === 'leave_queue') {
      await interaction.deferReply({ flags: 64 });

      const pinned = pinnedMessages[channelId];
      if (!pinned) return replyAndDismiss(interaction, { content: '❌ Could not find tournament info.' });

      const { tournamentName, region, isTrios } = pinned;
      const removed = removeFromQueue(guild.id, user.id, tournamentName, region);

      if (removed) {
        stopQueueStatusMessage(guild.id, user.id);
        await updateQueueEmbed(guild.id, channelId, tournamentName, region, isTrios);
        const inParty = party.isInParty(guild.id, user.id);
        await replyAndDismiss(interaction, {
          content: inParty
            ? '✅ You have left the queue. Your party is still active — queue again anytime.'
            : '✅ You have left the queue.',
        });
      } else {
        await replyAndDismiss(interaction, { content: '❌ You were not in the queue.' });
      }
    }

    // ── ACCEPT MATCH ─────────────────────────────────────────────────────────
    // The match channel itself was created immediately when the match was found (see
    // notifyMatchFound/notifyCreativeMatchFound + match-channels.js) — Accept just resolves
    // whether everyone's in, no channel creation happens here anymore.
    if (customId.startsWith('accept_')) {
      await interaction.deferReply({ flags: 64 });

      const matchId = customId.replace('accept_', '');
      const result = acceptMatch(matchId, user.id);

      if (result.status === 'not_found') {
        return interaction.editReply({ content: '❌ This match has expired.' });
      }

      if (result.status === 'waiting') {
        const match = matching.getMatch(matchId);
        if (match) {
          await notifyOtherMatchChannels(
            match, interaction.guildId,
            `✅ **${user.username}** accepted (${result.acceptedCount}/${result.totalCount}).`
          );
        }
        return interaction.editReply({
          content: `✅ You accepted! Waiting for ${result.totalCount - result.acceptedCount} more player(s)...`,
        });
      }

      if (result.status === 'confirmed') {
        await confirmMatchChannels(result.match);
        await interaction.editReply({ content: '✅ Match confirmed! Check the channel for details.' });
      }
    }

    // ── CREATIVE QUEUE BUTTON ────────────────────────────────────────────────
    if (customId.startsWith('creative_queue_')) {
      await interaction.deferReply({ flags: 64 });

      const category = customId.replace('creative_queue_', '');
      const selection = creativeSelections.get(`${guild.id}:${user.id}:${category}`);

      if (!selection?.mode || !selection?.region) {
        return replyAndDismiss(interaction, { content: '❌ Select a mode and region from the menus above first.' });
      }

      const joinKey = `${guild.id}:${user.id}`;

      if (isInCreativeQueue(guild.id, user.id)) {
        const existingCreativeUnit = findCreativeUnitByDiscordId(guild.id, user.id);
        return sendQueueStatusMessage(
          interaction, guild.id, user.id,
          `${existingCreativeUnit.mode} (${existingCreativeUnit.region})`,
          existingCreativeUnit.unit.joinedAt, 'creative_leave_queue'
        );
      }

      if (creativeTeamQueue.isInTeamQueue(guild.id, user.id)) {
        return replyAndDismiss(interaction, {
          content: '🔍 You are already in the 6s/8s queue. Click "Leave Queue" first if you want to queue for 1v1/2v2 instead.',
          components: [buildLeaveQueueButton('team_leave_queue')],
        });
      }

      const pendingCreativeMatch = getPendingMatchByDiscordId(guild.id, user.id);
      if (
        (pendingCreativeMatch && pendingCreativeMatch.match.kind === 'creative')
        || teamMatchLifecycle.isPlayerInActiveTeamMatch(guild.id, user.id)
        || creativeJoinInProgress.has(joinKey)
      ) {
        return replyAndDismiss(interaction, {
          content: '❌ You are already in an active creative match or mid-join. Try again once it resolves.',
        });
      }

      if (isInTournamentActivity(guild.id, user.id)) {
        return replyAndDismiss(interaction, { content: '❌ You are already in a tournament queue or match. Leave it before queueing for creative.' });
      }

      creativeJoinInProgress.add(joinKey);
      await replyAndDismiss(interaction, { content: '⏳ Fetching your stats...' });

      try {
        const member = await guild.members.fetch(user.id);

        if (!member.roles.cache.has(getRoleId(guild.id, 'Registered'))) {
          return replyAndDismiss(interaction, {
            content: `❌ Complete your profile in <#${getChannelId(guild.id, 'getRoles')}> first (set your region).`,
          });
        }

        const creativeAccess = await access.checkAccess(user.id);
        if (!creativeAccess.allowed) {
          await notifyCreditWindowStartedIfNeeded(client, user.id, creativeAccess);
          return replyAndDismiss(interaction, {
            embeds: [buildNoAccessEmbed(creativeAccess)],
            components: [buildAccessSubscribeButtons()],
          });
        }

        const platform = getPlatformFromMember(guild.id, member);
        const { epicUsername, epicId } = await resolveEpicIdentity(guild, member);

        const player = await buildCreativePlayer({
          guildId: guild.id,
          guildName: guild.name,
          discordId: user.id,
          discordUsername: user.username,
          discordTag: user.tag,
          epicUsername,
          epicId,
          mode: selection.mode,
          region: selection.region,
          platform,
        });

        const { unit } = joinCreativeQueue({ guildId: guild.id, player, mode: selection.mode, region: selection.region });

        await updateCreativeQueueEmbed(guild.id, client, category, QUEUE_CHANNEL_CONFIGS[category]);

        await sendQueueStatusMessage(
          interaction, guild.id, user.id, `${selection.mode} (${selection.region})`, unit.joinedAt, 'creative_leave_queue'
        );
      } catch (err) {
        console.error('Creative queue error:', err);
        await replyAndDismiss(interaction, { content: `❌ Error joining queue: ${err.message}` });
      } finally {
        creativeJoinInProgress.delete(joinKey);
      }
    }

    // ── CREATIVE LEAVE QUEUE ─────────────────────────────────────────────────
    if (customId === 'creative_leave_queue') {
      await interaction.deferReply({ flags: 64 });

      const found = findCreativeUnitByDiscordId(guild.id, user.id);
      if (!found) {
        return replyAndDismiss(interaction, { content: '❌ You are not in the creative queue.' });
      }

      removeFromCreativeQueueAnywhere(guild.id, user.id);
      stopQueueStatusMessage(guild.id, user.id);

      const category = categoryForAnyMode(found.mode);
      if (category) await updateCreativeQueueEmbed(guild.id, client, category, QUEUE_CHANNEL_CONFIGS[category]);

      await replyAndDismiss(interaction, { content: '✅ You have left the creative queue.' });
    }

    // ── TEAM QUEUE BUTTON (6s/8s) ────────────────────────────────────────────
    if (customId.startsWith('team_queue_')) {
      await interaction.deferReply({ flags: 64 });

      const category = customId.replace('team_queue_', '');
      const selection = creativeSelections.get(`${guild.id}:${user.id}:${category}`);

      if (!selection?.mode || !selection?.region) {
        return replyAndDismiss(interaction, { content: '❌ Select a mode and region from the menus above first.' });
      }

      const existingParty = party.getPartyByDiscordId(guild.id, user.id);
      if (existingParty && existingParty.leaderId !== user.id) {
        return replyAndDismiss(interaction, { content: '❌ Only your party leader can queue the party.' });
      }

      const partyMembersRaw = existingParty ? existingParty.members : [{ discordId: user.id, username: user.username }];

      const existingTeamUnit = creativeTeamQueue.findUnitByDiscordId(guild.id, user.id);
      if (existingTeamUnit && existingTeamUnit.mode === selection.mode && existingTeamUnit.region === selection.region) {
        return sendQueueStatusMessage(
          interaction, guild.id, user.id,
          `${existingTeamUnit.mode} (${existingTeamUnit.region})`,
          existingTeamUnit.unit.joinedAt, 'team_leave_queue'
        );
      }

      const alreadyBusy = partyMembersRaw.some(m =>
        isInCreativeQueue(guild.id, m.discordId)
        || creativeTeamQueue.isInTeamQueue(guild.id, m.discordId)
        || teamJoinInProgress.has(`${guild.id}:${m.discordId}`)
        || teamMatchLifecycle.isPlayerInActiveTeamMatch(guild.id, m.discordId)
      );
      if (alreadyBusy) {
        return replyAndDismiss(interaction, { content: '❌ One or more of your party members is already queued or in an active match.' });
      }

      const busyWithTournament = partyMembersRaw.find(m => isInTournamentActivity(guild.id, m.discordId));
      if (busyWithTournament) {
        return replyAndDismiss(interaction, {
          content: `❌ **${busyWithTournament.username}** is already in a tournament queue or match — leave it before queueing for creative.`,
        });
      }

      for (const m of partyMembersRaw) teamJoinInProgress.add(`${guild.id}:${m.discordId}`);
      await replyAndDismiss(interaction, { content: `⏳ Fetching stats for ${partyMembersRaw.length} player(s)...` });

      try {
        const members = await Promise.all(partyMembersRaw.map(m => guild.members.fetch(m.discordId)));

        const unregistered = members.find(m => !m.roles.cache.has(getRoleId(guild.id, 'Registered')));
        if (unregistered) {
          return replyAndDismiss(interaction, {
            content: `❌ **${unregistered.user.username}** needs to complete their profile in <#${getChannelId(guild.id, 'getRoles')}> first (set their region).`,
          });
        }

        for (const member of members) {
          const memberAccess = await access.checkAccess(member.id);
          if (!memberAccess.allowed) {
            await notifyCreditWindowStartedIfNeeded(client, member.id, memberAccess);
            return replyAndDismiss(interaction, {
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
            guildName: guild.name,
            discordId: member.id,
            discordUsername: member.user.username,
            discordTag: member.user.tag,
            epicUsername,
            epicId,
            mode: selection.mode,
            region: selection.region,
            platform,
          });
        }));

        const { unit } = creativeTeamQueue.queueUnit(guild.id, players, selection.mode, selection.region);

        await updateCreativeQueueEmbed(guild.id, client, category, QUEUE_CHANNEL_CONFIGS[category]);

        const targetSize = creativeTeamQueue.targetSizeForMode(selection.mode);
        const needed = targetSize - players.length;
        const teamLabel = `${selection.mode} (${selection.region})` + (needed > 0 ? ` — LF${needed}` : '');
        await sendQueueStatusMessage(interaction, guild.id, user.id, teamLabel, unit.joinedAt, 'team_leave_queue');
      } catch (err) {
        console.error('Team queue error:', err);
        await replyAndDismiss(interaction, { content: `❌ Error joining queue: ${err.message}` });
      } finally {
        for (const m of partyMembersRaw) teamJoinInProgress.delete(`${guild.id}:${m.discordId}`);
      }
    }

    // ── TEAM LEAVE QUEUE (6s/8s) ─────────────────────────────────────────────
    if (customId === 'team_leave_queue') {
      await interaction.deferReply({ flags: 64 });

      const found = creativeTeamQueue.findUnitByDiscordId(guild.id, user.id);
      if (!found) {
        return replyAndDismiss(interaction, { content: '❌ You are not in the 6s/8s queue.' });
      }

      creativeTeamQueue.removeFromTeamQueueAnywhere(guild.id, user.id);
      stopQueueStatusMessage(guild.id, user.id);

      const category = categoryForAnyMode(found.mode);
      if (category) await updateCreativeQueueEmbed(guild.id, client, category, QUEUE_CHANNEL_CONFIGS[category]);

      await replyAndDismiss(interaction, { content: '✅ You (and your party) have left the 6s/8s queue.' });
    }

    // ── TEAM METHOD VOTE BUTTONS ──────────────────────────────────────────────
    // The handler itself broadcasts the updated tally embed to every channel in the match's
    // cluster (primary + any satellites) — no local interaction.message.edit needed anymore.
    if (customId === 'team_method_choose' || customId === 'team_method_balanced') {
      const choice = customId === 'team_method_choose' ? 'choose' : 'balanced';
      const result = await teamMatchLifecycle.handleTeamMethodVoteButton(channelId, user.id, choice, client);

      if (result.status === 'not_found') {
        return interaction.reply({ content: '❌ This vote has ended.', flags: 64 });
      }
      if (result.status === 'not_participant') {
        return interaction.reply({ content: '❌ You are not part of this match.', flags: 64 });
      }

      await interaction.reply({ content: `✅ Vote recorded (👥${result.chooseCount} / ⚡${result.balancedCount}).`, flags: 64 });
    }

    // ── TEAM PICK BUTTONS ─────────────────────────────────────────────────────
    if (customId === 'team_pick_1' || customId === 'team_pick_2') {
      const teamNumber = customId === 'team_pick_1' ? 1 : 2;
      const result = await teamMatchLifecycle.handleTeamPickButton(channelId, user.id, teamNumber, client);

      if (result.status === 'not_found') {
        return interaction.reply({ content: '❌ Team picking has ended.', flags: 64 });
      }
      if (result.status === 'not_participant') {
        return interaction.reply({ content: '❌ You are not part of this match.', flags: 64 });
      }

      await interaction.reply({ content: `✅ You joined Team ${teamNumber}.`, flags: 64 });
    }

    // ── TEAM READY CHECK BUTTON ──────────────────────────────────────────────
    if (customId === 'team_ready') {
      const result = await teamMatchLifecycle.handleReadyButton(channelId, user.id, client);

      if (result.status === 'not_found' || result.status === 'not_active') {
        return interaction.reply({ content: '❌ There is no active ready check here.', flags: 64 });
      }
      if (result.status === 'not_participant') {
        return interaction.reply({ content: '❌ You are not part of this match.', flags: 64 });
      }

      await interaction.reply({ content: `✅ Marked ready (${result.readyCount}/${result.totalCount}).`, flags: 64 });
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
    // Closes the whole match's channel cluster — including any satellite channels in other
    // guilds for a cross-server 6s/8s (or 1v1/2v2) match, not just the one this button was
    // clicked in. The deletion group's id is the matchId, which is also the credit timer's key
    // (see team-match-lifecycle.js/index.js's confirmMatchChannels — credits.js's param is just
    // an opaque Map key, not a real channel reference).
    if (customId === 'close_creative_channel') {
      teamMatchLifecycle.endTeamMatch(channelId);
      const cancelled = channelLifecycle.cancelChannelDeletionByChannelId(channelId);
      if (cancelled) credits.cancelCreditTimer(cancelled.groupId);
      const channels = cancelled?.channels ?? [{ textChannelId: channelId, voiceChannelId: null }];

      await interaction.reply({ content: '🔒 Closing this channel in 10 seconds...' });
      setTimeout(() => {
        for (const c of channels) {
          for (const id of [c.textChannelId, c.voiceChannelId].filter(Boolean)) {
            client.channels.fetch(id).then(ch => ch.delete()).catch(console.error);
          }
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
        await closeMatchChannelCluster(
          result.channelsByGuildId,
          '❌ Match declined — both units have been re-queued. This channel will close shortly.'
        );
        return interaction.editReply({ content: '❌ Match declined. You have been re-queued automatically.' });
      }
    }

    // ── CHECK MY ACCESS ──────────────────────────────────────────────────────
    if (customId === 'access_check') {
      await interaction.deferReply({ flags: 64 });
      const status = await access.getAccessStatus(user.id);
      await notifyCreditWindowStartedIfNeeded(client, user.id, status);

      const components = status.kind === 'credits_active_can_buy'
        ? [buildUseCreditsButton(), buildAccessSubscribeButtons()]
        : [buildAccessSubscribeButtons()];

      await interaction.editReply({
        embeds: [buildAccessStatusEmbed(status)],
        components,
      });
    }

    // ── USE CREDITS FOR TODAY ─────────────────────────────────────────────────
    // The only way left to spend a credit-day — checkAccess no longer auto-spends (see
    // access.js). Re-validates everything server-side rather than trusting the button was shown
    // correctly, since the embed the player clicked from could be stale by the time they click.
    if (customId === 'access_use_credits') {
      await interaction.deferReply({ flags: 64 });
      const result = await access.useCreditsForToday(user.id);

      if (result.status === 'purchased') {
        return interaction.editReply({
          content: `✅ Access granted until midnight UTC tonight. **${result.creditsRemaining}** credits remaining. ` +
            `**${result.daysLeftInWindow}** day(s) left in your credit window. Come back tomorrow to extend.`,
        });
      }
      if (result.status === 'already_bought_today') {
        return interaction.editReply({ content: '✅ You already have access today — it lasts until midnight UTC.' });
      }
      if (result.status === 'not_needed') {
        return interaction.editReply({ content: '✅ You already have access (active trial or subscription) — no need to spend credits.' });
      }
      if (result.status === 'window_expired') {
        return interaction.editReply({
          content: '❌ Your credit window has expired and your credits have been forfeited. Subscribe below to continue.',
          components: [buildAccessSubscribeButtons()],
        });
      }
      if (result.status === 'insufficient_credits') {
        return interaction.editReply({
          content: `❌ You need **${result.needed}** credits for today's access (you have **${result.have}**). Subscribe below for unlimited access.`,
          components: [buildAccessSubscribeButtons()],
        });
      }
      if (result.status === 'ladder_exhausted') {
        return interaction.editReply({
          content: '❌ You\'ve used all 7 extra credit-days available in your window. Subscribe below for unlimited access.',
          components: [buildAccessSubscribeButtons()],
        });
      }
      return interaction.editReply({ content: '❌ Something went wrong checking your access. Try again, or check #access.' });
    }

    // ── SUBSCRIBE BUTTONS ─────────────────────────────────────────────────────
    // Same two IDs are used both on the persistent #access embed and on the "no access" blocking
    // embed shown at every gating point — the action is identical regardless of entry point:
    // generate a fresh Checkout Session for whoever clicked and hand back a Link button, since a
    // Checkout URL is single-use and can't be baked into a static persistent embed.
    if (customId === 'access_subscribe_monthly' || customId === 'access_subscribe_yearly') {
      // Guard against double-processing the same interaction — calling deferReply/reply on an
      // interaction that's already been acknowledged throws "Interaction has already been
      // acknowledged", which previously happened outside any try/catch here and made the whole
      // checkout flow fail silently (caught only by the generic interactionCreate handler).
      if (interaction.deferred || interaction.replied) {
        console.warn(`[billing] access_subscribe button already acknowledged — skipping duplicate handling (user ${user.id})`);
        return;
      }

      const plan = customId === 'access_subscribe_monthly' ? 'monthly' : 'yearly';

      try {
        // deferReply is the first thing in this block and the only place it's called — if it
        // throws, interaction.deferred stays false, so the catch below falls back to reply()
        // instead of editReply() rather than risking a second acknowledgement attempt.
        await interaction.deferReply({ flags: 64 });

        const checkoutUrl = await billing.createCheckoutSession(user.id, plan);
        // Plain text, not a Link-style button — Stripe Checkout URLs carry a long encoded
        // fragment (session state) that can exceed the length Discord allows on a button's url
        // field, where it silently fails. Message content has a much higher limit and Discord
        // auto-links a raw http(s):// URL in content, so this is both simpler and more robust.
        await interaction.editReply({
          content: `Click here to subscribe: ${checkoutUrl}`,
        });
      } catch (err) {
        // Full error (not just .message) so a Stripe API failure — bad price ID, account issue,
        // network error — is actually visible in the logs instead of just a generic ❌ in Discord.
        console.error(`[billing] Failed to create Stripe checkout session for user ${user.id} (${plan}):`, err);

        const errorPayload = { content: `❌ ${err.message}` };
        const sendError = interaction.deferred || interaction.replied
          ? interaction.editReply(errorPayload)
          : interaction.reply({ ...errorPayload, flags: 64 });
        await sendError.catch(sendErr => console.error('[billing] Failed to send checkout error reply:', sendErr));
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

// ── HELPER: RESOLVE EPIC IDENTITY ──────────────────────────────────────────────
// Epic OAuth (epic-oauth.js) is the primary link path — if this player has already completed it,
// their epicId/epicUsername in Mongo are a real, player-confirmed link, so use those directly
// without a network round trip. Otherwise falls back to a live Yunite lookup exactly as before,
// and finally to the Discord display name if neither is available.
async function resolveEpicIdentity(guild, member) {
  const stored = await playerStore.getPlayer(guild.id, member.id);
  if (stored?.epicOAuthLinked && stored.epicId && stored.epicUsername) {
    return { epicUsername: stored.epicUsername, epicId: stored.epicId };
  }

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
// requeue or the periodic sweep. No DMs — a private channel is created immediately in every
// guild involved (one per side for a cross-server match), with Accept/Reject buttons living in
// the channel itself (see match-channels.js).
async function notifyMatchFound(unitA, unitB, tournamentName, region, client) {
  const matchId = createMatch(unitA, unitB, tournamentName, region);
  const allPlayers = [...unitA.members, ...unitB.members];
  await createMatchChannelsForMatch(matchId, allPlayers, { client, kind: 'tournament', label: tournamentName });
}

// ── HELPER: NOTIFY CREATIVE MATCH FOUND ───────────────────────────────────────
// Both units are already spliced out of the pool by the time this fires (attemptMatchingForQueue
// does that synchronously), so the queue embed count is updated here regardless of what happens
// next. The match itself still needs both players to accept — same pending-match flow as
// tournament matches, just with a 2-minute expiry and creative's own requeue-on-reject/expiry.
async function notifyCreativeMatchFound(unitA, unitB, mode, region, client) {
  const matchId = createMatch(unitA, unitB, mode, region, {
    requeueFn: requeueCreativeUnit,
    kind: 'creative',
    expiryMs: 2 * 60 * 1000,
  });
  const allPlayers = [...unitA.members, ...unitB.members];
  await createMatchChannelsForMatch(matchId, allPlayers, { client, kind: 'creative', label: mode });

  const category = categoryForAnyMode(mode);
  if (category) {
    // A cross-server match can decrement two different guilds' queue counts at once — refresh
    // every involved guild's embed, not just one.
    const involvedGuildIds = new Set([unitA.guildId, unitB.guildId]);
    for (const guildId of involvedGuildIds) {
      await updateCreativeQueueEmbed(guildId, client, category, QUEUE_CHANNEL_CONFIGS[category]);
    }
  }
}

// ── HELPER: CONFIRM MATCH CHANNELS (everyone accepted) ────────────────────────
// Swaps the Accept/Reject card for the confirmed roster in every guild's channel, creates the
// tournament voice channel per guild, arms the whole cluster's deletion timer as one group, and
// (for creative 1v1/2v2) starts the credit-earning timer — keyed by matchId since a cross-server
// match no longer has one single channel id, and credits.js's param is just an opaque Map key.
async function confirmMatchChannels(match) {
  const isCreative = match.kind === 'creative';
  const deleteAtMs = Date.now() + (isCreative ? 5 * 60 * 1000 : 3.5 * 60 * 60 * 1000);
  const channelEntries = [];

  for (const [guildId, entry] of match.channelsByGuildId) {
    const guild = client.guilds.cache.get(guildId);
    let channel;
    try {
      channel = await client.channels.fetch(entry.channelId);
    } catch (err) {
      console.error(`Failed to fetch match channel ${entry.channelId} in guild ${guildId} for confirmation:`, err.message);
      continue;
    }
    if (!guild) continue;

    let voiceChannel = null;
    try {
      if (isCreative) {
        await channel.send({
          embeds: [buildCreativeMatchConfirmedEmbed(match.players, match.tournamentName)],
          components: [buildCloseChannelButton()],
        });
        const pinMsg = await channel.send('⏰ This channel will automatically delete in 5 minutes.');
        await pinMsg.pin().catch(err => console.error('Failed to pin deletion notice:', err.message));
      } else {
        const category = await channelLifecycle.getOrCreateMatchCategory(guild);
        const modRoleId = getRoleId(guildId, 'mod');
        const localPlayers = match.players.filter(p => p.guildId === guildId);

        voiceChannel = await guild.channels.create({
          name: `vc-${channel.name}`.slice(0, 100),
          type: ChannelType.GuildVoice,
          parent: category.id,
          permissionOverwrites: [
            { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
            ...localPlayers.map(p => ({ id: p.discordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] })),
            ...(modRoleId ? [{ id: modRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
          ],
        });

        await channel.send({ embeds: [buildMatchConfirmedEmbed(match.players)], components: [buildCloseChannelButton()] });
        await channel.send(`${localPlayers.map(p => `<@${p.discordId}>`).join(' ')} — Add each other in-game and good luck! 🏆`);

        const pinMsg = await channel.send('⏰ This channel and voice channel will automatically delete in 3.5 hours. Good luck!');
        await pinMsg.pin().catch(err => console.error('Failed to pin deletion notice:', err.message));
      }

      channelEntries.push({ guildId, textChannelId: channel.id, voiceChannelId: voiceChannel?.id ?? null });
    } catch (err) {
      console.error(`Failed to finalize confirmed match channel ${entry.channelId} in guild ${guildId}:`, err.message);
    }
  }

  if (channelEntries.length > 0) {
    channelLifecycle.scheduleChannelDeletion({
      client, groupId: match.matchId, channels: channelEntries, deleteAtMs,
      kind: isCreative ? 'creative-pairwise' : 'tournament',
    });
  }

  if (isCreative) {
    // Fixed roster for the lifetime of this channel — unlike 6s/8s, there's no backfill/vote-kick
    // here, so a plain closure over `match.players` is enough.
    credits.scheduleCreditTimer(match.matchId, () => match.players);
  }
}

// ── HELPER: NOTIFY OTHER MATCH CHANNELS ────────────────────────────────────────
// Lets the other side(s) of a cross-server match know someone accepted, without waiting for
// everyone — same-guild matches just have one channel, so this is a no-op there.
async function notifyOtherMatchChannels(match, excludeGuildId, content) {
  for (const [guildId, entry] of match.channelsByGuildId) {
    if (guildId === excludeGuildId) continue;
    try {
      const channel = await client.channels.fetch(entry.channelId);
      await channel.send(content);
    } catch (err) {
      console.error(`Failed to notify match channel ${entry.channelId} in guild ${guildId}:`, err.message);
    }
  }
}

// ── HELPER: CLOSE MATCH CHANNEL CLUSTER (reject/expire) ────────────────────────
// Tears down every channel in the match's cluster — both/all guilds involved — with a short
// grace period so the notice is readable, same UX precedent as close_creative_channel's 10s delay.
async function closeMatchChannelCluster(channelsByGuildId, noticeMessage) {
  for (const [guildId, entry] of channelsByGuildId) {
    try {
      const channel = await client.channels.fetch(entry.channelId);
      if (noticeMessage) await channel.send(noticeMessage).catch(() => {});
      setTimeout(() => channel.delete().catch(console.error), 10000);
    } catch (err) {
      console.error(`Failed to close match channel ${entry.channelId} in guild ${guildId}:`, err.message);
    }
  }
}

startWebhookServer(client);

store.init()
  .catch(err => console.error('[Store] init() failed unexpectedly:', err.message))
  .finally(() => client.login(process.env.DISCORD_TOKEN));
