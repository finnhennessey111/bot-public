// permissions.js - Server-wide permission enforcement, re-applied on every bot startup (looped
// over every guild) so manual changes in Discord's UI (or a missed step during setup) don't
// silently drift from the intended access model. Uses PermissionOverwriteManager#edit (a
// per-target merge) rather than replacing each channel's overwrite array outright, so it never
// clobbers overwrites this module doesn't know about (e.g. per-player allows on a private match
// channel).
//
// Progressive visibility ladder for a brand new member, each rung gated behind a Discord role
// via per-channel ViewChannel overwrites (default deny for @everyone, allow per role):
//   1. #register only (ENTRY_CHANNEL_KEYS) — visible to @everyone, no role needed.
//   2. The Epic OAuth flow (epic-oauth.js / webhook-server.js's /epic-callback) grants the
//      verified role (auto-created by /matchmaker-setup, stored as roleIds.verified) directly on
//      a successful link -> unlocks #get-roles, #how-to-use and #access (verifiedChannels).
// Neither tournament nor creative queue channels are part of this ladder — every server member
// can see every one of them regardless of role state; only actually queueing still requires the
// Registered role, checked independently at click-time (index.js's queue_duo/lf2 handler for
// tournaments, creative_queue_/team_queue_ for creative). Tournament channels get this from
// channel-manager.js's createTournamentChannel (@everyone ViewChannel at creation); creative
// channels get it from enforceQueueChannels below, which explicitly resets @everyone's ViewChannel
// to true on every run — necessary (not just "don't deny it") because an older version of this
// function denied it, and a per-target overwrite edit never un-sets a key it doesn't touch.
// Because this is pure role-based channel overwrites, unlocking is automatic and instantaneous
// the moment a member gains the relevant role — no event listener needed, Discord applies it.
//
// Separately, #setup (MOD_ONLY_CHANNEL_KEYS) sits outside this member-facing ladder entirely —
// visible only to the mod role, holding admin onboarding instructions regular members never see.

const { PermissionFlagsBits } = require('discord.js');
const { pinnedMessages } = require('./store');
const { getChannelId, getRoleId, getCreativeChannelInfo } = require('./guild-config');

// Visible to a brand new member with no roles at all — the very first thing they see.
const ENTRY_CHANNEL_KEYS = ['register'];

// Unlocked once Epic OAuth has verified the member (see module doc above). #access used to be
// visible to @everyone unconditionally, which broke the "only #register visible by default" rule
// for a brand-new, unverified member — folded into this tier instead. `sendMessages: false` keeps
// #access read-only, since its embed is entirely button-driven; every other channel here defaults
// to normal posting.
const verifiedChannels = [
  { key: 'getRoles' },
  { key: 'howto' },
  { key: 'access', sendMessages: false },
];

// Visible only to the MatchMaker Mod role — admin/setup onboarding, never shown to regular
// members (not even after they progress through the ladder above).
const MOD_ONLY_CHANNEL_KEYS = ['setup'];

async function editOverwrite(channel, targetId, permissions, label) {
  try {
    await channel.permissionOverwrites.edit(targetId, permissions);
  } catch (err) {
    console.error(`  ⚠️ Failed to set overwrite on #${channel.name} for ${label}:`, err.message);
  }
}

// Explicit member-level allow for the bot itself. Every function below that denies @everyone
// ViewChannel on a channel relies on the bot separately holding Administrator (or some other
// guild-wide allow) to still see in — never guaranteed on a freshly-invited "new server", where
// the invite may not have granted Administrator. Without this, the bot can end up unable to see
// its own creative-queue/setup channels the moment enforcePermissions denies @everyone there.
async function grantBotAccess(guild, channel) {
  const botMember = guild.members.me;
  if (!botMember) return;
  await editOverwrite(channel, botMember, { ViewChannel: true, SendMessages: true }, 'bot');
}

// Permission-overwrite object for guild.channels.create's permissionOverwrites array — grants the
// bot explicit ViewChannel/SendMessages at creation time itself, rather than relying on a later
// enforcePermissions() pass (or grantBotAccess above) to add it. Needed for channels like the
// creative queue ones that matchmaker-setup.js creates with a restrictive default (e.g. no parent
// category to inherit from, or a guild where @everyone's base permissions deny ViewChannel) — the
// bot could otherwise be unable to see/post in a channel it just created.
function botAccessOverwrite(guild) {
  return { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] };
}

async function lockGuildBasePermissions(guild) {
  const everyone = guild.roles.everyone;
  const next = everyone.permissions.remove([
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.MentionEveryone,
  ]);

  if (next.bitfield === everyone.permissions.bitfield) return;

  try {
    await everyone.setPermissions(next);
    console.log('  🔒 @everyone: removed Manage Messages + Mention Everyone/Here');
  } catch (err) {
    console.error('  ⚠️ Failed to update @everyone base permissions:', err.message);
  }
}

async function enforceEntryChannels(guild) {
  for (const key of ENTRY_CHANNEL_KEYS) {
    const channelId = getChannelId(guild.id, key);
    if (!channelId) {
      console.warn(`  ⚠️ No ${key} channel configured for this guild — skipping entry-visibility enforcement for it`);
      continue;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn(`  ⚠️ ${key} channel (${channelId}) not found — skipping`);
      continue;
    }

    await editOverwrite(channel, guild.roles.everyone, { ViewChannel: true, SendMessages: true }, '@everyone');
  }
}

