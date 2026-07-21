// permissions.js - Server-wide permission enforcement, re-applied on every bot startup so
// manual changes in Discord's UI (or a missed step during setup) don't silently drift from
// the intended access model. Uses PermissionOverwriteManager#edit (a per-target merge) rather
// than replacing each channel's overwrite array outright, so it never clobbers overwrites this
// module doesn't know about (e.g. per-player allows on a private match channel).

const { PermissionFlagsBits } = require('discord.js');
const { pinnedMessages, creativeChannels } = require('./store');

// Channels every registered member should be able to see and use.
const PUBLIC_CHANNEL_ENV_VARS = [
  'GET_ROLES_CHANNEL_ID',
  'HOWTO_CHANNEL_ID',
  'FORM_PARTY_CHANNEL_ID',
];

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
  for (const envVar of PUBLIC_CHANNEL_ENV_VARS) {
    const channelId = process.env[envVar];
    if (!channelId) {
      console.warn(`  ⚠️ ${envVar} not set — skipping public-visibility enforcement for it`);
      continue;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn(`  ⚠️ ${envVar} (${channelId}) not found — skipping`);
      continue;
    }

    await editOverwrite(channel, guild.roles.everyone, { ViewChannel: true, SendMessages: true }, '@everyone');
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

  const modRoleId = process.env.MOD_ROLE_ID;
  if (modRoleId) {
    await editOverwrite(channel, modRoleId, { ViewChannel: true }, 'mod role');
  }
}

async function enforceQueueChannels(guild) {
  for (const channelId of Object.keys(pinnedMessages)) {
    await lockQueueChannelAttachments(guild, channelId, { everyoneVisible: false });
  }

  const creativeChannelIds = [
    creativeChannels['1v1']?.channelId,
    creativeChannels['2v2']?.channelId,
    process.env.CREATIVE_6S_CHANNEL_ID,
    process.env.CREATIVE_8S_CHANNEL_ID,
  ].filter(Boolean);

  for (const channelId of creativeChannelIds) {
    await lockQueueChannelAttachments(guild, channelId, { everyoneVisible: true });
  }
}

async function enforcePermissions(guild) {
  console.log('🔐 Enforcing server permissions...');
  await lockGuildBasePermissions(guild);
  await enforcePublicChannels(guild);
  await enforceQueueChannels(guild);
  console.log('🔐 Permission enforcement complete');
}

module.exports = { enforcePermissions };
