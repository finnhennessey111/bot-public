// matchmaker-setup.js - The /matchmaker-setup orchestrator: creates every role/category/channel
// MatchMaker needs and posts the starter embeds, saving the resulting IDs to that guild's Mongo
// config (guild-config.js). Idempotent — checks guild-config's stored ID *and* that the Discord
// object still exists before creating anything, so re-running after a partial failure reuses
// whatever's already there instead of duplicating it.
//
// All Discord API calls are sequential, not parallel — gentler on rate limits, and keeps a
// partial failure in a cleanly resumable state rather than a pile of half-finished promises.

const { ChannelType } = require('discord.js');
const { getGuildConfig, setGuildConfig } = require('./guild-config');
const { enforcePermissions, botAccessOverwrite } = require('./permissions');
const { postCreativeQueueChannel, postComingSoonCreativeChannel } = require('./creative-channel');
const { QUEUE_CHANNEL_CONFIGS, COMING_SOON_CREATIVE_CATEGORIES } = require('./creative-channel-configs');
const { ACCESS_GATING_ENABLED } = require('./access');
const changelog = require('./changelog');
const {
  buildRolesEmbed, buildRolesComponents, buildBioButtonRow, buildRegisterEmbed, buildEpicLinkButtonRow,
  buildHowtoEmbed, buildSetupInstructionsEmbed,
  buildAccessChannelEmbed, buildAccessChannelButtons,
  buildSuggestionsChannelEmbed, buildSuggestionButtonRow,
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
  // Assigned directly by the Epic OAuth callback (webhook-server.js's /epic-callback) on a
  // successful link — gates #get-roles/#how-to-use/#access (permissions.js's progressive-
  // visibility ladder). Auto-created here like every other role, so setup never needs an admin to
  // hand us an externally-managed role ID.
  { key: 'verified', name: 'MatchMaker Verified' },
];

const CATEGORY_SPECS = [
  { key: 'EU', name: 'EU Tournaments' },
  { key: 'NAC', name: 'NAC Tournaments' },
  { key: 'ME', name: 'ME Tournaments' },
  // Parent for register/get-roles/how-to-use/access (CHANNEL_SPECS' `category: 'matchmaker'`
  // entries below) — groups the bot's generically-named, member-facing channels together instead
  // of scattering them at server root next to a server's own channels, where names like
  // "register" or "how-to-use" are more likely to clash with something the server already has.
  { key: 'matchmaker', name: 'MatchMaker' },
  // Parent for the four creative queue channels below — gets the bot's ViewChannel/SendMessages
  // set explicitly at creation (unlike the tournament categories above, which rely on each
  // channel's own per-creation overwrite instead), so any channel placed under it inherits bot
  // access automatically instead of needing enforcePermissions to patch it in after the fact.
  { key: 'creative', name: 'Creative' },
];

const CHANNEL_SPECS = [
  // Deliberately left out of the MatchMaker category (unlike the member-facing channels below)
  // — it's mod-only and hidden from regular members entirely (permissions.js's
  // MOD_ONLY_CHANNEL_KEYS), so grouping it with the member-facing ones isn't the same concern.
  { key: 'setup', name: 'setup' },
  { key: 'register', name: 'register', category: 'matchmaker' },
  { key: 'getRoles', name: 'get-roles', category: 'matchmaker' },
  { key: 'howto', name: 'how-to-use', category: 'matchmaker' },
  // Centralized suggest-a-feature (suggestions.js) — one button+modal, forwarded straight to the
  // developer and stored centrally, rather than free-form messages scattered across dozens of
  // separate servers' channels. Verified-member-visible (permissions.js's verifiedChannels).
  { key: 'suggestions', name: 'suggestions', category: 'matchmaker' },
  // Skipped entirely while access gating is disabled (see access.js's ACCESS_GATING_ENABLED) —
  // there's nothing for it to gate right now. Flip that flag back on to have new setups create it
  // again; existing servers that already have #access from before keep it untouched either way.
  ...(ACCESS_GATING_ENABLED ? [{ key: 'access', name: 'access', category: 'matchmaker' }] : []),
];

