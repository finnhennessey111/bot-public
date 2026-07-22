// matchmaker-setup.js - The /matchmaker-setup orchestrator: creates every role/category/channel
// MatchMaker needs and posts the starter embeds, saving the resulting IDs to that guild's Mongo
// config (guild-config.js). Idempotent — checks guild-config's stored ID *and* that the Discord
// object still exists before creating anything, so re-running after a partial failure (or just
// to rotate the Yunite token) reuses whatever's already there instead of duplicating it.
//
// All Discord API calls are sequential, not parallel — gentler on rate limits, and keeps a
// partial failure in a cleanly resumable state rather than a pile of half-finished promises.

const { ChannelType } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('./guild-config');
const { enforcePermissions, botAccessOverwrite } = require('./permissions');
const { postCreativeQueueChannel } = require('./creative-channel');
const { QUEUE_CHANNEL_CONFIGS } = require('./creative-channel-configs');
const {
  buildRolesEmbed, buildRolesComponents, buildBioButtonRow, buildRegisterEmbed,
  buildHowtoEmbed, buildSetupInstructionsEmbed, buildFormPartyInstructionsEmbed,
  buildPartyInviteOpenButtonRow, buildAccessChannelEmbed, buildAccessChannelButtons,
} = require('./embeds');

const ROLE_SPECS = [
  { key: 'EU', name: 'EU' },
  { key: 'NAC', name: 'NAC' },
  { key: 'ME', name: 'ME' },
  { key: 'PC', name: 'PC' },
  { key: 'Console', name: 'Console' },
  { key: 'Fragger', name: 'Fragger' },
  { key: 'IGL', name: 'IGL' },
  { key: 'Support', name: 'Support' },
  { key: 'Registered', name: 'Registered' },
  { key: 'mod', name: 'MatchMaker Mod' },
];

const CATEGORY_SPECS = [
  { key: 'EU', name: 'EU Tournaments' },
  { key: 'NAC', name: 'NAC Tournaments' },
  { key: 'ME', name: 'ME Tournaments' },
  // Parent for the four creative queue channels below — gets the bot's ViewChannel/SendMessages
  // set explicitly at creation (unlike the tournament categories above, which rely on each
  // channel's own per-creation overwrite instead), so any channel placed under it inherits bot
  // access automatically instead of needing enforcePermissions to patch it in after the fact.
  { key: 'creative', name: 'Creative' },
];

const CHANNEL_SPECS = [
  { key: 'setup', name: 'setup' },
  { key: 'register', name: 'register' },
  { key: 'getRoles', name: 'get-roles' },
  { key: 'howto', name: 'how-to-use' },
  { key: 'formParty', name: 'form-party' },
  { key: 'access', name: 'access' },
];

// Creative queue channels — separate from CHANNEL_SPECS above because they're tracked in
// guild-config's `creativeChannels` map (channelId + pinned messageId together), not
// `channelIds`, matching creative-channel.js's existing storage shape.
const CREATIVE_CHANNEL_SPECS = [
  { key: '1v1', name: 'creative-1v1' },
  { key: '2v2', name: 'creative-2v2' },
  { key: '6s', name: 'creative-6s' },
  { key: '8s', name: 'creative-8s' },
];

const runningGuilds = new Set();

async function ensureRole(guild, existingRoleIds, spec) {
  const existingId = existingRoleIds[spec.key];
  if (existingId) {
    const existing = await guild.roles.fetch(existingId).catch(() => null);
    if (existing) return existing.id;
  }
  const created = await guild.roles.create({ name: spec.name });
  return created.id;
}

async function ensureCategory(guild, existingCategoryIds, spec, { permissionOverwrites } = {}) {
  const existingId = existingCategoryIds[spec.key];
  if (existingId) {
    const existing = await guild.channels.fetch(existingId).catch(() => null);
    if (existing) return existing.id;
  }
  const created = await guild.channels.create({
    name: spec.name,
    type: ChannelType.GuildCategory,
    ...(permissionOverwrites ? { permissionOverwrites } : {}),
  });
  return created.id;
}

async function ensureChannel(guild, existingChannelIds, spec) {
  const existingId = existingChannelIds[spec.key];
  if (existingId) {
    const existing = await guild.channels.fetch(existingId).catch(() => null);
    if (existing) return existing.id;
  }
  const created = await guild.channels.create({ name: spec.name, type: ChannelType.GuildText });
  return created.id;
}

