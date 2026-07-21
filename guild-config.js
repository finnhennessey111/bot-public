// guild-config.js - In-memory cache of per-guild configuration (role/channel/category IDs,
// creative-channel routing, setup-message tracking, and secrets like a per-guild Yunite token),
// backed by models/Guild.js. Mongo-only — there's no meaningful offline/JSON equivalent for
// guild config, unlike store.js's queue/party/match data.
//
// Two "ensure a Guild doc exists" paths exist and must never both fire a DM:
//   - init(client): startup reconciliation for every already-joined guild — no DM.
//   - handleNewGuild(guild): the guildCreate event — DMs the owner, this is the only DM path.

const GuildModel = require('./models/Guild');
const { buildWelcomeDmEmbed } = require('./embeds');

const cache = {}; // { [guildId]: { channelIds, roleIds, categoryIds, creativeChannels, setupMessageIds, secrets } }

function emptyConfig() {
  return { channelIds: {}, roleIds: {}, categoryIds: {}, creativeChannels: {}, setupMessageIds: {}, secrets: {} };
}

function toCacheEntry(doc) {
  return {
    channelIds: doc.channelIds ?? {},
    roleIds: doc.roleIds ?? {},
    categoryIds: doc.categoryIds ?? {},
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
    ...(process.env.FORM_PARTY_CHANNEL_ID && { formParty: process.env.FORM_PARTY_CHANNEL_ID }),
  };

  // YUNITE_TOKEN is deliberately NOT copied into secrets here — it stays available as the
  // process.env fallback used by getYuniteToken() rather than being duplicated into Mongo.
  await setGuildConfig(guildId, { roleIds, categoryIds, channelIds });
  console.log(`[GuildConfig] Seeded legacy guild ${guildId} config from environment variables.`);
}

// Startup reconciliation: hydrate every known Guild doc, then make sure every guild the bot is
// currently in (including ones joined while the bot was offline) has at least a bare doc — no
// DM here, that's handleNewGuild's job exclusively.
async function init(client) {
  const docs = await GuildModel.find({}).lean();
  for (const doc of docs) cache[doc.guildId] = toCacheEntry(doc);

  for (const guild of client.guilds.cache.values()) {
    if (!cache[guild.id]) await upsertBareGuildDoc(guild.id);
  }

  await seedLegacyGuildFromEnv();
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

function getCreativeChannelInfo(guildId, category) {
  return cache[guildId]?.creativeChannels?.[category] ?? null;
}

function getYuniteToken(guildId) {
  return cache[guildId]?.secrets?.yuniteToken ?? null;
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

module.exports = {
  init,
  handleNewGuild,
  upsertBareGuildDoc,
  seedLegacyGuildFromEnv,
  getGuildConfig,
  getChannelId,
  getRoleId,
  getCategoryId,
  getCreativeChannelInfo,
  getYuniteToken,
  setGuildConfig,
};
