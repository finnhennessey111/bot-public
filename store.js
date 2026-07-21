// store.js - Persists pinnedMessages, queue data, parties, and matchChannels to MongoDB when
// available (see db.js), scoped by the bot's GUILD_ID. If MongoDB isn't configured or fails to
// connect, falls back to the local data.json file exactly as before — call init() once at
// startup to attempt the MongoDB connection and hydrate these fields from it.
//
// creativeQueues/creativeChannels/settings are unaffected by this and remain JSON-only.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const GuildModel = require('./models/Guild');
const QueueModel = require('./models/Queue');
const PartyModel = require('./models/Party');
const MatchChannelModel = require('./models/MatchChannel');

const DATA_FILE = path.join(__dirname, 'data.json');

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pinnedMessages: parsed.pinnedMessages ?? {},
      queues: parsed.queues ?? {},
      parties: parsed.parties ?? {},
      creativeQueues: parsed.creativeQueues ?? {},
      creativeChannels: parsed.creativeChannels ?? {
        '1v1': { messageId: null },
        '2v2': { messageId: null },
      },
      matchChannels: parsed.matchChannels ?? {},
      settings: parsed.settings ?? { matchCategoryId: null },
    };
  } catch (err) {
    return {
      pinnedMessages: {},
      queues: {},
      parties: {},
      creativeQueues: {},
      creativeChannels: {
        '1v1': { messageId: null },
        '2v2': { messageId: null },
      },
      matchChannels: {},
      settings: { matchCategoryId: null },
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
      creativeChannels: state.creativeChannels,
      matchChannels: state.matchChannels,
      settings: state.settings,
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

// True the very first time a given guild connects to MongoDB (no Guild doc yet) — in that case
// state.pinnedMessages/queues/parties/matchChannels (already populated from data.json at module
// load) are the ones migrating IN to Mongo, so hydration must not clobber them with an empty
// collection. Once the Guild doc exists, Mongo is the source of truth and hydration overwrites
// in-memory state from it as normal.
async function hydrateFromMongo(guildId) {
  const guildDoc = await GuildModel.findOne({ guildId }).lean();
  if (!guildDoc) return { firstRun: true };

  replaceContents(state.pinnedMessages, guildDoc.pinnedMessages ?? {});

  const queueDoc = await QueueModel.findOne({ guildId }).lean();
  replaceContents(state.queues, queueDoc?.data ?? {});

  const partyDocs = await PartyModel.find({ guildId }).lean();
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

  const channelDocs = await MatchChannelModel.find({ guildId }).lean();
  const matchChannels = {};
  for (const c of channelDocs) matchChannels[c.textChannelId] = c.data;
  replaceContents(state.matchChannels, matchChannels);

  return { firstRun: false };
}

// Full reconcile of a keyed store field (parties, matchChannels) against its Mongo collection:
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
  await GuildModel.updateOne(
    { guildId },
    { $set: { pinnedMessages: state.pinnedMessages }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );

  await QueueModel.updateOne(
    { guildId },
    { $set: { data: state.queues } },
    { upsert: true }
  );

  await syncCollection(PartyModel, 'partyId', guildId, state.parties, (partyId, p) => ({
    partyId,
    guildId: p.guildId || guildId,
    leaderId: p.leaderId,
    leaderUsername: p.leaderUsername,
    members: p.members,
    channelId: p.channelId,
    createdAt: p.createdAt,
  }));

  await syncCollection(MatchChannelModel, 'textChannelId', guildId, state.matchChannels, (textChannelId, rec) => ({
    textChannelId,
    guildId: rec.guildId || guildId,
    data: rec,
  }));
}

function save() {
  saveJson();
  if (mongoReady) {
    const guildId = process.env.GUILD_ID;
    persistToMongo(guildId).catch(err => console.error('[MongoDB] Failed to persist state:', err.message));
  }
}

// Attempts the MongoDB connection and, if successful, hydrates pinnedMessages/queues/parties/
// matchChannels from it. Call once at startup, before the bot starts handling events, so those
// fields reflect Mongo's state (not just whatever data.json happened to have on disk) from the
// first read onward. Safe to call even without MONGODB_URI set — falls back to the JSON store.
async function init() {
  const guildId = process.env.GUILD_ID;
  const connected = await db.connect();

  if (!connected) {
    console.log('[Store] MongoDB unavailable — using local JSON file (data.json) for persistence.');
    return;
  }

  if (!guildId) {
    console.warn('[Store] MongoDB connected but GUILD_ID is not set — using local JSON file (data.json) for persistence.');
    return;
  }

  try {
    const { firstRun } = await hydrateFromMongo(guildId);
    mongoReady = true;
    if (firstRun) {
      // No Guild doc for this guild yet — migrate the current data.json-loaded state into
      // MongoDB now, so it becomes the source of truth from this point on.
      await persistToMongo(guildId);
      console.log('[Store] No existing MongoDB data for this guild — migrated data.json into MongoDB.');
    }
    console.log('[Store] Using MongoDB for persistence (pinnedMessages, queues, parties, matchChannels).');
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
  creativeChannels: state.creativeChannels,
  matchChannels: state.matchChannels,
  settings: state.settings,
  save,
  init,
};
