// store.js - Persists pinnedMessages, tournament + creative queue data, parties, and
// matchChannels to MongoDB, scoped per guild. Falls back to a local data.json file if MongoDB
// isn't configured or fails to connect — call init(client) once at startup.
//
// In-memory shapes:
//   pinnedMessages: flat, keyed by channelId (channel IDs are globally unique) — each record
//     carries its own `guildId` field.
//   queues / creativeQueues: keyed [guildId][tournamentName-or-mode][region] -> array of units.
//   parties / matchChannels: flat, keyed by partyId / textChannelId (globally unique) — each
//     record already carries its own `guildId` field.
//
// creativeChannels/settings (per-guild config, not queue/match data) moved to guild-config.js /
// models/Guild.js as part of the multi-guild rework — they're no longer store.js's concern.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const GuildModel = require('./models/Guild');
const QueueModel = require('./models/Queue');
const PartyModel = require('./models/Party');
const MatchChannelModel = require('./models/MatchChannel');

const DATA_FILE = path.join(__dirname, 'data.json');

// One-time migration for a data.json written before the multi-guild rework: pinnedMessages
// records had no `guildId`, and queues/creativeQueues had no `[guildId]` outer nesting (they
// were flat `{tournamentName: {region: [...]}}`). Both are folded under process.env.GUILD_ID
// (the bot's original single guild) here — a no-op once data.json has been saved at least once
// under the new shape (detected via a snowflake-shaped top-level key, or a `guildId` already
// present on each pinnedMessages record).
function migratePinnedMessagesShape(pinnedMessages) {
  const legacyGuildId = process.env.GUILD_ID ?? null;
  const migrated = {};
  for (const [channelId, record] of Object.entries(pinnedMessages)) {
    migrated[channelId] = record.guildId ? record : { ...record, guildId: legacyGuildId };
  }
  return migrated;
}

function migrateQueuesShape(queues) {
  if (!process.env.GUILD_ID) return queues; // nothing to key legacy data under
  const alreadyNamespaced = Object.keys(queues).every(key => /^\d{15,25}$/.test(key));
  if (alreadyNamespaced) return queues;
  return { [process.env.GUILD_ID]: queues };
}

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pinnedMessages: migratePinnedMessagesShape(parsed.pinnedMessages ?? {}),
      queues: migrateQueuesShape(parsed.queues ?? {}),
      parties: parsed.parties ?? {}, // already guildId-per-record, no shape change needed
      creativeQueues: migrateQueuesShape(parsed.creativeQueues ?? {}),
      matchChannels: parsed.matchChannels ?? {}, // already guildId-per-record
    };
  } catch (err) {
    return {
      pinnedMessages: {},
      queues: {},
      parties: {},
      creativeQueues: {},
      matchChannels: {},
    };
  }
}

const state = load();

function saveJson() {
  const tmpFile = `${DATA_FILE}.tmp`;
  const payload = JSON.stringify(
    {
      pinnedMessages: state.pinnedMessages,
      queues: state.queues,
      parties: state.parties,
      creativeQueues: state.creativeQueues,
      matchChannels: state.matchChannels,
    },
    null,
    2
  );
  fs.writeFileSync(tmpFile, payload);
  fs.renameSync(tmpFile, DATA_FILE);
}

let mongoReady = false;

// Mutates the existing object in place (rather than reassigning it) so references already
// destructured by other modules (e.g. `const { queues } = require('./store')`) stay live.
function replaceContents(target, next) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

function filterByGuild(entries, guildId) {
  return Object.fromEntries(Object.entries(entries).filter(([, record]) => record.guildId === guildId));
}

