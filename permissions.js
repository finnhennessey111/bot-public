// permissions.js - Server-wide permission enforcement, re-applied on every bot startup (looped
// over every guild) so manual changes in Discord's UI (or a missed step during setup) don't
// silently drift from the intended access model. Uses PermissionOverwriteManager#edit (a
// per-target merge) rather than replacing each channel's overwrite array outright, so it never
// clobbers overwrites this module doesn't know about (e.g. per-player allows on a private match
// channel).

const { PermissionFlagsBits } = require('discord.js');
const { pinnedMessages } = require('./store');
const { getChannelId, getRoleId, getCreativeChannelInfo } = require('./guild-config');

// Channels every registered member should be able to see and use — keys into guild-config's
// channelIds map (populated by /matchmaker-setup).
const PUBLIC_CHANNEL_KEYS = ['getRoles', 'howto', 'formParty'];

// Channels everyone can see but nobody but the bot can post in — the #access channel's embed is
// entirely button-driven, so member messages would just be clutter.
const READ_ONLY_CHANNEL_KEYS = ['access'];

async function editOverwrite(channel, targetId, permissions, label) {
  try {
    await channel.permissionOverwrites.edit(targetId, permissions);
  } catch (err) {
    console.error(`  ⚠️ Failed to set overwrite on #${channel.name} for ${label}:`, err.message);
  }
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

async function enforcePublicChannels(guild) {
  for (const key of PUBLIC_CHANNEL_KEYS) {
    const channelId = getChannelId(guild.id, key);
    if (!channelId) {
      console.warn(`  ⚠️ No ${key} channel configured for this guild — skipping public-visibility enforcement for it`);
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

async function enforceReadOnlyChannels(guild) {
  for (const key of READ_ONLY_CHANNEL_KEYS) {
    const channelId = getChannelId(guild.id, key);
    if (!channelId) {
      console.warn(`  ⚠️ No ${key} channel configured for this guild — skipping read-only enforcement for it`);
      continue;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn(`  ⚠️ ${key} channel (${channelId}) not found — skipping`);
      continue;
    }

    await editOverwrite(channel, guild.roles.everyone, { ViewChannel: true, SendMessages: false }, '@everyone');
  }
}

// Tournament + creative queue channels: visible to whoever's already allowed in (region role,
// console role, or everyone for creative), but nobody can post files/images, and mods can
// always see in even though they don't hold the region/console role.
async function lockQueueChannelAttachments(guild, channelId, { everyoneVisible }) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const everyonePerms = { AttachFiles: false, EmbedLinks: false };
  if (everyoneVisible) {
    everyonePerms.ViewChannel = true;
    everyonePerms.SendMessages = true;
  }
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
    await lockQueueChannelAttachments(guild, channelId, { everyoneVisible: false });
  }

  const creativeChannelIds = ['1v1', '2v2', '6s', '8s']
    .map(category => getCreativeChannelInfo(guild.id, category)?.channelId)
    .filter(Boolean);

  for (const channelId of creativeChannelIds) {
    await lockQueueChannelAttachments(guild, channelId, { everyoneVisible: true });
  }
}

async function enforcePermissions(guild) {
  console.log(`🔐 Enforcing server permissions for guild ${guild.id}...`);
  await lockGuildBasePermissions(guild);
  await enforcePublicChannels(guild);
  await enforceReadOnlyChannels(guild);
  await enforceQueueChannels(guild);
  console.log('🔐 Permission enforcement complete');
}

module.exports = { enforcePermissions };
