// Verifies channel-deletion-undo.js's full accidental-deletion flow: detecting an externally
// deleted, tracked tournament channel (vs. one this bot deleted itself), DMing whoever the audit
// log says deleted it with a 24h Restore window, recreating the channel exactly as it was on
// Restore, failing toward "stays deleted" when the deleter can't be identified or the window
// expires unactioned, and never letting one guild's deletion suppress recreation in another guild
// running the same real tournament (models/DeletedTournamentChannel.js's compound guildId+eventId
// key — the bug a naive eventId-only key would have reintroduced).
//
// Tournament posts are forum threads now (see channel-manager.js's createTournamentChannel):
// every fake "channel" here is thread-shaped (isThread() -> true, no parent category), and
// guild-config is stubbed (require-cache swap, done once for the whole file in test.before/after
// since every test needs the same fixed forum value) so createTournamentChannel has somewhere to
// post — one fake forum answers for all 9 region×build-mode keys (these tests are about the
// deletion-undo flow, not routing itself; test/tournament-channel-rename.test.js covers routing).
// handleChannelDelete's audit-log lookup now also depends on isThread() to pick
// AuditLogEvent.ThreadDelete vs .ChannelDelete — covered directly near the bottom of this file.
//
// Same "stub the Model with a small real in-memory collection, not the module" precedent as
// test/tournament-approval.test.js — the actual production channel-deletion-undo.js code runs
// unmodified against realistic query/update semantics, including the atomic
// status:'pending_confirmation' guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AuditLogEvent } = require('discord.js');

const DeletedTournamentChannelModel = require('../models/DeletedTournamentChannel');
const selfDeletionTracker = require('../self-deletion-tracker');
const store = require('../store');

const FORUM_ID = 'forum-1';

// channelManager/channelDeletionUndo are (re)required fresh inside test.before, AFTER the
// guild-config require-cache swap below — a plain top-level require() here would run before
// test.before ever fires, capturing the REAL (unstubbed) guild-config into their own module-level
// destructuring, too late for the stub to matter at all.
let channelManager;
let channelDeletionUndo;

const guildConfigPath = require.resolve('../guild-config');
const channelManagerPath = require.resolve('../channel-manager');
const channelDeletionUndoPath = require.resolve('../channel-deletion-undo');
let previousGuildConfig;

test.before(() => {
  previousGuildConfig = require.cache[guildConfigPath];
  delete require.cache[guildConfigPath];
  delete require.cache[channelManagerPath];
  delete require.cache[channelDeletionUndoPath];

  require.cache[guildConfigPath] = {
    id: guildConfigPath, filename: guildConfigPath, loaded: true,
    exports: {
      getChannelId: (g, k) => (k.startsWith('tournamentForum_') ? FORUM_ID : null),
      getRoleId: () => null,
    },
  };

  channelManager = require('../channel-manager');
  channelDeletionUndo = require('../channel-deletion-undo');
});

test.after(() => {
  delete require.cache[guildConfigPath];
  delete require.cache[channelManagerPath];
  delete require.cache[channelDeletionUndoPath];
  if (previousGuildConfig) require.cache[guildConfigPath] = previousGuildConfig;
});

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    const actual = getPath(doc, key);
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('$lte' in cond) return actual != null && actual <= cond.$lte;
    }
    return actual === cond;
  });
}

function applySet(doc, update) {
  if (update.$set) Object.assign(doc, update.$set);
}

let nextRecordId = 1;

function makeFakeCollection() {
  const docs = [];
  return {
    docs,
    findOne: (filter) => ({ lean: async () => docs.find(d => matchesFilter(d, filter)) ?? null }),
    find: (filter) => ({
      sort: () => ({ lean: async () => docs.filter(d => matchesFilter(d, filter)) }),
      lean: async () => docs.filter(d => matchesFilter(d, filter)),
    }),
    findOneAndUpdate: (filter, update, options) => ({
      lean: async () => {
        let doc = docs.find(d => matchesFilter(d, filter));
        if (!doc) {
          if (!options?.upsert) return null;
          doc = { _id: `rec-${nextRecordId++}`, guildId: filter.guildId, eventId: filter.eventId };
          docs.push(doc);
        }
        applySet(doc, update);
        return { ...doc };
      },
    }),
    updateOne: async (filter, update, options) => {
      const doc = docs.find(d => matchesFilter(d, filter));
      if (!doc) {
        if (options?.upsert) docs.push({ ...filter, ...(update.$set ?? {}) });
        return {};
      }
      applySet(doc, update);
      return {};
    },
  };
}

