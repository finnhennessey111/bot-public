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
const { enforcePermissions } = require('./permissions');
const {
  buildRolesEmbed, buildRolesComponents, buildRegisterEmbed,
  buildHowtoEmbed, buildFormPartyInstructionsEmbed,
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
];

const CHANNEL_SPECS = [
  { key: 'register', name: 'register' },
  { key: 'getRoles', name: 'get-roles' },
  { key: 'howto', name: 'how-to-use' },
  { key: 'formParty', name: 'form-party' },
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

async function ensureCategory(guild, existingCategoryIds, spec) {
  const existingId = existingCategoryIds[spec.key];
  if (existingId) {
    const existing = await guild.channels.fetch(existingId).catch(() => null);
    if (existing) return existing.id;
  }
  const created = await guild.channels.create({ name: spec.name, type: ChannelType.GuildCategory });
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

// Posts (or reuses, if already posted and still present) the starter embed for one channel,
// pinning it on first post. Returns the message ID either way, for setupMessageIds.
async function ensurePosted(client, existingMessageIds, channelIds, key, buildPayload) {
  const channelId = channelIds[key];
  const existingMessageId = existingMessageIds[key];

  if (existingMessageId) {
    try {
      const channel = await client.channels.fetch(channelId);
      const existing = await channel.messages.fetch(existingMessageId);
      if (existing) return existingMessageId;
    } catch {
      // fall through — message (or channel) is gone, post fresh below
    }
  }

  const channel = await client.channels.fetch(channelId);
  const msg = await channel.send(buildPayload());
  await msg.pin().catch(err => console.error(`Failed to pin ${key} starter embed:`, err.message));
  return msg.id;
}

async function runMatchmakerSetup(guild, yuniteToken) {
  if (runningGuilds.has(guild.id)) {
    throw new Error('Setup is already running for this server — wait for it to finish before running it again.');
  }
  runningGuilds.add(guild.id);

  try {
    const config = getGuildConfig(guild.id);

    const roleIds = {};
    for (const spec of ROLE_SPECS) roleIds[spec.key] = await ensureRole(guild, config.roleIds, spec);

    const categoryIds = { ...config.categoryIds };
    for (const spec of CATEGORY_SPECS) categoryIds[spec.key] = await ensureCategory(guild, config.categoryIds, spec);

    const channelIds = {};
    for (const spec of CHANNEL_SPECS) channelIds[spec.key] = await ensureChannel(guild, config.channelIds, spec);

    // Persist roles/categories/channels before posting embeds — ensurePosted needs channelIds
    // (already have them locally) but buildRegisterEmbed needs the *final* getRoles channel ID,
    // which is already known at this point regardless.
    const setupMessageIds = { ...config.setupMessageIds };
    setupMessageIds.getRoles = await ensurePosted(
      guild.client, config.setupMessageIds, channelIds, 'getRoles',
      () => ({ embeds: [buildRolesEmbed()], components: buildRolesComponents() })
    );
    setupMessageIds.howto = await ensurePosted(
      guild.client, config.setupMessageIds, channelIds, 'howto',
      () => ({ embeds: [buildHowtoEmbed()] })
    );
    setupMessageIds.formParty = await ensurePosted(
      guild.client, config.setupMessageIds, channelIds, 'formParty',
      () => ({ embeds: [buildFormPartyInstructionsEmbed()] })
    );
    setupMessageIds.register = await ensurePosted(
      guild.client, config.setupMessageIds, channelIds, 'register',
      () => ({ embeds: [buildRegisterEmbed(channelIds.getRoles)] })
    );

    await setGuildConfig(guild.id, {
      roleIds, categoryIds, channelIds, setupMessageIds,
      secrets: { yuniteToken },
    });

    await enforcePermissions(guild);

    return {
      summary:
        '✅ MatchMaker setup complete!\n' +
        `Roles: ${ROLE_SPECS.map(s => s.name).join(', ')}\n` +
        `Categories: ${CATEGORY_SPECS.map(s => s.name).join(', ')}\n` +
        `Channels: ${CHANNEL_SPECS.map(s => `<#${channelIds[s.key]}>`).join(', ')}`,
    };
  } finally {
    runningGuilds.delete(guild.id);
  }
}

module.exports = { runMatchmakerSetup };
