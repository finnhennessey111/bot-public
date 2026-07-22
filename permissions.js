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
//   2. Yunite links their Epic account and assigns its own verified-role (external to
//      MatchMaker — configured in Yunite's own dashboard; we're only told the role's ID, via
//      /matchmaker-setup's yunite-verified-role option, stored as roleIds.yuniteVerified) ->
//      unlocks #get-roles and #how-to-use (YUNITE_VERIFIED_CHANNEL_KEYS).
//   3. They complete #get-roles and are granted the Registered role (index.js's select_region
//      handler grants Registered and a region role together) -> unlocks their region's
//      tournament channels (already gated per-channel by region role at creation time in
//      channel-manager.js — nothing more to do here) and the creative queue channels (gated by
//      the Registered role in enforceQueueChannels below).
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

// Unlocked once Yunite has assigned its verified-role to the member (see module doc above).
const YUNITE_VERIFIED_CHANNEL_KEYS = ['getRoles', 'howto'];

// Channels every registered member should be able to see and use — keys into guild-config's
// channelIds map (populated by /matchmaker-setup).
const PUBLIC_CHANNEL_KEYS = ['formParty'];

// Channels everyone can see but nobody but the bot can post in — the #access channel's embed is
// entirely button-driven, so member messages would just be clutter.
const READ_ONLY_CHANNEL_KEYS = ['access'];

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

// If the admin hasn't told us which role Yunite assigns yet (roleIds.yuniteVerified unset), these
// channels are left exactly as they currently are rather than locked out entirely — an upgrading
// server shouldn't lose access to get-roles/how-to-use just because /matchmaker-setup hasn't been
// re-run with the new option yet.
async function enforceYuniteVerifiedChannels(guild) {
  const verifiedRoleId = getRoleId(guild.id, 'yuniteVerified');
  if (!verifiedRoleId) {
    console.warn('  ⚠️ No Yunite verified role configured for this guild (set one via /matchmaker-setup) — skipping progressive-visibility enforcement for get-roles/how-to-use');
    return;
  }

  const modRoleId = getRoleId(guild.id, 'mod');

  for (const key of YUNITE_VERIFIED_CHANNEL_KEYS) {
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
    await editOverwrite(channel, verifiedRoleId, { ViewChannel: true }, 'Yunite verified role');
    if (modRoleId) await editOverwrite(channel, modRoleId, { ViewChannel: true }, 'mod role');
    await grantBotAccess(guild, channel);
  }
}

// If the guild has no mod role configured yet, the channel is left exactly as it currently is
// (same graceful-skip precedent as enforceYuniteVerifiedChannels) rather than denying everyone
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

// Tournament + creative queue channels: nobody can post files/images regardless of who can see
// the channel, and mods can always see in even though they don't hold the region role. Tournament
// channels don't touch ViewChannel here at all — channel-manager.js already grants it per-channel
// to that tournament's region (or console) role at creation time, and this only needs to layer
// the attachment lock + mod visibility on top. Creative channels DO need ViewChannel touched here
// — unlike tournament channels they're static and region-agnostic, so there's no per-creation
// overwrite; registeredRoleId gates them behind the Registered role as part of the progressive-
// unlock system (step 3 — see module doc comment), replacing what used to be "visible to everyone".
async function lockQueueChannelAttachments(guild, channelId, { registeredRoleId = null } = {}) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const everyonePerms = { AttachFiles: false, EmbedLinks: false };
  if (registeredRoleId) everyonePerms.ViewChannel = false;
  await editOverwrite(channel, guild.roles.everyone, everyonePerms, '@everyone');

  if (registeredRoleId) {
    await editOverwrite(channel, registeredRoleId, { ViewChannel: true }, 'Registered role');
    // @everyone's ViewChannel:false above would otherwise take the bot's own visibility down
    // with it on a guild where the bot doesn't hold Administrator — see grantBotAccess doc.
    await grantBotAccess(guild, channel);
  }

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

  const registeredRoleId = getRoleId(guild.id, 'Registered');
  const creativeChannelIds = ['1v1', '2v2', '6s', '8s']
    .map(category => getCreativeChannelInfo(guild.id, category)?.channelId)
    .filter(Boolean);

  for (const channelId of creativeChannelIds) {
    await lockQueueChannelAttachments(guild, channelId, { registeredRoleId });
  }
}

async function enforcePermissions(guild) {
  console.log(`🔐 Enforcing server permissions for guild ${guild.id}...`);
  await lockGuildBasePermissions(guild);
  await enforceEntryChannels(guild);
  await enforceYuniteVerifiedChannels(guild);
  await enforceModOnlyChannels(guild);
  await enforcePublicChannels(guild);
  await enforceReadOnlyChannels(guild);
  await enforceQueueChannels(guild);
  console.log('🔐 Permission enforcement complete');
}

module.exports = { enforcePermissions, botAccessOverwrite };