function withFakeModel(fn) {
  const fake = makeFakeCollection();
  const originals = {
    findOne: DeletedTournamentChannelModel.findOne,
    find: DeletedTournamentChannelModel.find,
    findOneAndUpdate: DeletedTournamentChannelModel.findOneAndUpdate,
    updateOne: DeletedTournamentChannelModel.updateOne,
  };
  Object.assign(DeletedTournamentChannelModel, fake);
  return Promise.resolve(fn(fake)).finally(() => Object.assign(DeletedTournamentChannelModel, originals));
}

// Thread-shaped — real ThreadChannel#isThread() reads a type field internally; this fake just
// hardcodes the answer, since that's the only part of it these tests actually depend on.
function makeFakeThread(id, name, parentId = FORUM_ID) {
  return {
    id, name, parentId,
    isThread: () => true,
    async setName(newName) { this.name = newName; return this; },
  };
}

// auditEntries: [{ targetId, executor, type }] — most-recent-first, same shape guild.fetchAuditLogs
// returns for real (GuildAuditLogsEntry.target/.executor). `type` lets a test simulate the real
// AuditLogEvent.ThreadDelete vs .ChannelDelete split — fetchAuditLogs below only returns entries
// matching the type it was actually called with, same as the real Discord API filtering server-side.
function makeFakeGuild(id, { auditEntries = [] } = {}) {
  const channelsById = new Map();
  let nextChanId = 5000;
  const createCalls = [];
  const fetchAuditLogCalls = [];

  const forum = {
    id: FORUM_ID,
    threads: {
      async create({ name, appliedTags }) {
        const thread = makeFakeThread(String(nextChanId++), name);
        thread.appliedTags = appliedTags ?? [];
        channelsById.set(thread.id, thread);
        createCalls.push(thread);
        return thread;
      },
    },
  };
  channelsById.set(FORUM_ID, forum);

  const guild = {
    id,
    roles: { everyone: `everyone-${id}` },
    client: { user: { id: 'bot-id' } },
    channels: {
      cache: { find: predicate => [...channelsById.values()].find(predicate) },
      fetch: async cid => channelsById.get(cid) ?? null,
    },
    fetchAuditLogs: async ({ type }) => {
      fetchAuditLogCalls.push(type);
      return { entries: auditEntries.filter(e => e.type === undefined || e.type === type).map(e => ({ target: { id: e.targetId }, executor: e.executor })) };
    },
  };

  return { guild, channelsById, createCalls, fetchAuditLogCalls };
}

function makeFakeClient(guildsById) {
  const sentDMs = [];
  const editedMessages = [];
  const dmMessagesByKey = {};
  let nextMsgId = 1;

  const client = {
    user: { id: 'bot-id' },
    users: {
      async fetch(discordId) {
        return {
          async send(payload) {
            const messageId = `dm-msg-${nextMsgId++}`;
            const channelId = `dm-chan-${discordId}`;
            sentDMs.push({ discordId, payload, messageId, channelId });
            dmMessagesByKey[`${channelId}:${messageId}`] = {
              id: messageId, channelId,
              async edit(p) { editedMessages.push({ channelId, messageId, payload: p }); },
            };
            return { id: messageId, channelId };
          },
        };
      },
    },
    channels: {
      async fetch(channelId) {
        return {
          messages: {
            async fetch(messageId) {
              const existing = dmMessagesByKey[`${channelId}:${messageId}`];
              if (existing) return existing;
              return { id: messageId, channelId, async edit(p) { editedMessages.push({ channelId, messageId, payload: p }); } };
            },
          },
        };
      },
    },
    guilds: {
      async fetch(guildId) { return guildsById[guildId] ?? null; },
    },
  };

  return { client, sentDMs, editedMessages };
}

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