// If the guild has no verified role configured yet (roleIds.verified unset — pre-dating the
// auto-create in /matchmaker-setup), these channels are left exactly as they currently are rather
// than locked out entirely — an upgrading server shouldn't lose access to
// get-roles/how-to-use/access just because /matchmaker-setup hasn't been re-run yet.
async function enforceVerifiedChannels(guild) {
  const verifiedRoleId = getRoleId(guild.id, 'verified');
  if (!verifiedRoleId) {
    console.warn('  ⚠️ No verified role configured for this guild (re-run /matchmaker-setup) — skipping progressive-visibility enforcement for get-roles/how-to-use/access');
    return;
  }

  const modRoleId = getRoleId(guild.id, 'mod');

  for (const { key, sendMessages = true } of verifiedChannels) {
    const channelId = getChannelId(guild.id, key);
    if (!channelId) {
      console.warn(`  ⚠️ No ${key} channel configured for this guild — skipping`);
      continue;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn(`  ⚠️ ${key} channel (${channelId}) not found — skipping`);
      continue;
    }

    await editOverwrite(channel, guild.roles.everyone, { ViewChannel: false }, '@everyone');
    await editOverwrite(channel, verifiedRoleId, { ViewChannel: true, SendMessages: sendMessages }, 'verified role');
    if (modRoleId) await editOverwrite(channel, modRoleId, { ViewChannel: true, SendMessages: true }, 'mod role');
    await grantBotAccess(guild, channel);
  }
}

// If the guild has no mod role configured yet, the channel is left exactly as it currently is
// (same graceful-skip precedent as enforceVerifiedChannels) rather than denying everyone
// including mods — that would strand admins out of their own setup instructions.
async function enforceModOnlyChannels(guild) {
  const modRoleId = getRoleId(guild.id, 'mod');
  if (!modRoleId) {
    console.warn('  ⚠️ No mod role configured for this guild — skipping mod-only-visibility enforcement for setup');
    return;
  }

  for (const key of MOD_ONLY_CHANNEL_KEYS) {
    const channelId = getChannelId(guild.id, key);
    if (!channelId) {
      console.warn(`  ⚠️ No ${key} channel configured for this guild — skipping`);
      continue;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn(`  ⚠️ ${key} channel (${channelId}) not found — skipping`);
      continue;
    }

    await editOverwrite(channel, guild.roles.everyone, { ViewChannel: false }, '@everyone');
    await editOverwrite(channel, modRoleId, { ViewChannel: true, SendMessages: true }, 'mod role');
    await grantBotAccess(guild, channel);
  }
}

// Tournament + creative queue channels: nobody can post files/images regardless of who can see
// the channel, and mods can always see in even though they don't hold any particular role.
// Neither channel type gets ViewChannel *denied* here — both stay visible to every server member
// regardless of registration state (see module doc comment). resetViewChannel is creative-only:
// tournament channels never had ViewChannel touched by this function to begin with (always
// visible from channel-manager.js's createTournamentChannel onward), so there's nothing to undo;
// creative channels did have it denied by an older version of this function, so an explicit
// ViewChannel: true is needed to actually reopen an already-restricted server's existing channels
// — omitting the key here would just leave that old deny in place (see editOverwrite's per-target
// merge doc at the top of this file).
async function lockQueueChannelAttachments(guild, channelId, { resetViewChannel = false } = {}) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const everyonePerms = { AttachFiles: false, EmbedLinks: false };
  if (resetViewChannel) everyonePerms.ViewChannel = true;
  await editOverwrite(channel, guild.roles.everyone, everyonePerms, '@everyone');

  const modRoleId = getRoleId(guild.id, 'mod');
  if (modRoleId) {
    await editOverwrite(channel, modRoleId, { ViewChannel: true }, 'mod role');
  }
}

async function enforceQueueChannels(guild) {
  const guildPinnedChannelIds = Object.entries(pinnedMessages)
    .filter(([, pinned]) => pinned.guildId === guild.id)
    .map(([channelId]) => channelId);

  for (const channelId of guildPinnedChannelIds) {
    await lockQueueChannelAttachments(guild, channelId);
  }

  const creativeChannelIds = ['1v1', '2v2', '6s', '8s']
    .map(category => getCreativeChannelInfo(guild.id, category)?.channelId)
    .filter(Boolean);

  for (const channelId of creativeChannelIds) {
    await lockQueueChannelAttachments(guild, channelId, { resetViewChannel: true });
  }
}

async function enforcePermissions(guild) {
  console.log(`🔐 Enforcing server permissions for guild ${guild.id}...`);
  await lockGuildBasePermissions(guild);
  await enforceEntryChannels(guild);
  await enforceVerifiedChannels(guild);
  await enforceModOnlyChannels(guild);
  await enforceQueueChannels(guild);
  console.log('🔐 Permission enforcement complete');
}

// Runtime gate for the mod debug commands and /matchmaker-setup — a custom per-guild role
// (guild-config.js's roleIds.mod), not a Discord permission bit, so it can't be expressed via
// SlashCommandBuilder#setDefaultMemberPermissions (register-commands.js deliberately sets none
// for these commands). Lives here (not index.js) purely so it's independently testable without
// requiring index.js itself, which isn't possible in a test — it calls client.login() as a side
// effect of loading.
function isModMember(guildId, interaction) {
  const modRoleId = getRoleId(guildId, 'mod');
  return !!modRoleId && !!interaction.member?.roles.cache.has(modRoleId);
}

module.exports = { enforcePermissions, botAccessOverwrite, isModMember };