// Hydrates every known guild's data from Mongo into the shared in-memory objects, replacing
// whatever data.json had loaded. Any guild present in the JSON-loaded state with no Mongo doc
// yet gets seeded INTO Mongo first (mirrors the original single-guild firstRun migration,
// generalized to however many guilds data.json happens to hold — in practice just the legacy
// guild, or none at all on a fresh Mongo-backed deployment).
async function hydrateFromMongoAll() {
  const existingGuildIds = new Set((await GuildModel.find({}, 'guildId').lean()).map(d => d.guildId));

  const jsonGuildIds = new Set([
    ...Object.keys(state.queues),
    ...Object.keys(state.creativeQueues),
    ...Object.values(state.pinnedMessages).map(r => r.guildId).filter(Boolean),
    ...Object.values(state.parties).map(r => r.guildId).filter(Boolean),
    ...Object.values(state.matchChannels).map(r => r.guildId).filter(Boolean),
  ]);

  for (const guildId of jsonGuildIds) {
    if (!existingGuildIds.has(guildId)) {
      await persistToMongo(guildId);
      console.log(`[Store] No existing MongoDB data for guild ${guildId} — migrated data.json into MongoDB.`);
    }
  }

  const guildDocs = await GuildModel.find({}).lean();

  const pinnedMessages = {};
  for (const doc of guildDocs) {
    for (const [channelId, record] of Object.entries(doc.pinnedMessages ?? {})) {
      pinnedMessages[channelId] = { ...record, guildId: doc.guildId };
    }
  }
  replaceContents(state.pinnedMessages, pinnedMessages);

  const queueDocs = await QueueModel.find({}).lean();
  const queues = {};
  const creativeQueues = {};
  for (const doc of queueDocs) {
    queues[doc.guildId] = doc.data ?? {};
    creativeQueues[doc.guildId] = doc.creativeData ?? {};
  }
  replaceContents(state.queues, queues);
  replaceContents(state.creativeQueues, creativeQueues);

  const partyDocs = await PartyModel.find({}).lean();
  const parties = {};
  for (const p of partyDocs) {
    parties[p.partyId] = {
      partyId: p.partyId,
      leaderId: p.leaderId,
      leaderUsername: p.leaderUsername,
      members: p.members,
      channelId: p.channelId,
      guildId: p.guildId,
      createdAt: p.createdAt,
    };
  }
  replaceContents(state.parties, parties);

  const channelDocs = await MatchChannelModel.find({}).lean();
  const matchChannels = {};
  for (const c of channelDocs) matchChannels[c.textChannelId] = { ...c.data, guildId: c.guildId };
  replaceContents(state.matchChannels, matchChannels);
}

// Full reconcile of a keyed store field (parties, matchChannels), scoped to one guild's entries:
// upserts every current entry, then deletes any doc for this guild no longer present in-memory.
async function syncCollection(Model, keyField, guildId, entries, toDoc) {
  const keys = Object.keys(entries);
  await Promise.all(
    keys.map(key =>
      Model.updateOne({ [keyField]: key }, { $set: toDoc(key, entries[key]) }, { upsert: true })
    )
  );
  await Model.deleteMany({ guildId, [keyField]: { $nin: keys } });
}

async function persistToMongo(guildId) {
  const guildPinnedMessages = filterByGuild(state.pinnedMessages, guildId);

  await GuildModel.updateOne(
    { guildId },
    { $set: { pinnedMessages: guildPinnedMessages }, $setOnInsert: { guildId, createdAt: new Date() } },
    { upsert: true }
  );

  await QueueModel.updateOne(
    { guildId },
    { $set: { data: state.queues[guildId] ?? {}, creativeData: state.creativeQueues[guildId] ?? {} } },
    { upsert: true }
  );

  await syncCollection(PartyModel, 'partyId', guildId, filterByGuild(state.parties, guildId), (partyId, p) => ({
    partyId,
    guildId,
    leaderId: p.leaderId,
    leaderUsername: p.leaderUsername,
    members: p.members,
    channelId: p.channelId,
    createdAt: p.createdAt,
  }));

  await syncCollection(MatchChannelModel, 'textChannelId', guildId, filterByGuild(state.matchChannels, guildId), (textChannelId, rec) => ({
    textChannelId,
    guildId,
    data: rec,
  }));
}

// Every mutation site already knows which guild it's acting on (a Discord interaction always
// carries one) — save(guildId) persists just that guild's slice rather than everything, so two
// guilds' concurrent activity never contends on an unrelated write.
function save(guildId) {
  saveJson();
  if (mongoReady && guildId) {
    persistToMongo(guildId).catch(err => console.error(`[MongoDB] Failed to persist guild ${guildId}:`, err.message));
  }
}

// Attempts the MongoDB connection and, if successful, hydrates every known guild's
// pinnedMessages/queues/creativeQueues/parties/matchChannels from it. Call once at startup,
// before the bot starts handling events. Safe to call even without MONGODB_URI set — falls back
// to the JSON store (already loaded into `state` at module load).
async function init() {
  const connected = await db.connect();

  if (!connected) {
    console.log('[Store] MongoDB unavailable — using local JSON file (data.json) for persistence.');
    return;
  }

  try {
    await hydrateFromMongoAll();
    mongoReady = true;
    console.log('[Store] Using MongoDB for persistence (pinnedMessages, queues, creativeQueues, parties, matchChannels).');
  } catch (err) {
    mongoReady = false;
    console.error('[Store] Failed to hydrate from MongoDB — using local JSON file (data.json) for persistence:', err.message);
  }
}

module.exports = {
  pinnedMessages: state.pinnedMessages,
  queues: state.queues,
  parties: state.parties,
  creativeQueues: state.creativeQueues,
  matchChannels: state.matchChannels,
  save,
  init,
};