function makePinnedEntry(overrides = {}) {
  return {
    guildId: 'guild-1',
    tournamentEventId: 'evt_abc',
    tournamentName: 'Test Cup',
    region: 'EU',
    isTrios: false,
    isRankedCup: false,
    consoleOnly: false,
    beginTime: futureIso(20),
    deleteAt: Date.now() + (20 * 3600_000) + 2 * 3600_000,
    permanent: false,
    ...overrides,
  };
}

test.afterEach(() => {
  // handleChannelDelete/restoreChannel write into the real store.pinnedMessages (not a test-local
  // object — see channel-deletion-undo.js's doc comment on why: it's the shared, live tracking
  // state channel-manager.js itself reads) and createTournamentChannel arms a real setTimeout
  // deletion timer on every successful (re)creation — both need clearing between tests.
  for (const key of Object.keys(store.pinnedMessages)) delete store.pinnedMessages[key];
  for (const key of Object.keys(channelManager.managedChannels)) {
    clearTimeout(channelManager.managedChannels[key].deleteTimer);
    delete channelManager.managedChannels[key];
  }
});

// ── handleChannelDelete ────────────────────────────────────────────────────────

test('handleChannelDelete: a self-initiated deletion (markSelfDeletion) is never treated as accidental — no record, no DM', () => {
  return withFakeModel(async (fake) => {
    store.pinnedMessages['chan-1'] = makePinnedEntry();
    selfDeletionTracker.markSelfDeletion('chan-1');

    const { guild } = makeFakeGuild('guild-1');
    const { client, sentDMs } = makeFakeClient({});
    const channel = makeFakeThread('chan-1', 'test-cup');
    channel.guild = guild;

    await channelDeletionUndo.handleChannelDelete(client, channel);

    assert.equal(fake.docs.length, 0, 'no deletion record should be created for an expected, bot-initiated delete');
    assert.equal(sentDMs.length, 0);
    // Real self-deletion callers (channel-manager.js's deleteManagedChannel, index.js's
    // /cancel-tournament) already clear their own pinnedMessages entry as part of the deletion
    // itself — this function correctly returns before ever touching it for a self-deletion, so the
    // entry set up by this test (never cleared by anything else here) is expected to still be
    // present.
    assert.ok(store.pinnedMessages['chan-1'], 'handleChannelDelete must return before touching pinnedMessages for a self-initiated deletion');
  });
});

test('handleChannelDelete: a channel with no pinnedMessages entry (never tracked) is a no-op', () => {
  return withFakeModel(async (fake) => {
    const { guild } = makeFakeGuild('guild-1');
    const { client, sentDMs } = makeFakeClient({});
    const channel = makeFakeThread('chan-untracked', 'untracked');
    channel.guild = guild;

    await channelDeletionUndo.handleChannelDelete(client, channel);

    assert.equal(fake.docs.length, 0);
    assert.equal(sentDMs.length, 0);
  });
});

test('handleChannelDelete: a tracked channel with no eventId (e.g. manually /setup-tournament) is a no-op — never auto-recreated anyway', () => {
  return withFakeModel(async (fake) => {
    store.pinnedMessages['chan-manual'] = makePinnedEntry({ tournamentEventId: undefined });
    const { guild } = makeFakeGuild('guild-1');
    const { client, sentDMs } = makeFakeClient({});
    const channel = makeFakeThread('chan-manual', 'manual');
    channel.guild = guild;

    await channelDeletionUndo.handleChannelDelete(client, channel);

    assert.equal(fake.docs.length, 0);
    assert.equal(sentDMs.length, 0);
  });
});

test('handleChannelDelete: an external deletion with an identifiable deleter creates a pending record and DMs them', () => {
  return withFakeModel(async (fake) => {
    store.pinnedMessages['chan-2'] = makePinnedEntry();
    const { guild } = makeFakeGuild('guild-1', {
      auditEntries: [{ targetId: 'chan-2', executor: { id: 'mod-1', tag: 'SomeMod#0001' }, type: AuditLogEvent.ThreadDelete }],
    });
    const { client, sentDMs } = makeFakeClient({});
    const channel = makeFakeThread('chan-2', 'test-cup');
    channel.guild = guild;

    await channelDeletionUndo.handleChannelDelete(client, channel);

    assert.equal(fake.docs.length, 1);
    assert.equal(fake.docs[0].status, 'pending_confirmation');
    assert.equal(fake.docs[0].guildId, 'guild-1');
    assert.equal(fake.docs[0].eventId, 'evt_abc');
    assert.equal(fake.docs[0].deletedBy.id, 'mod-1');
    assert.equal(sentDMs.length, 1);
    assert.equal(sentDMs[0].discordId, 'mod-1');
    assert.equal(store.pinnedMessages['chan-2'], undefined, 'stale pinnedMessages entry must be cleared — the channel is gone');
  });
});