// One-time migration for servers that ran /matchmaker-setup before the Creative category existed
// (or before a given channel had one) — reparents an already-existing creative channel that's
// missing its parent or sitting under the wrong one. lockPermissions: false is essential here:
// Discord's default (true) would sync the channel's overwrites to the new parent, wiping the
// channel-specific overwrites enforcePermissions() already applied (Registered-role gate, mod
// role, bot access, attachment lock).
async function ensureCreativeChannelParent(channel, parentCategoryId) {
  if (!parentCategoryId || channel.parentId === parentCategoryId) return;
  try {
    await channel.setParent(parentCategoryId, { lockPermissions: false });
    console.log(`  📁 Moved #${channel.name} into the Creative category`);
  } catch (err) {
    console.error(`  ⚠️ Failed to move #${channel.name} into the Creative category:`, err.message);
  }
}

// Creates (or reuses) the channel for one creative category, then posts (or reuses) its queue
// embed via creative-channel.js's postCreativeQueueChannel — which persists {channelId,
// messageId} into guild-config's creativeChannels map itself, so no separate save is needed
// here. Only re-posts the embed if the channel and/or its pinned message are actually missing.
async function ensureCreativeChannel(guild, category, spec, existingCreativeChannels, parentCategoryId) {
  const existing = existingCreativeChannels[category];

  if (existing?.channelId && existing?.messageId) {
    try {
      const channel = await guild.channels.fetch(existing.channelId);
      const msg = await channel.messages.fetch(existing.messageId);
      if (channel && msg) {
        await ensureCreativeChannelParent(channel, parentCategoryId);
        return existing.channelId;
      }
    } catch {
      // fall through — channel or pinned message is gone, (re)create/(re)post below
    }
  }

  let channel = existing?.channelId ? await guild.channels.fetch(existing.channelId).catch(() => null) : null;
  if (!channel) {
    channel = await guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildText,
      parent: parentCategoryId ?? null,
      permissionOverwrites: [botAccessOverwrite(guild)],
    });
  } else {
    await ensureCreativeChannelParent(channel, parentCategoryId);
  }

  await postCreativeQueueChannel(guild.id, channel, category, QUEUE_CHANNEL_CONFIGS[category]);
  return channel.id;
}

// Posts (or refreshes in place, if already posted and still present) the starter embed for one
// channel, pinning it on first post. Editing an already-posted message on every re-run (rather
// than leaving it untouched) is what lets a re-run of /matchmaker-setup roll out embed/button
// wording changes to servers that were set up before those changes shipped. Returns the message
// ID either way, for setupMessageIds.
async function ensurePosted(client, existingMessageIds, channelIds, key, buildPayload) {
  const channelId = channelIds[key];
  const existingMessageId = existingMessageIds[key];

  if (existingMessageId) {
    try {
      const channel = await client.channels.fetch(channelId);
      const existing = await channel.messages.fetch(existingMessageId);
      if (existing) {
        await existing.edit(buildPayload());
        return existingMessageId;
      }
    } catch {
      // fall through — message (or channel) is gone, post fresh below
    }
  }

  const channel = await client.channels.fetch(channelId);
  const msg = await channel.send(buildPayload());
  await msg.pin().catch(err => console.error(`Failed to pin ${key} starter embed:`, err.message));
  return msg.id;
}

