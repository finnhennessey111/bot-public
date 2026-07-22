// store.js - Persists pinnedMessages, matchmaking queue data, parties, and matchChannels to
// MongoDB, scoped per guild — except the matchmaking queue pool itself, which is shared globally
// across every installed guild (cross-server matchmaking). Falls back to a local data.json file
// if MongoDB isn't configured or fails to connect — call init(client) once at startup.
//
// In-memory shapes:
//   pinnedMessages: flat, keyed by channelId (channel IDs are globally unique) — each record
//     carries its own `guildId` field.
//   queues / creativeQueues: flat, keyed [tournamentName-or-mode][region] -> array of units — no
//     guildId nesting; every installed guild's players share one pool. Each unit/player still
//     carries its own guildId for channel routing (queue.js/creative-queue.js/
//     creative-team-queue.js), just not as a partition key here.
//   parties: flat, keyed by partyId (globally unique) — each record carries its own `guildId`
//     (parties are still same-server; cross-server matching only pools already-built units).
//   matchChannels: flat, keyed by groupId (one match's whole channel cluster, possibly spanning
//     several guilds for a cross-server match) — each record carries a `channels` array of
//     {guildId, textChannelId, voiceChannelId}.
//
// creativeChannels/settings (per-guild config, not queue/match data) live in guild-config.js /
// models/Guild.js, not here.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const GuildModel = require('./models/Guild');
const QueueModel = require('./models/Queue');
const PartyModel = require('./models/Party');
const MatchChannelModel = require('./models/MatchChannel');

const DATA_FILE = path.join(__dirname, 'data.json');

// The queue pool has no per-guild ownership anymore — one shared document, keyed by this
// constant rather than a real guild ID.
const GLOBAL_QUEUE_KEY = '__global__';

// One-time migration for a data.json written before the multi-guild rework: pinnedMessages
// records had no `guildId`, and queues/creativeQueues had no `[guildId]` outer nesting (they
// were flat `{tournamentName: {region: [...]}}`, exactly the shape we're moving back to now —
// so a genuinely legacy single-guild file needs no queues/creativeQueues change at all here,
// just the pinnedMessages backfill).
function migratePinnedMessagesShape(pinnedMessages) {
  const legacyGuildId = process.env.GUILD_ID ?? null;
  const migrated = {};
  for (const [channelId, record] of Object.entries(pinnedMessages)) {
    migrated[channelId] = record.guildId ? record : { ...record, guildId: legacyGuildId };
  }
  return migrated;
}

// Un-does the per-guild-nesting rework: if queues/creativeQueues in data.json still have the
// `{guildId: {tournamentName: {region: [...]}}}` shape from the per-guild era, flatten it back
// into one global pool, concatenating unit arrays where two guilds happened to have units
// waiting for the same tournament+region (or mode+region) at once. A no-op once data.json has
// been saved at least once under the new flat shape.
function flattenAcrossGuilds(queues) {
  const looksGuildNested = Object.keys(queues).every(key => /^\d{15,25}$/.test(key));
  if (!looksGuildNested) return queues; // already flat (or empty)

  const flat = {};
  for (const guildId of Object.keys(queues)) {
    for (const outerKey of Object.keys(queues[guildId])) {
      if (!flat[outerKey]) flat[outerKey] = {};
      for (const region of Object.keys(queues[guildId][outerKey])) {
        const existing = flat[outerKey][region] ?? [];
        flat[outerKey][region] = [...existing, ...(queues[guildId][outerKey][region] ?? [])];
      }
    }
  }
  return flat;
}

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pinnedMessages: migratePinnedMessagesShape(parsed.pinnedMessages ?? {}),
      queues: flattenAcrossGuilds(parsed.queues ?? {}),
      parties: parsed.parties ?? {}, // already guildId-per-record, no shape change needed
      creativeQueues: flattenAcrossGuilds(parsed.creativeQueues ?? {}),
      matchChannels: parsed.matchChannels ?? {}, // migrated to groupId-keyed on first save
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

function mergeQueueBlobs(a, b) {
  const merged = { ...a };
  for (const outerKey of Object.keys(b)) {
    merged[outerKey] = { ...merged[outerKey] };
    for (const region of Object.keys(b[outerKey])) {
      merged[outerKey][region] = [...(merged[outerKey][region] ?? []), ...(b[outerKey][region] ?? [])];
    }
  }
  return merged;
}

// One-time migration for a live deployment that still has one QueueModel doc per real guildId
// (the per-guild-partitioned era) and no '__global__' doc yet: merges every existing guild's
// `data`/`creativeData` together into the new global doc, concatenating unit arrays on overlap.
// The old per-guild docs are left in place untouched (not deleted) — harmless once nothing reads
// them, and recoverable if this migration ever needs to be re-run or audited.
async function migrateLegacyPerGuildQueueDocs() {
  const legacyDocs = await QueueModel.find({ guildId: { $ne: GLOBAL_QUEUE_KEY } }).lean();
  if (legacyDocs.length === 0) return { data: {}, creativeData: {} };

  let data = {};
  let creativeData = {};
  for (const doc of legacyDocs) {
    data = mergeQueueBlobs(data, doc.data ?? {});
    creativeData = mergeQueueBlobs(creativeData, doc.creativeData ?? {});
  }

  console.log(`[Store] Migrated ${legacyDocs.length} per-guild queue doc(s) into the new global queue pool.`);
  return { data, creativeData };
}

