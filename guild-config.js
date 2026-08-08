// guild-config.js - In-memory cache of per-guild configuration (role/channel/category IDs,
// creative-channel routing, setup-message tracking, and per-guild secrets), backed by
// models/Guild.js. Mongo-only — there's no meaningful offline/JSON equivalent for guild config,
// unlike store.js's queue/match data.
//
// Two "ensure a Guild doc exists" paths exist and must never both fire a DM:
//   - init(client): startup reconciliation for every already-joined guild — no DM.
//   - handleNewGuild(guild): the guildCreate event — DMs the owner, this is the only DM path.

const GuildModel = require('./models/Guild');
const { buildWelcomeDmEmbed } = require('./embeds');

const cache = {}; // { [guildId]: { channelIds, roleIds, categoryIds, tagIds, creativeChannels, setupMessageIds, secrets } }

function emptyConfig() {
  return { channelIds: {}, roleIds: {}, categoryIds: {}, tagIds: {}, creativeChannels: {}, setupMessageIds: {}, secrets: {} };
}

function toCacheEntry(doc) {
  return {
    channelIds: doc.channelIds ?? {},
    roleIds: doc.roleIds ?? {},
    categoryIds: doc.categoryIds ?? {},
    tagIds: doc.tagIds ?? {},
    creativeChannels: doc.creativeChannels ?? {},
    setupMessageIds: doc.setupMessageIds ?? {},
    secrets: doc.secrets ?? {},
  };
}

async function upsertBareGuildDoc(guildId) {
  const doc = await GuildModel.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId, createdAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  ).lean();
  cache[guildId] = toCacheEntry(doc);
  return cache[guildId];
}

// One-time backfill for the guild this bot originally ran as single-guild — its channelIds/
// roleIds/categoryIds have never been written to Mongo (only pinnedMessages was ever used).
// Without this, the moment env-var reads are removed from the rest of the codebase, that guild
// loses all role/channel/category resolution. Only runs if that guild's roleIds.mod is empty,
// so it's safe to call on every startup — a no-op after the first successful run.
async function seedLegacyGuildFromEnv() {
  const guildId = process.env.GUILD_ID;
  if (!guildId) return;

  const existing = cache[guildId] ?? (await upsertBareGuildDoc(guildId));
  if (existing.roleIds?.mod) return; // already seeded

  const roleIds = {
    ...(process.env.ROLE_EU && { EU: process.env.ROLE_EU }),
    ...(process.env.ROLE_NAC && { NAC: process.env.ROLE_NAC }),
    ...(process.env.ROLE_ME && { ME: process.env.ROLE_ME }),
    ...(process.env.ROLE_PC && { PC: process.env.ROLE_PC }),
    ...(process.env.ROLE_CONSOLE && { Console: process.env.ROLE_CONSOLE }),
    ...(process.env.ROLE_MOBILE && { Mobile: process.env.ROLE_MOBILE }),
    ...(process.env.ROLE_FRAGGER && { Fragger: process.env.ROLE_FRAGGER }),
    ...(process.env.ROLE_IGL && { IGL: process.env.ROLE_IGL }),
    ...(process.env.MOD_ROLE_ID && { mod: process.env.MOD_ROLE_ID }),
  };
  const categoryIds = {
    ...(process.env.CATEGORY_EU && { EU: process.env.CATEGORY_EU }),
    ...(process.env.CATEGORY_NAC && { NAC: process.env.CATEGORY_NAC }),
    ...(process.env.CATEGORY_ME && { ME: process.env.CATEGORY_ME }),
    ...(process.env.MATCH_CATEGORY_ID && { match: process.env.MATCH_CATEGORY_ID }),
  };
  const channelIds = {
    ...(process.env.GET_ROLES_CHANNEL_ID && { getRoles: process.env.GET_ROLES_CHANNEL_ID }),
    ...(process.env.HOWTO_CHANNEL_ID && { howto: process.env.HOWTO_CHANNEL_ID }),
  };

  await setGuildConfig(guildId, { roleIds, categoryIds, channelIds });
  console.log(`[GuildConfig] Seeded legacy guild ${guildId} config from environment variables.`);
}