async function runMatchmakerSetup(guild, yuniteToken, yuniteVerifiedRoleId = null) {
  if (runningGuilds.has(guild.id)) {
    throw new Error('Setup is already running for this server — wait for it to finish before running it again.');
  }
  runningGuilds.add(guild.id);

  try {
    const config = getGuildConfig(guild.id);

    const roleIds = {};
    for (const spec of ROLE_SPECS) roleIds[spec.key] = await ensureRole(guild, config.roleIds, spec);
    // Not created by us — Yunite assigns this role itself (via its own dashboard config) when a
    // member successfully links their Epic account. We just need to know its ID to gate
    // get-roles/how-to-use behind it (permissions.js). Omitting the option on a re-run keeps
    // whatever was already configured rather than clearing it.
    if (yuniteVerifiedRoleId) roleIds.yuniteVerified = yuniteVerifiedRoleId;
    else if (config.roleIds.yuniteVerified) roleIds.yuniteVerified = config.roleIds.yuniteVerified;

    const categoryIds = { ...config.categoryIds };
    for (const spec of CATEGORY_SPECS) {
      const permissionOverwrites = spec.key === 'creative' ? [botAccessOverwrite(guild)] : undefined;
      categoryIds[spec.key] = await ensureCategory(guild, config.categoryIds, spec, { permissionOverwrites });
    }

    const channelIds = {};
    for (const spec of CHANNEL_SPECS) channelIds[spec.key] = await ensureChannel(guild, config.channelIds, spec);

    const creativeChannelIds = {};
    for (const spec of CREATIVE_CHANNEL_SPECS) {
      creativeChannelIds[spec.key] = await ensureCreativeChannel(guild, spec.key, spec, config.creativeChannels, categoryIds.creative);
    }

    // Persist roles/categories/channels before posting embeds — ensurePosted needs channelIds
    // (already have them locally) but buildRegisterEmbed needs the *final* getRoles channel ID,
    // which is already known at this point regardless.
    const setupMessageIds = { ...config.setupMessageIds };
    setupMessageIds.setup = await ensurePosted(
      guild.client, config.setupMessageIds, channelIds, 'setup',
      () => ({ embeds: [buildSetupInstructionsEmbed()] })
    );
    setupMessageIds.getRoles = await ensurePosted(
      guild.client, config.setupMessageIds, channelIds, 'getRoles',
      () => ({ embeds: [buildRolesEmbed()], components: buildRolesComponents() })
    );
    // Bio button posted as its own message right after — Discord caps a message at 5 action
    // rows, and buildRolesComponents() already uses all 5 for select menus (a select can't share
    // a row with a button either), so there's no room left in the same message.
    setupMessageIds.getRolesBio = await ensurePosted(
      guild.client, config.setupMessageIds, { ...channelIds, getRolesBio: channelIds.getRoles }, 'getRolesBio',
      () => ({ components: [buildBioButtonRow()] })
    );
    setupMessageIds.howto = await ensurePosted(
      guild.client, config.setupMessageIds, channelIds, 'howto',
      () => ({ embeds: [buildHowtoEmbed()] })
    );
    setupMessageIds.formParty = await ensurePosted(
      guild.client, config.setupMessageIds, channelIds, 'formParty',
      () => ({ embeds: [buildFormPartyInstructionsEmbed()], components: [buildPartyInviteOpenButtonRow()] })
    );
    setupMessageIds.register = await ensurePosted(
      guild.client, config.setupMessageIds, channelIds, 'register',
      () => ({ embeds: [buildRegisterEmbed(channelIds.getRoles)] })
    );
    setupMessageIds.access = await ensurePosted(
      guild.client, config.setupMessageIds, channelIds, 'access',
      () => ({ embeds: [buildAccessChannelEmbed()], components: [buildAccessChannelButtons()] })
    );

    await setGuildConfig(guild.id, {
      roleIds, categoryIds, channelIds, setupMessageIds,
      secrets: { yuniteToken },
    });

    await enforcePermissions(guild);

    const verifiedRoleLine = roleIds.yuniteVerified
      ? `Yunite verified role: <@&${roleIds.yuniteVerified}> — get-roles/how-to-use unlock once a member has it.`
      : '⚠️ No Yunite verified role set — get-roles/how-to-use won\'t progressively unlock until you re-run ' +
        '/matchmaker-setup with that option set to the role Yunite assigns on verification.';

    return {
      summary:
        '✅ MatchMaker setup complete!\n' +
        `Roles: ${ROLE_SPECS.map(s => s.name).join(', ')}\n` +
        `Categories: ${CATEGORY_SPECS.map(s => s.name).join(', ')}\n` +
        `Channels: ${CHANNEL_SPECS.map(s => `<#${channelIds[s.key]}>`).join(', ')}\n` +
        `Creative channels: ${CREATIVE_CHANNEL_SPECS.map(s => `<#${creativeChannelIds[s.key]}>`).join(', ')}\n` +
        verifiedRoleLine,
    };
  } finally {
    runningGuilds.delete(guild.id);
  }
}

module.exports = { runMatchmakerSetup };
