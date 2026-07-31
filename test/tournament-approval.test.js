// Verifies tournament-approval.js's manual-approval gate: a genuinely new tournament (by eventId)
// must be DMed to the owner and held back from channel creation until approved; an already-live
// tournament must never be gated retroactively; a pending tournament whose start time passes with
// no decision must expire (not auto-approve); approving something already past its start time at
// decision-time must also settle as expired, not create a stale channel.
//
// No real MongoDB in this environment — models/TournamentApproval.js's Model methods are
// monkey-patched with a small real in-memory collection (not per-call hardcoded stubs) so the
// actual production tournament-approval.js code runs unmodified against realistic query/update
// semantics, including the atomic status:'pending' guard that makes double-decide/race-safety
// actually meaningful to test. Same "stub the Model, not the module" precedent as
// test/store-selective-persistence.test.js and test/changelog-and-suggestions.test.js.
//
// discord-dm.js's dmUser is destructured at require time inside tournament-approval.js, so (same
// as test/changelog-and-suggestions.test.js's note on suggestions.js) it's exercised via a fake
// `client` object at the real boundary (client.users.fetch(id).send(payload)) rather than
// monkey-patching the already-bound dmUser reference, which wouldn't be seen.
const test = require('node:test');
const assert = require('node:assert/strict');

const TournamentApprovalModel = require('../models/TournamentApproval');
const tournamentApproval = require('../tournament-approval');

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    const actual = getPath(doc, key);
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('$ne' in cond) return actual !== cond.$ne;
      if ('$lte' in cond) return actual != null && actual <= cond.$lte;
    }
    return actual === cond;
  });
}

function applySet(doc, update) {
  if (update.$set) Object.assign(doc, update.$set);
}

function makeFakeCollection() {
  const docs = [];
  return {
    docs,
    create: async (doc) => {
      const full = { dmChannelId: null, dmMessageId: null, decidedAt: null, createdAt: new Date(), ...doc };
      docs.push(full);
      return full;
    },
    findOne: (filter) => ({ lean: async () => docs.find(d => matchesFilter(d, filter)) ?? null }),
    find: (filter) => ({ lean: async () => docs.filter(d => matchesFilter(d, filter)) }),
    findOneAndUpdate: (filter, update) => ({
      lean: async () => {
        const doc = docs.find(d => matchesFilter(d, filter));
        if (!doc) return null;
        applySet(doc, update);
        return doc;
      },
    }),
    updateOne: async (filter, update, options) => {
      const doc = docs.find(d => matchesFilter(d, filter));
      if (!doc) {
        if (options?.upsert) {
          const inserted = { eventId: filter.eventId, dmChannelId: null, dmMessageId: null, decidedAt: null, createdAt: new Date(), ...(update.$setOnInsert ?? {}) };
          applySet(inserted, update);
          docs.push(inserted);
        }
        return {};
      }
      applySet(doc, update);
      return {};
    },
  };
}