test('handleChannelDelete: no identifiable deleter (audit log lookup finds nothing) fails toward permanently_deleted, no DM sent', () => {
  return withFakeModel(async (fake) => {
    store.pinnedMessages['chan-3'] = makePinnedEntry();
    const { guild } = makeFakeGuild('guild-1', { auditEntries: [] }); // nothing matches this channel id
    const { client, sentDMs } = makeFakeClient({});
    const channel = makeFakeThread('chan-3', 'test-cup');
    channel.guild = guild;

    await channelDeletionUndo.handleChannelDelete(client, channel);

    assert.equal(fake.docs.length, 1);
    assert.equal(fake.docs[0].status, 'permanently_deleted', 'an unidentifiable deleter must fail toward "stays deleted", not silently recreate later');
    assert.equal(sentDMs.length, 0, 'nobody to DM');
  });
});

test('handleChannelDelete: the bot itself as executor (defense in depth) is treated the same as no identifiable deleter', () => {
  return withFakeModel(async (fake) => {
    store.pinnedMessages['chan-4'] = makePinnedEntry();
    const { guild } = makeFakeGuild('guild-1', {
      auditEntries: [{ targetId: 'chan-4', executor: { id: 'bot-id', tag: 'MatchMaker#0000' }, type: AuditLogEvent.ThreadDelete }],
    });
    const { client, sentDMs } = makeFakeClient({});
    const channel = makeFakeThread('chan-4', 'test-cup');
    channel.guild = guild;

    await channelDeletionUndo.handleChannelDelete(client, channel);

    assert.equal(fake.docs[0].status, 'permanently_deleted');
    assert.equal(sentDMs.length, 0);
  });
});

test('handleChannelDelete: a later deletion of the same (guild, eventId) after a prior decision upserts back to pending_confirmation with a fresh snapshot', () => {
  return withFakeModel(async (fake) => {
    fake.docs.push({
      _id: 'rec-existing', guildId: 'guild-1', eventId: 'evt_abc', status: 'restored',
      tournamentName: 'Old Name', region: 'EU', snapshot: {}, deletedBy: null,
      deletedAt: new Date(), expiresAt: new Date(), dmChannelId: null, dmMessageId: null, decidedAt: new Date(),
    });

    store.pinnedMessages['chan-5'] = makePinnedEntry({ tournamentName: 'Test Cup Again' });
    const { guild } = makeFakeGuild('guild-1', {
      auditEntries: [{ targetId: 'chan-5', executor: { id: 'mod-2', tag: 'Mod2#0002' }, type: AuditLogEvent.ThreadDelete }],
    });
    const { client } = makeFakeClient({});
    const channel = makeFakeThread('chan-5', 'test-cup-again');
    channel.guild = guild;

    await channelDeletionUndo.handleChannelDelete(client, channel);

    assert.equal(fake.docs.length, 1, 'same (guildId, eventId) must reuse the one record, not create a second');
    assert.equal(fake.docs[0].status, 'pending_confirmation');
    assert.equal(fake.docs[0].tournamentName, 'Test Cup Again', 'snapshot/name must be refreshed, not left stale from the prior cycle');
  });
});

// ── Thread vs. normal channel: distinct Discord audit-log event types ────────────────────────
// A forum post's deletion is logged under AuditLogEvent.ThreadDelete (112), a genuinely separate
// type from AuditLogEvent.ChannelDelete (12) — confirmed via discord-api-types' own enum. Querying
// the wrong type would find nothing and silently misattribute every real deletion to "no
// identifiable deleter".

