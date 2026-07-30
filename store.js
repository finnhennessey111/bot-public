// store.js - Persists pinnedMessages, matchmaking queue data, and matchChannels to MongoDB,
// scoped per guild — except the matchmaking queue pool itself, which is shared globally across
// every installed guild (cross-server matchmaking). Falls back to a local data.json file if
// MongoDB isn't configured or fails to connect — call init(client) once at startup.
//
// In-memory shapes:
//   pinnedMessages: flat, keyed by channelId (channel IDs are globally unique) — each record
//     carries its own `guildId` field.
//   queues / creativeQueues: flat, keyed [tournamentName-or-mode][region] -> array of units — no
//     guildId nesting; every installed guild's players share one pool. Each unit/player still
//     carries its own guildId for channel routing (queue.js/creative-queue.js/
//     creative-team-queue.js), just not as a partition key here.
//   matchChannels: flat, keyed by groupId (one match's whole channel cluster, possibly spanning
//     several guilds for a cross-server match) — each record carries a `channels` array of
//     {guildId, textChannelId, voiceChannelId}.
//   pendingMatches: flat, keyed by matchId — a plain, JSON-safe snapshot of a match still awaiting
//     accept/reject (matching.js's own in-memory pendingMatches holds the richer live shape, with
//     a Set/Map/live requeueFn callback; only matching.js's toPersistableRecord() output ever
//     lands here). Exists so an in-flight accept/reject window survives a restart instead of
//     silently vanishing — match-channels.js creates the private channel the moment a match is
//     found, well before channel-lifecycle.js's matchChannels would otherwise ever know about it
//     (that only happens once everyone accepts), so without this a mid-restart restart leaves a
//     channel with no durable record anywhere at all.
//
// creativeChannels/settings (per-guild config, not queue/match data) live in guild-config.js /
// models/Guild.js, not here.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const GuildModel = require('./models/Guild');
const QueueModel = require('./models/Queue');
const MatchChannelModel = require('./models/MatchChannel');
const PendingMatchModel = require('./models/PendingMatch');

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
      creativeQueues: flattenAcrossGuilds(parsed.creativeQueues ?? {}),
      matchChannels: parsed.matchChannels ?? {}, // migrated to groupId-keyed on first save
      pendingMatches: parsed.pendingMatches ?? {},
    };
  } catch (err) {
    return {
      pinnedMessages: {},
      queues: {},
      creativeQueues: {},
      matchChannels: {},
      pendingMatches: {},
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
      creativeQueues: state.creativeQueues,
      matchChannels: state.matchChannels,
      pendingMatches: state.pendingMatches,
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

// Hydrates every known guild's pinnedMessages/matchChannels from Mongo, plus the one global
// queue doc, into the shared in-memory objects, replacing whatever data.json had loaded. Any
// guild present in the JSON-loaded state with no Mongo doc yet gets seeded INTO Mongo first
// (mirrors the original single-guild firstRun migration, generalized to however many guilds
// data.json happens to hold).
async function hydrateFromMongoAll() {
  const existingGuildIds = new Set((await GuildModel.find({}, 'guildId').lean()).map(d => d.guildId));

  const jsonGuildIds = new Set([
    ...Object.values(state.pinnedMessages).map(r => r.guildId).filter(Boolean),
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

  const channelDocs = await MatchChannelModel.find({}).lean();
  const matchChannels = {};
  for (const c of channelDocs) matchChannels[c.groupId] = c.data;
  replaceContents(state.matchChannels, matchChannels);

  const pendingMatchDocs = await PendingMatchModel.find({}).lean();
  const pendingMatches = {};
  for (const m of pendingMatchDocs) pendingMatches[m.matchId] = m.data;
  replaceContents(state.pendingMatches, pendingMatches);
}

// Persists just this guild's slice of pinnedMessages (matchChannels handled separately below,
// since a group can span multiple guilds and isn't cleanly "this guild's slice").
async function persistGuildScopedData(guildId) {
  const guildPinnedMessages = filterByGuild(state.pinnedMessages, guildId);

  await GuildModel.updateOne(
    { guildId },
    { $set: { pinnedMessages: guildPinnedMessages }, $setOnInsert: { guildId, createdAt: new Date() } },
    { upsert: true }
  );
}

// The global queue pool has no single "owning" guild — one shared document, keyed by the constant
// GLOBAL_QUEUE_KEY, holding both `data` (queues) and `creativeData` (creativeQueues) together
// (see models/Queue.js: "kept as a single Mixed blob rather than normalized documents since the
// shape is still evolving"). A join/leave/match only ever changes a few units within one
// tournament+region band, but this doc is the smallest unit Mongo can address here without a
// schema change, so persisting it still means writing the current whole blob — the fix below is
// that a queue mutation now touches ONLY this one document, not pinnedMessages or matchChannels
// too.
async function persistGlobalQueue() {
  await QueueModel.updateOne(
    { guildId: GLOBAL_QUEUE_KEY },
    { $set: { data: state.queues, creativeData: state.creativeQueues } },
    { upsert: true }
  );
}

// Exactly one match-channel group (models/MatchChannel.js: one document per groupId) — upserts
// just that document. Previously this re-upserted EVERY currently-active group on every call
// (plus ran a deleteMany reconcile scan every time too — see persistMatchChannelDelete below),
// scaling the cost of e.g. one match's warning timer firing with the total number of active
// matches across the whole bot, not with the one group that actually changed.
async function persistMatchChannelUpsert(groupId) {
  const record = state.matchChannels[groupId];
  if (!record) return; // deleted again before this async write ran — nothing to upsert
  await MatchChannelModel.updateOne(
    { groupId },
    { $set: { groupId, guildIds: (record.channels ?? []).map(c => c.guildId), data: record } },
    { upsert: true }
  );
}

// Deletes exactly one match-channel group's document by groupId — a targeted deleteOne, not the
// deleteMany({ $nin: currentKeys }) full-collection reconcile scan this replaced (that scan re-read
// intent from "what's missing from in-memory state" instead of "what was just deleted", which is
// why it had to run against the whole collection on every single call regardless of what changed).
async function persistMatchChannelDelete(groupId) {
  await MatchChannelModel.deleteOne({ groupId });
}

// Exactly one pending match (models/PendingMatch.js: one document per matchId) — upserts just
// that document, same shape/reasoning as persistMatchChannelUpsert above.
async function persistPendingMatchUpsert(matchId) {
  const record = state.pendingMatches[matchId];
  if (!record) return; // deleted again before this async write ran — nothing to upsert
  await PendingMatchModel.updateOne(
    { matchId },
    { $set: { matchId, data: record } },
    { upsert: true }
  );
}

// Deletes exactly one pending match's document by matchId — called once it's no longer pending
// (accepted by everyone, rejected, or expired).
async function persistPendingMatchDelete(matchId) {
  await PendingMatchModel.deleteOne({ matchId });
}

// Every mutation site below already knows exactly which single collection/document it just
// touched (a queue join only ever changes the queue pool; a pinned-message update only ever
// changes that one guild's slice; a match-channel group's warn/cancel/delete only ever changes
// that one group) — each save*() function below persists only that, never a blanket resync of
// state nothing here actually changed. The (comparatively expensive) synchronous full-state JSON
// write is the genuine fallback for when MongoDB isn't the backend of record at all — see
// `mongoReady` above — not a write-through cache kept warm alongside a healthy Mongo on every
// single mutation regardless of backend health.

// Called by every mutation site that changed pinnedMessages for exactly this guildId.
function savePinnedMessages(guildId) {
  if (!mongoReady) return saveJson();
  persistGuildScopedData(guildId).catch(err => console.error(`[MongoDB] Failed to persist guild ${guildId}:`, err.message));
}

// Called by every mutation site that changed the shared queues/creativeQueues pool (join, leave,
// match, requeue, /clear-queue) — both live in one shared global document (see
// persistGlobalQueue's comment above), so there's no finer-grained Mongo target to persist to.
function saveQueues() {
  if (!mongoReady) return saveJson();
  persistGlobalQueue().catch(err => console.error('[MongoDB] Failed to persist global queue:', err.message));
}

// Called by every mutation site that created or updated one matchChannels group (schedule a
// deletion, mark it warned) — never the whole matchChannels collection.
function saveMatchChannel(groupId) {
  if (!mongoReady) return saveJson();
  persistMatchChannelUpsert(groupId).catch(err => console.error(`[MongoDB] Failed to persist match channel group ${groupId}:`, err.message));
}

// Called by every mutation site that removed one matchChannels group (cancelled or auto-deleted)
// — never a full-collection reconcile scan.
function deleteMatchChannel(groupId) {
  if (!mongoReady) return saveJson();
  persistMatchChannelDelete(groupId).catch(err => console.error(`[MongoDB] Failed to delete match channel group ${groupId}:`, err.message));
}

// Called by matching.js every time a pending match's persistable snapshot changes (created,
// channels attached, a partial accept) — never a blanket resync of every pending match.
function savePendingMatch(matchId) {
  if (!mongoReady) return saveJson();
  persistPendingMatchUpsert(matchId).catch(err => console.error(`[MongoDB] Failed to persist pending match ${matchId}:`, err.message));
}

// Called by matching.js once a match stops being pending (confirmed, rejected, or expired).
function deletePendingMatch(matchId) {
  if (!mongoReady) return saveJson();
  persistPendingMatchDelete(matchId).catch(err => console.error(`[MongoDB] Failed to delete pending match ${matchId}:`, err.message));
}

// Attempts the MongoDB connection and, if successful, hydrates every known guild's
// pinnedMessages/matchChannels plus the global queue pool from it (every Guild doc that exists,
// not just guilds the bot is currently in — no client needed here). Call once at startup, before
// the bot starts handling events. Safe to call even without MONGODB_URI set — falls back to the
// JSON store (already loaded into `state` at module load).
async function init() {
  const connected = await db.connect();

  if (!connected) {
    console.log('[Store] MongoDB unavailable — using local JSON file (data.json) for persistence.');
    return;
  }

  try {
    await hydrateFromMongoAll();
    mongoReady = true;
    console.log('[Store] Using MongoDB for persistence (pinnedMessages, global queue pool, creativeQueues, matchChannels, pendingMatches).');
  } catch (err) {
    mongoReady = false;
    console.error('[Store] Failed to hydrate from MongoDB — using local JSON file (data.json) for persistence:', err.message);
  }
}

// Test-only escape hatch — flips the mongoReady flag without requiring a real MongoDB connection,
// so a test can exercise the Mongo-selective-persistence branch (savePinnedMessages/saveQueues/
// saveMatchChannel/deleteMatchChannel calling their real persistX functions, which hit the
// Mongoose Model methods directly) without standing up a real database. Never called from
// production code — init() (the real path) is the only other place mongoReady is ever set.
function __setMongoReadyForTesting(value) {
  mongoReady = value;
}

module.exports = {
  pinnedMessages: state.pinnedMessages,
  queues: state.queues,
  creativeQueues: state.creativeQueues,
  matchChannels: state.matchChannels,
  pendingMatches: state.pendingMatches,
  savePinnedMessages,
  saveQueues,
  saveMatchChannel,
  deleteMatchChannel,
  savePendingMatch,
  deletePendingMatch,
  init,
  __setMongoReadyForTesting,
};