function makeFakeClient() {
  const sentDMs = [];
  const editedMessages = [];
  const dmChannelsById = {};
  let nextId = 1;

  const client = {
    users: {
      async fetch(discordId) {
        return {
          async send(payload) {
            const messageId = `dm-msg-${nextId++}`;
            const channelId = `dm-chan-${discordId}`;
            sentDMs.push({ discordId, payload, messageId, channelId });
            dmChannelsById[channelId] ??= {};
            dmChannelsById[channelId][messageId] = {
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
            // Falls back to a generic editable stub for a (channelId, messageId) pair that was
            // never actually sent via send() in this test — lets a test seed a Mongo record
            // directly (bypassing requestApproval) and still exercise expirePendingApprovals'
            // edit-the-DM path without needing a real prior send() call first.
            async fetch(messageId) {
              const existing = dmChannelsById[channelId]?.[messageId];
              if (existing) return existing;
              return { id: messageId, channelId, async edit(p) { editedMessages.push({ channelId, messageId, payload: p }); } };
            },
          },
        };
      },
    },
  };
  return { client, sentDMs, editedMessages };
}

function makeTournament(overrides = {}) {
  return {
    name: 'Test Cup', region: 'EU', eventId: `evt_${Math.random()}`,
    beginTime: new Date(Date.now() + 10 * 3600_000).toISOString(),
    lastBeginTime: new Date(Date.now() + 10 * 3600_000).toISOString(),
    isTrios: false, isMultiSession: false, isPermanent: false, isRankedCup: false, consoleOnly: false,
    ...overrides,
  };
}

function withFakeModel(fn) {
  const fake = makeFakeCollection();
  const originals = {
    create: TournamentApprovalModel.create,
    findOne: TournamentApprovalModel.findOne,
    find: TournamentApprovalModel.find,
    findOneAndUpdate: TournamentApprovalModel.findOneAndUpdate,
    updateOne: TournamentApprovalModel.updateOne,
  };
  Object.assign(TournamentApprovalModel, fake);
  return Promise.resolve(fn(fake)).finally(() => Object.assign(TournamentApprovalModel, originals));
}

test('gateTournaments: a brand-new eventId is held back (not in the approved list) and creates exactly one pending record', () => {
  return withFakeModel(async (fake) => {
    const { client, sentDMs } = makeFakeClient();
    const tournament = makeTournament();

    const approved = await tournamentApproval.gateTournaments(client, [tournament], {});

    assert.deepEqual(approved, [], 'a brand-new tournament must never be approved on the same tick it was first seen');
    assert.equal(fake.docs.length, 1);
    assert.equal(fake.docs[0].eventId, tournament.eventId);
    assert.equal(fake.docs[0].status, 'pending');

    if (tournamentApproval.BOT_OWNER_DISCORD_ID) {
      assert.equal(sentDMs.length, 1);
      assert.equal(sentDMs[0].discordId, tournamentApproval.BOT_OWNER_DISCORD_ID);
    } else {
      assert.equal(sentDMs.length, 0, 'no BOT_OWNER_DISCORD_ID configured in this environment — no DM should be attempted');
    }
  });
});

test('gateTournaments: a still-pending eventId is not re-DMed and stays excluded on a later tick', () => {
  return withFakeModel(async () => {
    const { client, sentDMs } = makeFakeClient();
    const tournament = makeTournament();

    await tournamentApproval.gateTournaments(client, [tournament], {});
    const approvedSecondTick = await tournamentApproval.gateTournaments(client, [tournament], {});

    assert.deepEqual(approvedSecondTick, []);
    assert.ok(sentDMs.length <= 1, 'must never DM a second time for a tournament that is still pending');
  });
});

test('gateTournaments: an approved eventId is included in the approved list, no new DM', () => {
  return withFakeModel(async (fake) => {
    const { client, sentDMs } = makeFakeClient();
    const tournament = makeTournament();
    fake.docs.push({ eventId: tournament.eventId, status: 'approved', tournament, dmChannelId: null, dmMessageId: null, createdAt: new Date(), decidedAt: new Date() });

    const approved = await tournamentApproval.gateTournaments(client, [tournament], {});

    assert.equal(approved.length, 1);
    assert.equal(approved[0].eventId, tournament.eventId);
    assert.equal(sentDMs.length, 0);
  });
});

test('gateTournaments: rejected and expired eventIds are excluded forever, no re-DM', () => {
  return withFakeModel(async (fake) => {
    const { client, sentDMs } = makeFakeClient();
    const rejected = makeTournament();
    const expired = makeTournament();
    fake.docs.push({ eventId: rejected.eventId, status: 'rejected', tournament: rejected, dmChannelId: null, dmMessageId: null, createdAt: new Date(), decidedAt: new Date() });
    fake.docs.push({ eventId: expired.eventId, status: 'expired', tournament: expired, dmChannelId: null, dmMessageId: null, createdAt: new Date(), decidedAt: new Date() });

    const approved = await tournamentApproval.gateTournaments(client, [rejected, expired], {});

    assert.deepEqual(approved, []);
    assert.equal(sentDMs.length, 0);
  });
});

test('gateTournaments: a genuinely new eventId that already has a LIVE channel is auto-approved with no DM (non-destructive rollout)', () => {
  return withFakeModel(async (fake) => {
    const { client, sentDMs } = makeFakeClient();
    const tournament = makeTournament();
    const pinnedMessages = { 'some-channel-id': { tournamentEventId: tournament.eventId } };

    const approved = await tournamentApproval.gateTournaments(client, [tournament], pinnedMessages);

    assert.equal(approved.length, 1, 'an already-live tournament must never be blocked by the new gate');
    assert.equal(sentDMs.length, 0, 'must not DM for something already running');
    assert.equal(fake.docs.find(d => d.eventId === tournament.eventId)?.status, 'approved');
  });
});

test('decide: approve on a still-upcoming tournament settles as approved and applies exactly once', () => {
  return withFakeModel(async (fake) => {
    const tournament = makeTournament();
    fake.docs.push({ eventId: tournament.eventId, status: 'pending', tournament, dmChannelId: null, dmMessageId: null, createdAt: new Date(), decidedAt: null });

    const result = await tournamentApproval.decide(tournament.eventId, 'approve');
    assert.equal(result.applied, true);
    assert.equal(result.status, 'approved');

    const second = await tournamentApproval.decide(tournament.eventId, 'approve');
    assert.equal(second.applied, false, 'a second decide call on an already-settled record must be a no-op');
  });
});

test('decide: reject settles as rejected', () => {
  return withFakeModel(async (fake) => {
    const tournament = makeTournament();
    fake.docs.push({ eventId: tournament.eventId, status: 'pending', tournament, dmChannelId: null, dmMessageId: null, createdAt: new Date(), decidedAt: null });

    const result = await tournamentApproval.decide(tournament.eventId, 'reject');
    assert.equal(result.applied, true);
    assert.equal(result.status, 'rejected');
  });
});

test('decide: approving a tournament whose start time has already passed settles as expired, not approved (never creates a stale channel)', () => {
  return withFakeModel(async (fake) => {
    const tournament = makeTournament({ beginTime: new Date(Date.now() - 3600_000).toISOString() });
    fake.docs.push({ eventId: tournament.eventId, status: 'pending', tournament, dmChannelId: null, dmMessageId: null, createdAt: new Date(), decidedAt: null });

    const result = await tournamentApproval.decide(tournament.eventId, 'approve');
    assert.equal(result.status, 'expired', 'approving something that already started must not create a channel for it');
  });
});

test('decide: approving a PERMANENT tournament past its listed beginTime still approves (permanent channels have no real "too late")', () => {
  return withFakeModel(async (fake) => {
    const tournament = makeTournament({ isPermanent: true, beginTime: new Date(Date.now() - 3600_000).toISOString() });
    fake.docs.push({ eventId: tournament.eventId, status: 'pending', tournament, dmChannelId: null, dmMessageId: null, createdAt: new Date(), decidedAt: null });

    const result = await tournamentApproval.decide(tournament.eventId, 'approve');
    assert.equal(result.status, 'approved');
  });
});

test('expirePendingApprovals: a pending tournament past its start time is marked expired and its DM is edited to show that', () => {
  return withFakeModel(async (fake) => {
    const { client, editedMessages } = makeFakeClient();
    const overdue = makeTournament({ beginTime: new Date(Date.now() - 3600_000).toISOString() });
    fake.docs.push({
      eventId: overdue.eventId, status: 'pending', tournament: overdue,
      dmChannelId: 'dm-chan-owner', dmMessageId: 'dm-msg-1', createdAt: new Date(), decidedAt: null,
    });

    await tournamentApproval.expirePendingApprovals(client);

    assert.equal(fake.docs.find(d => d.eventId === overdue.eventId).status, 'expired');
    assert.equal(editedMessages.length, 1);
  });
});

test('expirePendingApprovals: a pending tournament still in the future is left untouched', () => {
  return withFakeModel(async (fake) => {
    const { client } = makeFakeClient();
    const future = makeTournament();
    fake.docs.push({ eventId: future.eventId, status: 'pending', tournament: future, dmChannelId: null, dmMessageId: null, createdAt: new Date(), decidedAt: null });

    await tournamentApproval.expirePendingApprovals(client);

    assert.equal(fake.docs.find(d => d.eventId === future.eventId).status, 'pending');
  });
});

test('expirePendingApprovals: a permanent tournament is never auto-expired even with a past beginTime', () => {
  return withFakeModel(async (fake) => {
    const { client } = makeFakeClient();
    const permanent = makeTournament({ isPermanent: true, beginTime: new Date(Date.now() - 3600_000).toISOString() });
    fake.docs.push({ eventId: permanent.eventId, status: 'pending', tournament: permanent, dmChannelId: null, dmMessageId: null, createdAt: new Date(), decidedAt: null });

    await tournamentApproval.expirePendingApprovals(client);

    assert.equal(fake.docs.find(d => d.eventId === permanent.eventId).status, 'pending', 'a permanent tournament has no real "missed the start" — must stay pending indefinitely, not expire');
  });
});