test('handleChannelDelete: a THREAD deletion (isThread() true) queries AuditLogEvent.ThreadDelete, not ChannelDelete', () => {
  return withFakeModel(async (fake) => {
    store.pinnedMessages['chan-6'] = makePinnedEntry();
    const { guild, fetchAuditLogCalls } = makeFakeGuild('guild-1', {
      auditEntries: [{ targetId: 'chan-6', executor: { id: 'mod-1', tag: 'Mod#1' }, type: AuditLogEvent.ThreadDelete }],
    });
    const { client, sentDMs } = makeFakeClient({});
    const channel = makeFakeThread('chan-6', 'test-cup');
    channel.guild = guild;

    await channelDeletionUndo.handleChannelDelete(client, channel);

    assert.deepEqual(fetchAuditLogCalls, [AuditLogEvent.ThreadDelete]);
    assert.equal(sentDMs.length, 1, 'the executor must actually be found via the correct audit-log type');
    assert.equal(fake.docs[0].status, 'pending_confirmation');
  });
});

test('handleChannelDelete: a NORMAL channel deletion (isThread() false — a legacy pre-migration channel) still queries AuditLogEvent.ChannelDelete', () => {
  return withFakeModel(async (fake) => {
    store.pinnedMessages['chan-7'] = makePinnedEntry();
    const { guild, fetchAuditLogCalls } = makeFakeGuild('guild-1', {
      auditEntries: [{ targetId: 'chan-7', executor: { id: 'mod-1', tag: 'Mod#1' }, type: AuditLogEvent.ChannelDelete }],
    });
    const { client, sentDMs } = makeFakeClient({});
    const channel = { id: 'chan-7', name: 'legacy-channel', isThread: () => false, guild };

    await channelDeletionUndo.handleChannelDelete(client, channel);

    assert.deepEqual(fetchAuditLogCalls, [AuditLogEvent.ChannelDelete]);
    assert.equal(sentDMs.length, 1, 'a legacy plain-text channel must still resolve its real deleter');
    assert.equal(fake.docs[0].status, 'pending_confirmation');
  });
});

test('handleChannelDelete: querying the WRONG audit-log type (regression demonstration) would have found nobody — confirms why isThread() routing matters', () => {
  return withFakeModel(async (fake) => {
    store.pinnedMessages['chan-8'] = makePinnedEntry();
    // The real deletion IS logged (as a real ThreadDelete entry) — but this guild's fake audit log
    // only serves entries matching the type it was actually queried with, exactly like the real
    // Discord API. If handleChannelDelete queried ChannelDelete for a thread (the pre-fix bug),
    // this entry would never be found.
    const { guild } = makeFakeGuild('guild-1', {
      auditEntries: [{ targetId: 'chan-8', executor: { id: 'mod-1', tag: 'Mod#1' }, type: AuditLogEvent.ThreadDelete }],
    });
    const { client, sentDMs } = makeFakeClient({});
    const channel = makeFakeThread('chan-8', 'test-cup');
    channel.guild = guild;

    await channelDeletionUndo.handleChannelDelete(client, channel);

    // The real fix (querying ThreadDelete for a thread) means this DOES find the executor —
    // proving the routing is actually correct, not just plausible.
    assert.equal(sentDMs.length, 1);
    assert.equal(fake.docs[0].deletedBy.id, 'mod-1');
  });
});

// ── Cross-guild isolation (the compound-key correctness requirement) ─────────────────────────

test('handleChannelDelete + createTournamentChannel: a permanent deletion in one guild never blocks recreation of the SAME eventId in a different guild', () => {
  return withFakeModel(async (fake) => {
    // Deleted with no identifiable deleter in guild-1 -> permanently_deleted there.
    store.pinnedMessages['chan-g1'] = makePinnedEntry({ guildId: 'guild-1' });
    const { guild: guild1 } = makeFakeGuild('guild-1', { auditEntries: [] });
    const { client } = makeFakeClient({});
    const channel1 = makeFakeThread('chan-g1', 'test-cup');
    channel1.guild = guild1;
    await channelDeletionUndo.handleChannelDelete(client, channel1);
    assert.equal(fake.docs.find(d => d.guildId === 'guild-1').status, 'permanently_deleted');

    // The exact same eventId, in an unrelated guild-2, must still create normally.
    const { guild: guild2, createCalls } = makeFakeGuild('guild-2');
    const tournament = {
      name: 'Test Cup', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: 'evt_abc',
    };
    await channelManager.createTournamentChannel(guild2, tournament, {});

    assert.equal(createCalls.length, 1, 'guild-2 must still get its channel — a deletion in guild-1 is scoped to guild-1 only');
  });
});