// Creative queue channels — separate from CHANNEL_SPECS above because they're tracked in
// guild-config's `creativeChannels` map (channelId + pinned messageId together), not
// `channelIds`, matching creative-channel.js's existing storage shape.
//
// 6s/8s ARE still created here (unlike an earlier version of this change, which skipped creating
// them entirely) — but ensureCreativeChannel below posts embeds.js's buildCreativeComingSoonEmbed
// (no queue button) into them instead of the real queue embed, since 6s/8s is a planned premium
// feature not available during the current free-for-everyone period. Creating the channel now and
// swapping its embed content later (once the feature ships) avoids ever needing to create/delete
// channels retroactively — see creative-channel-configs.js's COMING_SOON_CREATIVE_CATEGORIES.
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

async function ensureChannel(guild, existingChannelIds, spec, { parentId, parentLabel } = {}) {
  const existingId = existingChannelIds[spec.key];
  if (existingId) {
    const existing = await guild.channels.fetch(existingId).catch(() => null);
    if (existing) {
      await ensureChannelParent(existing, parentId, parentLabel);
      return existing.id;
    }
  }
  const created = await guild.channels.create({
    name: spec.name,
    type: ChannelType.GuildText,
    ...(parentId ? { parent: parentId } : {}),
  });
  return created.id;
}

// One-time migration for servers that ran /matchmaker-setup before a given channel's category
// existed (or before that particular channel had one assigned) — reparents an already-existing
// channel that's missing its parent or sitting under the wrong one. lockPermissions: false is
// essential here: Discord's default (true) would sync the channel's overwrites to the new parent,
// wiping the channel-specific overwrites enforcePermissions() already applied (role gates, mod
// role, bot access, attachment lock).
async function ensureChannelParent(channel, parentCategoryId, parentLabel) {
  if (!parentCategoryId || channel.parentId === parentCategoryId) return;
  try {
    await channel.setParent(parentCategoryId, { lockPermissions: false });
    console.log(`  📁 Moved #${channel.name} into the ${parentLabel} category`);
  } catch (err) {
    console.error(`  ⚠️ Failed to move #${channel.name} into the ${parentLabel} category:`, err.message);
  }
}