// Fields introduced by past code changes that an existing guild's stored config simply won't
// have, since config isn't retroactively updated just because the code changed — without this, a
// guild set up before the field existed is stuck logging a warning (e.g. permissions.js's "no
// verified role configured") forever, until an admin notices and manually re-runs
// /matchmaker-setup. Each entry here detects the gap and fills it in exactly the way
// /matchmaker-setup itself would (matchmaker-setup.js's ROLE_SPECS 'verified' entry: create if
// missing, name "MatchMaker Verified"), so runGuildConfigMigrations below can just walk the list.
// Add future backfills here as new fields get introduced.
const GUILD_CONFIG_MIGRATIONS = [
  {
    name: 'roleIds.verified',
    isMissing: (config) => !config.roleIds?.verified,
    apply: async (guild) => {
      const role = await guild.roles.create({ name: 'MatchMaker Verified' });
      await setGuildConfig(guild.id, { roleIds: { verified: role.id } });
      return `created role "MatchMaker Verified" (${role.id})`;
    },
  },
  {
    // 9-forum tournament channel + 3-region-category migration — a guild that ran
    // /matchmaker-setup before this shipped is missing one or more of the 9 region×build-mode
    // tournament forums (or, for a guild that only ever saw the earlier single-shared-forum
    // design, all 9 of them), and/or is missing one or more of the 3 region categories (EU/NAC/ME
    // Tournaments) those forums should each be parented under — including a guild that already has
    // all 9 forums, just still sitting under the OLD single shared "Tournaments" category from
    // before this restructure. Self-heals both here (same precedent as roleIds.verified above) so
    // every existing server gets migrated automatically at the bot's next startup, not only if an
    // admin happens to re-run /matchmaker-setup. The old single "Tournaments" category itself (and
    // the earlier-still single shared forum/tagIds config, if this guild has them from even before
    // that) is left completely untouched — not deleted — it's simply left behind, empty, once its
    // children have moved out; ensureTournamentForums' own doc comment covers why reparenting an
    // existing forum never touches any post/thread already inside it.
    name: 'channelIds.tournamentForum_* (9 forums) + categoryIds.tournaments_{EU,NAC,ME} (3 region categories)',
    isMissing: (config) => {
      const { TOURNAMENT_FORUM_SPECS } = require('./matchmaker-setup');
      const missingForum = TOURNAMENT_FORUM_SPECS.some(spec => !config.channelIds?.[spec.key]);
      const missingCategory = ['EU', 'NAC', 'ME'].some(region => !config.categoryIds?.[`tournaments_${region}`]);
      return missingForum || missingCategory;
    },
    apply: async (guild) => {
      // Deferred require: matchmaker-setup.js requires guild-config.js at the top level, so
      // requiring it back at module load here would be a real circular require — only
      // ensureCategory/ensureTournamentForums/TOURNAMENT_FORUM_SPECS are needed, and only once this
      // migration actually runs (isMissing above also uses the deferred form for the same reason).
      const { ensureCategory, ensureTournamentForums } = require('./matchmaker-setup');
      const config = getGuildConfig(guild.id);

      const categoryIds = { ...config.categoryIds };
      for (const region of ['EU', 'NAC', 'ME']) {
        const key = `tournaments_${region}`;
        if (!categoryIds[key]) {
          categoryIds[key] = await ensureCategory(guild, config.categoryIds, { key, name: `${region} Tournaments` });
        }
      }
      await setGuildConfig(guild.id, { categoryIds });

      const forumChannelIds = await ensureTournamentForums(guild, config.channelIds, {
        EU: categoryIds.tournaments_EU, NAC: categoryIds.tournaments_NAC, ME: categoryIds.tournaments_ME,
      });
      await setGuildConfig(guild.id, { channelIds: forumChannelIds });
      return `ensured 3 region categories, created/reparented ${Object.keys(forumChannelIds).length} tournament forum(s)`;
    },
  },
  {
    // Renames an already-created #suggestions channel to match matchmaker-setup.js's current
    // CHANNEL_SPECS name ("suggestions-report-a-bug") — ensureChannel (matchmaker-setup.js) only
    // ever creates-if-missing/reparents an existing channel, it never corrects an existing one's
    // name, so a guild that ran /matchmaker-setup before this renaming shipped would otherwise keep
    // the old name forever, with no path back to the new one short of a manual Discord rename (the
    // exact "one-off manual rename that gets reverted" problem this exists to avoid — except here
    // it's the reverse: without this, nothing would ever apply the new name at all).
    //
    // isMissing can't check the live Discord channel name directly (isMissing only ever sees the
    // cached config, synchronously, no guild/network access) — it stays "missing" for as long as a
    // suggestions channel is configured at all, so apply() below re-checks and is a cheap no-op
    // once the name already matches, rather than only ever running once.
    name: 'channelIds.suggestions renamed to "suggestions-report-a-bug"',
    isMissing: (config) => !!config.channelIds?.suggestions,
    apply: async (guild) => {
      const config = getGuildConfig(guild.id);
      const channel = await guild.channels.fetch(config.channelIds.suggestions).catch(() => null);
      if (!channel) return 'suggestions channel no longer exists — nothing to rename';

      const previousName = channel.name;
      if (previousName === 'suggestions-report-a-bug') return 'already correctly named — no-op';

      await channel.setName('suggestions-report-a-bug');
      return `renamed #${channel.id} from "${previousName}" to "suggestions-report-a-bug"`;
    },
  },
  {
    // Deletes the dedicated #how-to-use channel matchmaker-setup.js used to auto-create — removed
    // entirely (matchmaker-setup.js's CHANNEL_SPECS no longer has a 'howto' entry) since it's
    // redundant with /setup-howto (index.js), which posts the exact same embed on demand into
    // whichever channel a mod actually wants it in. A guild that ran /matchmaker-setup before this
    // shipped still has the old channel and its stored channelIds.howto/setupMessageIds.howto —
    // this deletes the real Discord channel (if it's still there) and clears both stored ids, same
    // "self-heal automatically at next startup" precedent as every other migration here.
    //
    // Deliberately does NOT clear config on a failed delete (e.g. missing Manage Channels) — left
    // "missing" so this retries every startup until it actually succeeds, rather than silently
    // forgetting about an orphaned channel forever the way clearing config on failure would.
    name: 'channelIds.howto deleted (how-to-use channel removed)',
    isMissing: (config) => !!config.channelIds?.howto,
    apply: async (guild) => {
      const config = getGuildConfig(guild.id);
      const channelId = config.channelIds.howto;
      const channel = await guild.channels.fetch(channelId).catch(() => null);

      if (channel) {
        await channel.delete(); // let this throw — a real failure (e.g. missing permission) must keep isMissing true so this retries next startup, not silently succeed
      }

      await deleteConfigKeys(guild.id, { channelIds: ['howto'], setupMessageIds: ['howto'] });
      return channel ? `deleted #${channel.name} (${channelId}) and cleared stored channel/message id` : 'channel already gone — cleared stale stored channel/message id';
    },
  },
];