// ── createTournamentChannel gating (channel-manager.js) ───────────────────────────────────────

test('createTournamentChannel: skips creation for a pending_confirmation record in this guild — never recreates during the restore window', () => {
  return withFakeModel(async (fake) => {
    fake.docs.push({
      _id: 'rec-1', guildId: 'guild-1', eventId: 'evt_pending', status: 'pending_confirmation',
      tournamentName: 'Test Cup', region: 'EU', snapshot: {}, deletedBy: null,
      deletedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000), dmChannelId: null, dmMessageId: null, decidedAt: null,
    });

    const { guild, createCalls } = makeFakeGuild('guild-1');
    const tournament = {
      name: 'Test Cup', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: 'evt_pending',
    };

    await channelManager.createTournamentChannel(guild, tournament, {});

    assert.equal(createCalls.length, 0);
  });
});

test('createTournamentChannel: skips creation for a permanently_deleted record in this guild', () => {
  return withFakeModel(async (fake) => {
    fake.docs.push({
      _id: 'rec-2', guildId: 'guild-1', eventId: 'evt_perma', status: 'permanently_deleted',
      tournamentName: 'Test Cup', region: 'EU', snapshot: {}, deletedBy: null,
      deletedAt: new Date(), expiresAt: new Date(), dmChannelId: null, dmMessageId: null, decidedAt: new Date(),
    });

    const { guild, createCalls } = makeFakeGuild('guild-1');
    const tournament = {
      name: 'Test Cup', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: 'evt_perma',
    };

    await channelManager.createTournamentChannel(guild, tournament, {});

    assert.equal(createCalls.length, 0);
  });
});

test('createTournamentChannel: a "restored" record does not block — normal creation proceeds', () => {
  return withFakeModel(async (fake) => {
    fake.docs.push({
      _id: 'rec-3', guildId: 'guild-1', eventId: 'evt_restored', status: 'restored',
      tournamentName: 'Test Cup', region: 'EU', snapshot: {}, deletedBy: null,
      deletedAt: new Date(), expiresAt: new Date(), dmChannelId: null, dmMessageId: null, decidedAt: new Date(),
    });

    const { guild, createCalls } = makeFakeGuild('guild-1');
    const tournament = {
      name: 'Test Cup', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: 'evt_restored',
    };

    await channelManager.createTournamentChannel(guild, tournament, {});

    assert.equal(createCalls.length, 1, 'a settled "restored" record must not block future normal creation/management');
  });
});

test('createTournamentChannel: no deletion record at all creates normally (the common case)', () => {
  return withFakeModel(async () => {
    const { guild, createCalls } = makeFakeGuild('guild-1');
    const tournament = {
      name: 'Test Cup', region: 'EU', beginTime: futureIso(20), lastBeginTime: futureIso(20),
      isTrios: false, consoleOnly: false, isPermanent: false, eventId: 'evt_none',
    };

    await channelManager.createTournamentChannel(guild, tournament, {});

    assert.equal(createCalls.length, 1);
  });
});

// ── restoreChannel ─────────────────────────────────────────────────────────────

test('restoreChannel: a pending record is settled to restored and the channel is recreated from its snapshot', () => {
  return withFakeModel(async (fake) => {
    fake.docs.push({
      _id: 'rec-4', guildId: 'guild-1', eventId: 'evt_restore_me', status: 'pending_confirmation',
      tournamentName: 'Restore Me Cup', region: 'NAC',
      snapshot: {
        tournamentName: 'Restore Me Cup', region: 'NAC', tournamentEventId: 'evt_restore_me',
        isTrios: true, isRankedCup: false, consoleOnly: false, permanent: false,
        beginTime: futureIso(10),
        deleteAt: Date.now() + (10 * 3600_000) + 2 * 3600_000,
      },
      deletedBy: { id: 'mod-1', tag: 'SomeMod#0001' },
      deletedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      dmChannelId: null, dmMessageId: null, decidedAt: null,
    });

    const { guild, createCalls } = makeFakeGuild('guild-1');
    const { client } = makeFakeClient({ 'guild-1': guild });

    const result = await channelDeletionUndo.restoreChannel(client, 'rec-4');

    assert.equal(result.applied, true);
    assert.equal(result.record.status, 'restored');
    assert.equal(createCalls.length, 1, 'the channel must actually be recreated');
    assert.equal(createCalls[0].name, channelManager.buildChannelName('Restore Me Cup'));
  });
});