// Creates (or reuses) the channel for one creative category, then posts (or reuses) its queue
// embed via creative-channel.js's postCreativeQueueChannel — which persists {channelId,
// messageId} into guild-config's creativeChannels map itself, so no separate save is needed
// here. Only re-posts the embed if the channel and/or its pinned message are actually missing.
// COMING_SOON_CREATIVE_CATEGORIES (6s/8s right now) get postComingSoonCreativeChannel instead —
// same channel-creation/idempotency behavior either way, just different posted content.
async function ensureCreativeChannel(guild, category, spec, existingCreativeChannels, parentCategoryId) {
  const existing = existingCreativeChannels[category];

  if (existing?.channelId && existing?.messageId) {
    try {
      const channel = await guild.channels.fetch(existing.channelId);
      const msg = await channel.messages.fetch(existing.messageId);
      if (channel && msg) {
        await ensureChannelParent(channel, parentCategoryId, 'Creative');
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
    await ensureChannelParent(channel, parentCategoryId, 'Creative');
  }

  if (COMING_SOON_CREATIVE_CATEGORIES.includes(category)) {
    await postComingSoonCreativeChannel(guild.id, channel, category);
  } else {
    await postCreativeQueueChannel(guild.id, channel, category, QUEUE_CHANNEL_CONFIGS[category]);
  }
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

async function runMatchmakerSetup(guild) {
  if (runningGuilds.has(guild.id)) {
    throw new Error('Setup is already running for this server — wait for it to finish before running it again.');
  }
  runningGuilds.add(guild.id);

  try {
    const config = getGuildConfig(guild.id);
    let channelIds, creativeChannelIds, roleIds;

    try {
      roleIds = {};
      for (const spec of ROLE_SPECS) roleIds[spec.key] = await ensureRole(guild, config.roleIds, spec);
      // Saved immediately, not batched with everything else at the end — every step below this
      // one (categories, channels, embeds) can fail on its own permission gap without the run
      // "forgetting" roles it already created. Without this, a later failure leaves Discord
      // holding roles/channels the bot has no record of, so the next run — blind to what already
      // exists — recreates all of them from scratch, producing duplicates rather than reuse.
      await setGuildConfig(guild.id, { roleIds });

      const categoryIds = { ...config.categoryIds };
      for (const spec of CATEGORY_SPECS) {
        const permissionOverwrites = spec.key === 'creative' ? [botAccessOverwrite(guild)] : undefined;
        categoryIds[spec.key] = await ensureCategory(guild, config.categoryIds, spec, { permissionOverwrites });
      }
      await setGuildConfig(guild.id, { categoryIds });

      channelIds = {};
      for (const spec of CHANNEL_SPECS) {
        const parentId = spec.category ? categoryIds[spec.category] : undefined;
        channelIds[spec.key] = await ensureChannel(guild, config.channelIds, spec, { parentId, parentLabel: 'MatchMaker' });
      }
      await setGuildConfig(guild.id, { channelIds });

      creativeChannelIds = {};
      for (const spec of CREATIVE_CHANNEL_SPECS) {
        creativeChannelIds[spec.key] = await ensureCreativeChannel(guild, spec.key, spec, config.creativeChannels, categoryIds.creative);
      }
      // Creative channel IDs are already persisted incrementally, per-channel, inside
      // postCreativeQueueChannel (creative-channel.js) — no separate save needed here.

      const changelogEntries = await changelog.getRecentEntries();

      const setupMessageIds = { ...config.setupMessageIds };
      setupMessageIds.setup = await ensurePosted(
        guild.client, config.setupMessageIds, channelIds, 'setup',
        () => ({ embeds: [buildSetupInstructionsEmbed(changelogEntries)] })
      );
      setupMessageIds.getRoles = await ensurePosted(
        guild.client, config.setupMessageIds, channelIds, 'getRoles',
        () => ({ embeds: [buildRolesEmbed()], components: buildRolesComponents() })
      );
      // Bio button posted as its own message right after — Discord caps a message at 5 action
      // rows, and buildRolesComponents() already uses all 5 for select menus (a select can't
      // share a row with a button either), so there's no room left in the same message.
      setupMessageIds.getRolesBio = await ensurePosted(
        guild.client, config.setupMessageIds, { ...channelIds, getRolesBio: channelIds.getRoles }, 'getRolesBio',
        () => ({ components: [buildBioButtonRow()] })
      );
      setupMessageIds.howto = await ensurePosted(
        guild.client, config.setupMessageIds, channelIds, 'howto',
        () => ({ embeds: [buildHowtoEmbed()] })
      );
      setupMessageIds.register = await ensurePosted(
        guild.client, config.setupMessageIds, channelIds, 'register',
        () => ({ embeds: [buildRegisterEmbed(channelIds.getRoles)], components: [buildEpicLinkButtonRow()] })
      );
      setupMessageIds.suggestions = await ensurePosted(
        guild.client, config.setupMessageIds, channelIds, 'suggestions',
        () => ({ embeds: [buildSuggestionsChannelEmbed()], components: [buildSuggestionButtonRow()] })
      );
      if (ACCESS_GATING_ENABLED) {
        setupMessageIds.access = await ensurePosted(
          guild.client, config.setupMessageIds, channelIds, 'access',
          () => ({ embeds: [buildAccessChannelEmbed()], components: [buildAccessChannelButtons()] })
        );
      }
      await setGuildConfig(guild.id, { setupMessageIds });

      await enforcePermissions(guild);
    } catch (err) {
      // Nothing created above is ever deleted on failure — this just reports, from guild-config's
      // now-incrementally-saved state, exactly how far this run actually got, so a partial
      // failure is diagnosable instead of a silent "some things are just gone" (or, pre-fix,
      // silently duplicated on the next retry).
      const saved = getGuildConfig(guild.id);
      const missing = (specs, ids) => specs.filter(s => !ids?.[s.key]).map(s => s.name);
      const missingRoles = missing(ROLE_SPECS, saved.roleIds);
      const missingCategories = missing(CATEGORY_SPECS, saved.categoryIds);
      const missingChannels = missing(CHANNEL_SPECS, saved.channelIds);
      const missingCreative = CREATIVE_CHANNEL_SPECS.filter(s => !saved.creativeChannels?.[s.key]?.channelId).map(s => s.name);

      console.error(`❌ /matchmaker-setup failed partway through for guild ${guild.id}: ${err.message}`);
      console.error(
        `   Confirmed so far — roles: ${ROLE_SPECS.length - missingRoles.length}/${ROLE_SPECS.length}, `
        + `categories: ${CATEGORY_SPECS.length - missingCategories.length}/${CATEGORY_SPECS.length}, `
        + `channels: ${CHANNEL_SPECS.length - missingChannels.length}/${CHANNEL_SPECS.length}, `
        + `creative channels: ${CREATIVE_CHANNEL_SPECS.length - missingCreative.length}/${CREATIVE_CHANNEL_SPECS.length}`
      );
      if (missingRoles.length) console.error(`   Not yet created: roles [${missingRoles.join(', ')}]`);
      if (missingCategories.length) console.error(`   Not yet created: categories [${missingCategories.join(', ')}]`);
      if (missingChannels.length) console.error(`   Not yet created: channels [${missingChannels.join(', ')}]`);
      if (missingCreative.length) console.error(`   Not yet created: creative channels [${missingCreative.join(', ')}]`);
      console.error('   Nothing that already existed was deleted or altered — fix the permission gap above and re-run /matchmaker-setup, it will resume from here instead of duplicating what already exists.');
      throw err;
    }

    const verifiedRoleLine = `Verified role: <@&${roleIds.verified}> — get-roles/how-to-use/access `
      + 'unlock once a member links their Epic account via the Link Epic Account button in #register.';

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

// Pushes a fresh #setup embed (with the latest changelog) to every guild's already-posted setup
// message, live — called once by index.js's /post-update right after a new changelog entry is
// saved, so "Recent Updates" reaches every server immediately instead of only the next time each
// server's admins happen to re-run /matchmaker-setup themselves. Guilds with no #setup message yet
// (never ran /matchmaker-setup) are silently skipped — nothing to push to.
async function refreshAllSetupEmbeds(client) {
  const changelogEntries = await changelog.getRecentEntries();
  const embed = buildSetupInstructionsEmbed(changelogEntries);

  let refreshed = 0;
  for (const guild of client.guilds.cache.values()) {
    const config = getGuildConfig(guild.id);
    const channelId = config.channelIds?.setup;
    const messageId = config.setupMessageIds?.setup;
    if (!channelId || !messageId) continue;

    try {
      const channel = await guild.channels.fetch(channelId);
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ embeds: [embed] });
      refreshed++;
    } catch (err) {
      console.error(`[changelog] Failed to refresh #setup embed for guild ${guild.id}:`, err.message);
    }
  }
  return refreshed;
}

module.exports = {
  runMatchmakerSetup,
  refreshAllSetupEmbeds,
  // Specs exported for testing (e.g. a regression guard confirming no "general" text/voice
  // channel is ever added back) — runMatchmakerSetup itself needs a live Discord guild object to
  // exercise, so asserting against these directly is how that's verified without one.
  ROLE_SPECS, CATEGORY_SPECS, CHANNEL_SPECS, CREATIVE_CHANNEL_SPECS,
};