// Startup self-heal: for every guild the bot is currently in, check each known migration against
// that guild's (already-hydrated) config and backfill it live if missing. Re-reads config between
// migrations (not one snapshot for the whole guild) so an earlier migration in this same pass is
// visible to a later one's isMissing check, in case a future migration ever depends on one before
// it. Must run after cache hydration above and before enforcePermissions (index.js's ready
// handler already orders it that way) so a freshly-created role is applied on this same startup,
// not just persisted for next time.
async function runGuildConfigMigrations(client) {
  for (const guild of client.guilds.cache.values()) {
    for (const migration of GUILD_CONFIG_MIGRATIONS) {
      const config = getGuildConfig(guild.id);
      if (!migration.isMissing(config)) continue;

      try {
        const detail = await migration.apply(guild, config);
        console.log(`[GuildConfig] 🩹 Auto-migrated guild ${guild.id} (${guild.name}) — ${migration.name}: ${detail}`);
      } catch (err) {
        console.error(`[GuildConfig] ⚠️ Failed to auto-migrate guild ${guild.id} (${guild.name}) for ${migration.name}:`, err.message);
      }
    }
  }
}

// Startup reconciliation: hydrate every known Guild doc, make sure every guild the bot is
// currently in (including ones joined while the bot was offline) has at least a bare doc, then
// self-heal any known-missing config fields on every already-configured guild — no DM anywhere
// in this function, that's handleNewGuild's job exclusively.
async function init(client) {
  const docs = await GuildModel.find({}).lean();
  for (const doc of docs) cache[doc.guildId] = toCacheEntry(doc);

  for (const guild of client.guilds.cache.values()) {
    if (!cache[guild.id]) await upsertBareGuildDoc(guild.id);
  }

  await seedLegacyGuildFromEnv();
  await runGuildConfigMigrations(client);
  console.log(`[GuildConfig] Loaded config for ${Object.keys(cache).length} guild(s).`);
}