test('restoreChannel: a record that is not pending (already restored/permanently_deleted, or unknown id) is a safe no-op', () => {
  return withFakeModel(async (fake) => {
    fake.docs.push({
      _id: 'rec-5', guildId: 'guild-1', eventId: 'evt_x', status: 'restored',
      tournamentName: 'X', region: 'EU', snapshot: {}, deletedBy: null,
      deletedAt: new Date(), expiresAt: new Date(), dmChannelId: null, dmMessageId: null, decidedAt: new Date(),
    });

    const { guild, createCalls } = makeFakeGuild('guild-1');
    const { client } = makeFakeClient({ 'guild-1': guild });

    const result = await channelDeletionUndo.restoreChannel(client, 'rec-5');

    assert.equal(result.applied, false, 'already-settled record must not apply again');
    assert.equal(createCalls.length, 0);

    const unknown = await channelDeletionUndo.restoreChannel(client, 'no-such-record');
    assert.equal(unknown.applied, false);
  });
});

// ── expireOverdueRestoreWindows ────────────────────────────────────────────────

test('expireOverdueRestoreWindows: an overdue pending record is settled permanently_deleted and its DM is edited in place', () => {
  return withFakeModel(async (fake) => {
    fake.docs.push({
      _id: 'rec-6', guildId: 'guild-1', eventId: 'evt_overdue', status: 'pending_confirmation',
      tournamentName: 'Overdue Cup', region: 'EU', snapshot: {}, deletedBy: { id: 'mod-1', tag: 'Mod#1' },
      deletedAt: new Date(Date.now() - 25 * 3600_000), expiresAt: new Date(Date.now() - 3600_000),
      dmChannelId: 'dm-chan-mod-1', dmMessageId: 'dm-msg-1', decidedAt: null,
    });

    const { client, editedMessages } = makeFakeClient({});
    await channelDeletionUndo.expireOverdueRestoreWindows(client);

    assert.equal(fake.docs[0].status, 'permanently_deleted');
    assert.equal(editedMessages.length, 1);
  });
});

test('expireOverdueRestoreWindows: a record still within its window is left untouched', () => {
  return withFakeModel(async (fake) => {
    fake.docs.push({
      _id: 'rec-7', guildId: 'guild-1', eventId: 'evt_future', status: 'pending_confirmation',
      tournamentName: 'Future Cup', region: 'EU', snapshot: {}, deletedBy: null,
      deletedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      dmChannelId: null, dmMessageId: null, decidedAt: null,
    });

    const { client } = makeFakeClient({});
    await channelDeletionUndo.expireOverdueRestoreWindows(client);

    assert.equal(fake.docs[0].status, 'pending_confirmation');
  });
});

// ── listPendingForGuild ────────────────────────────────────────────────────────

test('listPendingForGuild: returns only pending_confirmation records for the requested guild', () => {
  return withFakeModel(async (fake) => {
    fake.docs.push(
      { _id: 'a', guildId: 'guild-1', eventId: 'e1', status: 'pending_confirmation', tournamentName: 'A', region: 'EU', snapshot: {}, deletedAt: new Date(), expiresAt: new Date() },
      { _id: 'b', guildId: 'guild-1', eventId: 'e2', status: 'restored', tournamentName: 'B', region: 'EU', snapshot: {}, deletedAt: new Date(), expiresAt: new Date() },
      { _id: 'c', guildId: 'guild-2', eventId: 'e3', status: 'pending_confirmation', tournamentName: 'C', region: 'EU', snapshot: {}, deletedAt: new Date(), expiresAt: new Date() },
    );

    const result = await channelDeletionUndo.listPendingForGuild('guild-1');

    assert.equal(result.length, 1);
    assert.equal(result[0]._id, 'a');
  });
});