// Hydrates every known guild's pinnedMessages/parties/matchChannels from Mongo, plus the one
// global queue doc, into the shared in-memory objects, replacing whatever data.json had loaded.
// Any guild present in the JSON-loaded state with no Mongo doc yet gets seeded INTO Mongo first
// (mirrors the original single-guild firstRun migration, generalized to however many guilds
// data.json happens to hold).
async function hydrateFromMongoAll() {
  const existingGuildIds = new Set((await GuildModel.find({}, 'guildId').lean()).map(d => d.guildId));

  const jsonGuildIds = new Set([
    ...Object.values(state.pinnedMessages).map(r => r.guildId).filter(Boolean),
    ...Object.values(state.parties).map(r => r.guildId).filter(Boolean),
    ...(state.matchChannels ? Object.values(state.matchChannels).flatMap(r => (r.channels ?? []).map(c => c.guildId)) : []),
  ]);

  for (const guildId of jsonGuildIds) {
    if (!existingGuildIds.has(guildId)) {
      await persistGuildScopedData(guildId);
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

  let globalQueueDoc = await QueueModel.findOne({ guildId: GLOBAL_QUEUE_KEY }).lean();
  if (!globalQueueDoc) {
    const migrated = await migrateLegacyPerGuildQueueDocs();
    await QueueModel.updateOne(
      { guildId: GLOBAL_QUEUE_KEY },
      { $set: migrated },
      { upsert: true }
    );
    globalQueueDoc = migrated;
  }
  replaceContents(state.queues, globalQueueDoc.data ?? {});
  replaceContents(state.creativeQueues, globalQueueDoc.creativeData ?? {});

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
  for (const c of channelDocs) matchChannels[c.groupId] = c.data;
  replaceContents(state.matchChannels, matchChannels);
}

// Full reconcile of a keyed store field (parties, matchChannels), scoped to one guild's entries:
// upserts every current entry, then deletes any doc for this guild no longer present in-memory.
async function syncCollection(Model, keyField, scopeField, guildId, entries, toDoc) {
  const keys = Object.keys(entries);
  await Promise.all(
    keys.map(key =>
      Model.updateOne({ [keyField]: key }, { $set: toDoc(key, entries[key]) }, { upsert: true })
    )
  );
  await Model.deleteMany({ [scopeField]: guildId, [keyField]: { $nin: keys } });
}

// Persists just this guild's slice of pinnedMessages/parties (matchChannels handled separately
// below, since a group can span multiple guilds and isn't cleanly "this guild's slice").
async function persistGuildScopedData(guildId) {
  const guildPinnedMessages = filterByGuild(state.pinnedMessages, guildId);

  await GuildModel.updateOne(
    { guildId },
    { $set: { pinnedMessages: guildPinnedMessages }, $setOnInsert: { guildId, createdAt: new Date() } },
    { upsert: true }
  );

  await syncCollection(PartyModel, 'partyId', 'guildId', guildId, filterByGuild(state.parties, guildId), (partyId, p) => ({
    partyId,
    guildId,
    leaderId: p.leaderId,
    leaderUsername: p.leaderUsername,
    members: p.members,
    channelId: p.channelId,
    createdAt: p.createdAt,
  }));
}

// The global queue pool has no single "owning" guild, so it's persisted independently of any one
// guild's save() call, keyed by the constant GLOBAL_QUEUE_KEY.
async function persistGlobalQueue() {
  await QueueModel.updateOne(
    { guildId: GLOBAL_QUEUE_KEY },
    { $set: { data: state.queues, creativeData: state.creativeQueues } },
    { upsert: true }
  );
}

// matchChannels groups can span multiple guilds — reconcile scoped to whichever guildIds this
// particular save() call cares about isn't meaningful, so this always does a full reconcile
// against every currently-known guild rather than filtering by one.
async function persistMatchChannels() {
  const keys = Object.keys(state.matchChannels);
  await Promise.all(
    keys.map(groupId => MatchChannelModel.updateOne(
      { groupId },
      {
        $set: {
          groupId,
          guildIds: (state.matchChannels[groupId].channels ?? []).map(c => c.guildId),
          data: state.matchChannels[groupId],
        },
      },
      { upsert: true }
    ))
  );
  await MatchChannelModel.deleteMany({ groupId: { $nin: keys } });
}

// Every mutation site already knows which guild it's acting on (a Discord interaction always
// carries one) — save(guildId) persists that guild's pinnedMessages/parties slice, plus the
// (guild-agnostic) global queue pool and matchChannels every time, since either can change
// as a side effect of any guild's activity.
function save(guildId) {
  saveJson();
  if (!mongoReady) return;

  if (guildId) {
    persistGuildScopedData(guildId).catch(err => console.error(`[MongoDB] Failed to persist guild ${guildId}:`, err.message));
  }
  persistGlobalQueue().catch(err => console.error('[MongoDB] Failed to persist global queue:', err.message));
  persistMatchChannels().catch(err => console.error('[MongoDB] Failed to persist match channels:', err.message));
}

// Attempts the MongoDB connection and, if successful, hydrates every known guild's
// pinnedMessages/parties/matchChannels plus the global queue pool from it (every Guild doc that
// exists, not just guilds the bot is currently in — no client needed here). Call once at startup,
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
    console.log('[Store] Using MongoDB for persistence (pinnedMessages, global queue pool, creativeQueues, parties, matchChannels).');
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