// Only called from client.on('guildCreate', ...) — the sole DM-sending path.
async function handleNewGuild(guild) {
  if (!cache[guild.id]) await upsertBareGuildDoc(guild.id);

  try {
    const owner = await guild.fetchOwner();
    await owner.send({ embeds: [buildWelcomeDmEmbed(guild.name)] });
  } catch (err) {
    console.error(`Failed to DM welcome message to owner of guild ${guild.id}:`, err.message);
  }
}

function getGuildConfig(guildId) {
  return cache[guildId] ?? emptyConfig();
}

function getChannelId(guildId, key) {
  return cache[guildId]?.channelIds?.[key] ?? null;
}

function getRoleId(guildId, key) {
  return cache[guildId]?.roleIds?.[key] ?? null;
}

function getCategoryId(guildId, key) {
  return cache[guildId]?.categoryIds?.[key] ?? null;
}

// Forum tag ID for a region (matchmaker-setup.js's ensureTournamentForum — key is 'EU'/'NAC'/'ME',
// same keys categoryIds used to use). null until the tournament forum's tags have been created —
// channel-manager.js's createTournamentChannel treats that as "post untagged" rather than failing.
function getTagId(guildId, key) {
  return cache[guildId]?.tagIds?.[key] ?? null;
}

function getCreativeChannelInfo(guildId, category) {
  return cache[guildId]?.creativeChannels?.[category] ?? null;
}

// Deep-merges partial.{channelIds,roleIds,categoryIds,creativeChannels,setupMessageIds,secrets}
// into the cache, then persists just those fields to Mongo. Object.assign (shallow per top-level
// map key) is sufficient here since every map is flat (id/token values, no nested objects) except
// creativeChannels (one level of {channelId,messageId} per category) — merged per-category below.
async function setGuildConfig(guildId, partial) {
  const current = cache[guildId] ?? emptyConfig();

  const merged = {
    channelIds: { ...current.channelIds, ...partial.channelIds },
    roleIds: { ...current.roleIds, ...partial.roleIds },
    categoryIds: { ...current.categoryIds, ...partial.categoryIds },
    tagIds: { ...current.tagIds, ...partial.tagIds },
    creativeChannels: {
      ...current.creativeChannels,
      ...Object.fromEntries(
        Object.entries(partial.creativeChannels ?? {}).map(([category, info]) => [
          category,
          { ...current.creativeChannels?.[category], ...info },
        ])
      ),
    },
    setupMessageIds: { ...current.setupMessageIds, ...partial.setupMessageIds },
    secrets: { ...current.secrets, ...partial.secrets },
  };

  cache[guildId] = merged;
  await GuildModel.updateOne(
    { guildId },
    { $set: merged, $setOnInsert: { guildId, createdAt: new Date() } },
    { upsert: true }
  );
  return merged;
}

// Removes keys entirely (not just overwrites with a new value) — setGuildConfig's merge can only
// ever ADD/overwrite a key in one of the flat maps, never remove one (`{...current, ...partial}`
// keeps whatever `current` already had for any key `partial` doesn't mention), so a genuine
// deletion (e.g. GUILD_CONFIG_MIGRATIONS' howto-channel-removal migration below, clearing a stale
// channelId after actually deleting the Discord channel) needs its own path: a real Mongo $unset,
// not a $set. `keysByMap` is `{ channelIds: ['howto'], setupMessageIds: ['howto'] }` shaped — one
// array of keys to drop per top-level map.
async function deleteConfigKeys(guildId, keysByMap) {
  const current = cache[guildId] ?? emptyConfig();
  const unsetDoc = {};

  for (const [mapName, keys] of Object.entries(keysByMap)) {
    const map = { ...current[mapName] };
    for (const key of keys) {
      delete map[key];
      unsetDoc[`${mapName}.${key}`] = '';
    }
    current[mapName] = map;
  }

  cache[guildId] = current;
  await GuildModel.updateOne({ guildId }, { $unset: unsetDoc });
  return current;
}

module.exports = {
  init,
  handleNewGuild,
  upsertBareGuildDoc,
  seedLegacyGuildFromEnv,
  getGuildConfig,
  getChannelId,
  getRoleId,
  getCategoryId,
  getTagId,
  getCreativeChannelInfo,
  setGuildConfig,
  // Exported for testing (same precedent as matchmaker-setup.js's TOURNAMENT_FORUM_SPECS/
  // channel-manager.js's deleteManagedChannel) — runs every self-heal migration against every
  // guild the given client is currently in, without needing to go through the full init()
  // startup path (seedLegacyGuildFromEnv, etc.) that isn't what these tests are about.
  runGuildConfigMigrations,
};
