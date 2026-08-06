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
const { postCreativeQueueChannel, postComingSoonCreativeChannel, ensureComingSoonCreativeChannel } = require('./creative-channel');
const { QUEUE_CHANNEL_CONFIGS, COMING_SOON_CREATIVE_CATEGORIES } = require('./creative-channel-configs');
const { ACCESS_GATING_ENABLED } = require('./access');
const { BUILD_MODES } = require('./build-mode');
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

// EU/NAC/ME used to be here (one category per region, tournament text channels parented into the
// matching one) — replaced first by a single shared "tournaments" forum with region as a tag, and
// now by 'tournaments' below: one category holding 9 separate forums, one per region×build-mode
// combination (TOURNAMENT_FORUM_SPECS) — region is expressed by WHICH forum a post lives in again,
// same as the original per-region categories, just with build-mode as an additional dimension
// categories never had. A guild that already has old EU/NAC/ME categories, or the old single
// shared "tournaments" forum, from before either migration keeps them untouched — nothing here
// deletes a pre-existing category/channel, they're just no longer created/managed for new setups.
// See ensureTournamentForums' own doc comment for why 9 separate forums instead of tags.
const CATEGORY_SPECS = [
  // Parent for register/get-roles/how-to-use/access (CHANNEL_SPECS' `category: 'matchmaker'`
  // entries below) — groups the bot's generically-named, member-facing channels together instead
  // of scattering them at server root next to a server's own channels, where names like
  // "register" or "how-to-use" are more likely to clash with something the server already has.
  // position: 0 — pinned to the very top of the channel list (not left wherever Discord's default
  // append-at-the-end placement would put it) so a brand new member's first-ever view of the
  // server leads with #register, not whatever the server's own channels happen to be. Re-applied
  // on every /matchmaker-setup re-run (ensureCategory below), not just at creation, so an existing
  // server that ran setup before this shipped also gets moved, not just fresh ones.
  { key: 'matchmaker', name: 'MatchMaker', position: 0 },
  // Parent for the four creative queue channels below — gets the bot's ViewChannel/SendMessages
  // set explicitly at creation (unlike the tournament categories above, which rely on each
  // channel's own per-creation overwrite instead), so any channel placed under it inherits bot
  // access automatically instead of needing enforcePermissions to patch it in after the fact.
  { key: 'creative', name: 'Creative' },
  // Parents for the 9 tournament forums (TOURNAMENT_FORUM_SPECS/ensureTournamentForums below) —
  // one category per region (3 build-mode forums each), replacing the earlier single shared
  // "Tournaments" category that held all 9 flat. Matches how the pre-forums channel system used to
  // visually organize by region. A guild that already has the old single category (from before this
  // shipped) gets migrated automatically — see guild-config.js's channelIds.tournamentForum_*
  // migration, which now also ensures these 3 categories exist and reparents any already-existing
  // forums into the correct one. The old category itself is never deleted (same "never delete what
  // a mod might have touched" precedent as everywhere else in this file) — it's simply left behind,
  // empty, once its 9 children have moved out.
  { key: 'tournaments_EU', name: 'EU Tournaments' },
  { key: 'tournaments_NAC', name: 'NAC Tournaments' },
  { key: 'tournaments_ME', name: 'ME Tournaments' },
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
  // Name is "suggestions-report-a-bug", not the literal "Suggestions / Report a Bug" requested —
  // Discord text channel names can't contain spaces or "/" (lowercased, hyphens only), so this is
  // the closest valid equivalent.
  { key: 'suggestions', name: 'suggestions-report-a-bug', category: 'matchmaker' },
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

// Same region set tournament-scraper.js's SUPPORTED_REGIONS covers — deliberately not imported
// from there (that module is scraper-side, this is guild-setup-side; duplicating three short
// strings is cheaper than adding a cross-cutting dependency between them for it).
const REGION_SPECS = [
  { key: 'EU', name: 'EU' },
  { key: 'NAC', name: 'NAC' },
  { key: 'ME', name: 'ME' },
];

// 9 forums: one per region×build-mode combination. key matches exactly what channel-manager.js's
// createTournamentChannel looks up (`tournamentForum_${region}_${buildMode}`) — guild-config.js's
// existing flat channelIds map stores each one under this composite key, same mechanism every
// other single-channel entry (getRoles, howto, setup, ...) already uses; no new top-level
// guild-config field needed for this (unlike the old tagIds map, which this replaces and makes
// unused going forward — see guild-config.js's own migration doc comment on why tagIds is left in
// place rather than deleted).
const TOURNAMENT_FORUM_SPECS = REGION_SPECS.flatMap(region =>
  BUILD_MODES.map(mode => ({
    key: `tournamentForum_${region.key}_${mode.key}`,
    name: `${region.name.toLowerCase()}-${mode.abbreviation.toLowerCase()}`,
    region: region.key,
    buildMode: mode.key,
  }))
);

const runningGuilds = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Pause between guilds for /refresh-all-servers below — each guild's own setup already runs its
// Discord API calls sequentially (this file's top doc comment), which is the real rate-limit
// safeguard; this is an extra buffer on top of that so a bot in many servers doesn't chain dozens
// of guilds' worth of role/channel/embed calls back-to-back with zero breathing room between them.
const REFRESH_ALL_GUILDS_PACING_MS = 2000;

async function ensureRole(guild, existingRoleIds, spec) {
  const existingId = existingRoleIds[spec.key];
  if (existingId) {
    const existing = await guild.roles.fetch(existingId).catch(() => null);
    if (existing) return existing.id;
  }
  const created = await guild.roles.create({ name: spec.name });
  return created.id;
}

async function ensureCategory(guild, existingCategoryIds, spec, { permissionOverwrites, position } = {}) {
  const existingId = existingCategoryIds[spec.key];
  if (existingId) {
    const existing = await guild.channels.fetch(existingId).catch(() => null);
    if (existing) {
      // Re-applied on every run (not just once at creation) — an existing server that ran setup
      // before a spec's position was introduced/changed needs the same move a fresh setup gets,
      // not just new servers. Skipped when already correct so a routine re-run isn't an API call
      // that does nothing.
      if (position !== undefined && existing.position !== position) {
        try {
          await existing.setPosition(position);
          console.log(`  📌 Moved ${spec.name} category to position ${position}`);
        } catch (err) {
          console.error(`  ⚠️ Failed to reposition ${spec.name} category:`, err.message);
        }
      }
      return existing.id;
    }
  }
  const created = await guild.channels.create({
    name: spec.name,
    type: ChannelType.GuildCategory,
    ...(permissionOverwrites ? { permissionOverwrites } : {}),
    ...(position !== undefined ? { position } : {}),
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

// Fetch-or-create all 9 region×build-mode forums, each parented under ITS OWN region's category
// (categoryIdsByRegion — {EU: id, NAC: id, ME: id}, see CATEGORY_SPECS above). Each forum is
// independently idempotent (same fetch-existing-by-id-else-create pattern as ensureChannel/
// ensureCategory above) — a partial prior run that only got through some of the 9 resumes
// correctly, same "nothing duplicated on retry" guarantee the rest of setup already has. For an
// EXISTING forum (found by its stored id) whose current parent isn't yet its region's category —
// e.g. one still sitting under the old single shared "Tournaments" category from before this
// restructure — ensureChannelParent reparents it in place. This is the ONLY mechanism that moves an
// existing forum: nothing here ever deletes or recreates a forum channel, so every post/thread
// already inside it is completely unaffected (a thread's parent is the forum channel itself, not
// the category, so moving the forum to a new category carries its threads along automatically,
// Discord-side, with zero API calls needed for the threads themselves).
//
// No tags here at all (unlike the earlier single-shared-forum design this replaces) — region AND
// build-mode are now both expressed by WHICH of the 9 forums a post lives in, the same way region
// alone used to be expressed by which of the 3 old EU/NAC/ME categories a channel lived in. That's
// what item #2/#3 of the restructure asked for specifically ("region is no longer a tag... replace
// with 9 distinct forum channels"), and it's simpler besides: no setAvailableTags reconciliation,
// no tag-id-preservation logic to get right.
//
// permissionOverwrites deliberately NOT set here — a forum THREAD can't hold its own overwrites
// independent of its parent forum channel (confirmed via discord.js source: ThreadChannel extends
// BaseChannel directly, not GuildChannel, so it has no .permissionOverwrites at all;
// GuildForumThreadManager#create's options don't accept permissionOverwrites either). The forum
// CHANNEL's own overwrites are what every post inherits — permissions.js's enforcePermissions
// (called right after this, at the end of runMatchmakerSetup, and again on every bot startup) sets
// them on all 9, same as every other managed channel. Reparenting a channel never touches its own
// overwrites either way (setParent's lockPermissions:false below is exactly what prevents that).
async function ensureTournamentForums(guild, existingChannelIds, categoryIdsByRegion) {
  const channelIds = {};

  for (const spec of TOURNAMENT_FORUM_SPECS) {
    const categoryId = categoryIdsByRegion?.[spec.region] ?? null;
    const existingId = existingChannelIds[spec.key];
    let channel = existingId ? await guild.channels.fetch(existingId).catch(() => null) : null;

    if (!channel) {
      channel = await guild.channels.create({ name: spec.name, type: ChannelType.GuildForum, parent: categoryId });
    } else {
      await ensureChannelParent(channel, categoryId, `${spec.region} Tournaments`);
    }

    channelIds[spec.key] = channel.id;
  }

  return channelIds;
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
  const isComingSoon = COMING_SOON_CREATIVE_CATEGORIES.includes(category);

  if (existing?.channelId && existing?.messageId) {
    try {
      const channel = await guild.channels.fetch(existing.channelId);
      const msg = await channel.messages.fetch(existing.messageId);
      if (channel && msg) {
        await ensureChannelParent(channel, parentCategoryId, 'Creative');

        // Repairs a channel that predates the coming-soon change and still shows the old real
        // queue embed+buttons — without this, "already exists" would leave it exactly as it was
        // forever, which is exactly the bug this closes. creative-channel.js's
        // ensureComingSoonCreativeChannel is a no-op if it's already showing coming-soon content.
        if (isComingSoon) await ensureComingSoonCreativeChannel(guild.id, channel, category, msg.id);

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

  if (isComingSoon) {
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
        categoryIds[spec.key] = await ensureCategory(guild, config.categoryIds, spec, { permissionOverwrites, position: spec.position });
      }
      await setGuildConfig(guild.id, { categoryIds });

      channelIds = {};
      for (const spec of CHANNEL_SPECS) {
        const parentId = spec.category ? categoryIds[spec.category] : undefined;
        channelIds[spec.key] = await ensureChannel(guild, config.channelIds, spec, { parentId, parentLabel: 'MatchMaker' });
      }

      const tournamentForumIds = await ensureTournamentForums(guild, config.channelIds, {
        EU: categoryIds.tournaments_EU, NAC: categoryIds.tournaments_NAC, ME: categoryIds.tournaments_ME,
      });
      Object.assign(channelIds, tournamentForumIds);
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
      const missingForums = missing(TOURNAMENT_FORUM_SPECS, saved.channelIds);

      console.error(`❌ /matchmaker-setup failed partway through for guild ${guild.id}: ${err.message}`);
      console.error(
        `   Confirmed so far — roles: ${ROLE_SPECS.length - missingRoles.length}/${ROLE_SPECS.length}, `
        + `categories: ${CATEGORY_SPECS.length - missingCategories.length}/${CATEGORY_SPECS.length}, `
        + `channels: ${CHANNEL_SPECS.length - missingChannels.length}/${CHANNEL_SPECS.length}, `
        + `tournament forums: ${TOURNAMENT_FORUM_SPECS.length - missingForums.length}/${TOURNAMENT_FORUM_SPECS.length}, `
        + `creative channels: ${CREATIVE_CHANNEL_SPECS.length - missingCreative.length}/${CREATIVE_CHANNEL_SPECS.length}`
      );
      if (missingRoles.length) console.error(`   Not yet created: roles [${missingRoles.join(', ')}]`);
      if (missingCategories.length) console.error(`   Not yet created: categories [${missingCategories.join(', ')}]`);
      if (missingChannels.length) console.error(`   Not yet created: channels [${missingChannels.join(', ')}]`);
      if (missingForums.length) console.error(`   Not yet created: tournament forums [${missingForums.join(', ')}]`);
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
        `Tournament forums: ${TOURNAMENT_FORUM_SPECS.map(s => `<#${channelIds[s.key]}>`).join(', ')}\n` +
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

// /refresh-all-servers (index.js) — re-runs the SAME idempotent runMatchmakerSetup used by a real
// /matchmaker-setup, across every guild the bot is currently in. Sequential (not Promise.all), with
// a pause between guilds (REFRESH_ALL_GUILDS_PACING_MS) — same rate-limit reasoning as the rest of
// this file, just one level up (per-guild instead of per-API-call). A failure in one guild (most
// realistically a missing bot permission there, or that guild's own runMatchmakerSetup already
// running concurrently via a real /matchmaker-setup — runningGuilds' own guard) is caught and
// recorded, never stops the run — every remaining guild still gets processed. Returns the raw
// result rather than throwing or messaging anyone itself; index.js's handler owns turning this into
// a DM (via buildRefreshAllSummaryMessage below), since Discord-interaction/DM concerns don't belong
// in this file's existing pure-orchestration functions.
// pacingMs defaults to the real production pause but is an explicit parameter (not a closed-over
// constant) purely so tests can pass 0 and exercise a many-guild run without actually waiting
// REFRESH_ALL_GUILDS_PACING_MS * (guildCount - 1) real seconds — index.js's real caller never passes
// this, so production behavior is unaffected.
async function runMatchmakerSetupForAllGuilds(client, pacingMs = REFRESH_ALL_GUILDS_PACING_MS) {
  const succeeded = [];
  const failed = [];

  const guilds = [...client.guilds.cache.values()];
  for (let i = 0; i < guilds.length; i++) {
    const guild = guilds[i];
    try {
      await runMatchmakerSetup(guild);
      succeeded.push({ guildId: guild.id, guildName: guild.name });
    } catch (err) {
      console.error(`[refresh-all-servers] Setup failed for guild ${guild.id} (${guild.name}): ${err.message}`);
      failed.push({ guildId: guild.id, guildName: guild.name, reason: err.message });
    }
    if (i < guilds.length - 1) await sleep(pacingMs);
  }

  return { succeeded, failed };
}

// Discord's real message-length cap is 2000 chars — 1900 leaves headroom for this being sent as a
// DM (no embed truncation safety net the way a field-capped embed would have). A guild with a huge
// number of failures gets its failure list truncated with a "...and N more" note (full detail is
// still in the server's own logs — the console.error above, per guild, as it happens) rather than
// this either silently dropping guilds from the list or the DM send itself failing outright.
const DM_SUMMARY_MAX_LENGTH = 1900;

function buildRefreshAllSummaryMessage({ succeeded, failed }) {
  const total = succeeded.length + failed.length;
  const lines = [
    '✅ /refresh-all-servers complete.',
    `Succeeded: ${succeeded.length}/${total}`,
    `Failed: ${failed.length}/${total}`,
  ];

  if (failed.length > 0) {
    lines.push('', 'Failures:');
    let shown = 0;
    for (const f of failed) {
      const line = `• ${f.guildName} (${f.guildId}): ${f.reason}`;
      if (lines.join('\n').length + line.length + 1 > DM_SUMMARY_MAX_LENGTH) break;
      lines.push(line);
      shown++;
    }
    if (shown < failed.length) {
      lines.push(`• ...and ${failed.length - shown} more (see server logs for the full list)`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  runMatchmakerSetup,
  refreshAllSetupEmbeds,
  runMatchmakerSetupForAllGuilds,
  buildRefreshAllSummaryMessage,
  // ensureTournamentForums/ensureCategory: called directly by guild-config.js's self-heal migration
  // (a guild missing any of the 9 tournament forums, or the 3 region categories, shouldn't need a
  // full /matchmaker-setup re-run just to get them) — see that migration's own doc comment for why
  // it's a deferred require rather than a top-level one.
  ensureTournamentForums,
  ensureCategory,
  // Specs exported for testing (e.g. a regression guard confirming no "general" text/voice
  // channel is ever added back) — runMatchmakerSetup itself needs a live Discord guild object to
  // exercise, so asserting against these directly is how that's verified without one.
  ROLE_SPECS, CATEGORY_SPECS, CHANNEL_SPECS, CREATIVE_CHANNEL_SPECS, TOURNAMENT_FORUM_SPECS,
};
