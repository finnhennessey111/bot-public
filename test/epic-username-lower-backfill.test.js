// Verifies the fix for a real production bug: epicUsernameLower (added for elo.js's fast public
// lookup) was only ever populated going forward by players.js's upsertPlayer, so every
// pre-existing Player document — confirmed against real data, 5 documents across 5 guilds for one
// real linked account — has epicUsername but no epicUsernameLower at all, making
// GET /api/elo/:epicUsername incorrectly report "not found" for real, linked, previously-scraped
// players.
//
// Two independent fixes, both verified here:
//   1. findCanonicalByEpicUsername falls back to a case-insensitive epicUsername scan when the
//      fast epicUsernameLower path finds nothing — correctness right now, for every existing
//      record, regardless of whether the backfill below has been run yet.
//   2. backfill-epic-username-lower.js — a one-time, idempotent script that populates
//      epicUsernameLower on every document missing it, so the FAST indexed path actually applies
//      to pre-existing records instead of relying on the fallback forever.
const test = require('node:test');
const assert = require('node:assert/strict');

const PlayerModel = require('../models/Player');
const playerStore = require('../players');
const db = require('../db');
const backfill = require('../backfill-epic-username-lower');

// ── Fix 1: findCanonicalByEpicUsername fallback ───────────────────────────────
test('findCanonicalByEpicUsername: a record missing epicUsernameLower entirely is still found via the epicUsername fallback', async () => {
  const original = PlayerModel.find;
  // Exactly the real production shape reported: epicUsername set, epicUsernameLower absent.
  const preExistingRecord = {
    guildId: 'guildX', discordId: 'd1', epicUsername: 'finn444 wwwwwwww',
    epicId: 'real-epic-id', totalPR: 640, lastUpdated: new Date('2026-07-01'),
    // epicUsernameLower deliberately omitted — matches "missing entirely", not just null.
  };

  PlayerModel.find = (filter) => ({
    lean: async () => {
      if (filter.epicUsernameLower) return []; // the fast path finds nothing — this is the bug
      if (filter.epicUsername instanceof RegExp) {
        return filter.epicUsername.test(preExistingRecord.epicUsername) ? [preExistingRecord] : [];
      }
      if (filter.epicId) return [preExistingRecord];
      return [];
    },
  });

  try {
    // Search with different casing/whitespace than stored, matching how a real user would type it
    // into a public search box — the URL-decoded real symptom was "finn444 wwwwwwww".
    const result = await playerStore.findCanonicalByEpicUsername('FINN444 WWWWWWWW');
    assert.ok(result, 'must resolve via the fallback, not report not-found');
    assert.equal(result.epicUsername, 'finn444 wwwwwwww');
    assert.equal(result.totalPR, 640);
  } finally {
    PlayerModel.find = original;
  }
});

test('findCanonicalByEpicUsername: still prefers the fast epicUsernameLower path when it actually has a match (fallback only fires when the fast path finds nothing)', async () => {
  const original = PlayerModel.find;
  const fastPathCalls = [];
  const slowPathCalls = [];
  const modernRecord = { guildId: 'g1', discordId: 'd2', epicUsername: 'Bugha', epicUsernameLower: 'bugha', epicId: 'e2', totalPR: 900, lastUpdated: new Date() };

  PlayerModel.find = (filter) => ({
    lean: async () => {
      if (filter.epicUsernameLower) { fastPathCalls.push(filter); return [modernRecord]; }
      if (filter.epicUsername instanceof RegExp) { slowPathCalls.push(filter); return []; }
      if (filter.epicId) return [modernRecord];
      return [];
    },
  });

  try {
    const result = await playerStore.findCanonicalByEpicUsername('bugha');
    assert.equal(result.epicUsername, 'Bugha');
    assert.equal(fastPathCalls.length, 1);
    assert.equal(slowPathCalls.length, 0, 'the slower regex fallback must never run when the indexed path already found it');
  } finally {
    PlayerModel.find = original;
  }
});

test('findCanonicalByEpicUsername: a username matching neither path returns null (genuine not-found, not a crash)', async () => {
  const original = PlayerModel.find;
  PlayerModel.find = () => ({ lean: async () => [] });
  try {
    assert.equal(await playerStore.findCanonicalByEpicUsername('TrulyNobody'), null);
  } finally {
    PlayerModel.find = original;
  }
});

// ── Fix 2: backfill script, against a real Mongo-shaped mock ─────────────────
function makeFakeCollection(initialDocs) {
  const docs = initialDocs.map(d => ({ ...d }));

  function matches(doc, filter) {
    return Object.entries(filter).every(([key, cond]) => {
      const actual = doc[key];
      if (cond && typeof cond === 'object' && '$nin' in cond) return !cond.$nin.includes(actual);
      if (cond === null) return actual === null || actual === undefined;
      return actual === cond;
    });
  }

  return {
    docs,
    countDocuments: async (filter) => docs.filter(d => matches(d, filter)).length,
    // Simulates exactly the one pipeline stage the real script sends —
    // [{ $set: { epicUsernameLower: { $toLower: '$epicUsername' } } }] — not a generic aggregation
    // engine, just enough fidelity to verify this script's actual real behavior.
    updateMany: async (filter, pipeline) => {
      assert.deepEqual(pipeline, [{ $set: { epicUsernameLower: { $toLower: '$epicUsername' } } }]);
      const matching = docs.filter(d => matches(d, filter));
      for (const doc of matching) doc.epicUsernameLower = doc.epicUsername.toLowerCase();
      return { modifiedCount: matching.length };
    },
  };
}

function withStubbedBackfillModel(docs, fn) {
  const fake = makeFakeCollection(docs);
  const originalCount = PlayerModel.countDocuments;
  const originalUpdateMany = PlayerModel.updateMany;
  const originalConnect = db.connect;
  const originalMongoose = db.mongoose;

  PlayerModel.countDocuments = fake.countDocuments;
  PlayerModel.updateMany = fake.updateMany;
  db.connect = async () => true;
  db.mongoose = { connection: { close: async () => {} } };

  return Promise.resolve(fn(fake)).finally(() => {
    PlayerModel.countDocuments = originalCount;
    PlayerModel.updateMany = originalUpdateMany;
    db.connect = originalConnect;
    db.mongoose = originalMongoose;
  });
}

test('backfill: sets epicUsernameLower correctly on documents missing it, leaves documents that already have it completely untouched', () => {
  const docs = [
    { _id: 1, epicUsername: 'MixedCaseName', epicUsernameLower: null }, // missing (explicit null)
    { _id: 2, epicUsername: 'AlreadyFine', epicUsernameLower: 'alreadyfine' }, // already correct
    { _id: 3, epicUsername: 'NoLowerFieldAtAll' }, // missing (field absent entirely — real prod shape)
  ];

  return withStubbedBackfillModel(docs, async (fake) => {
    await backfill.main();

    const byId = Object.fromEntries(fake.docs.map(d => [d._id, d]));
    assert.equal(byId[1].epicUsernameLower, 'mixedcasename');
    assert.equal(byId[2].epicUsernameLower, 'alreadyfine', 'must be unchanged — was already correct');
    assert.equal(byId[3].epicUsernameLower, 'nolowerfieldatall');
  });
});

test('backfill: is idempotent — running it a second time updates 0 documents', () => {
  const docs = [
    { _id: 1, epicUsername: 'SomePlayer', epicUsernameLower: null },
    { _id: 2, epicUsername: 'AnotherOne' },
  ];

  return withStubbedBackfillModel(docs, async (fake) => {
    const countBefore = await fake.countDocuments(backfill.missingLowerFilter());
    assert.equal(countBefore, 2);

    await backfill.main(); // first run — fixes both

    const countAfterFirstRun = await fake.countDocuments(backfill.missingLowerFilter());
    assert.equal(countAfterFirstRun, 0, 'nothing should be missing anymore after the first run');

    // Second run must genuinely touch nothing. The script short-circuits on a 0 count and never
    // even calls updateMany — confirm that directly rather than assuming a call happens.
    let updateManyCalled = false;
    const updateManySpy = fake.updateMany;
    PlayerModel.updateMany = async (...args) => { updateManyCalled = true; return updateManySpy(...args); };
    await backfill.main();
    assert.equal(updateManyCalled, false, 'second run must not issue an update at all — nothing is missing the field');
  });
});

test('backfill: a document with no epicUsername at all (never linked) is never touched', () => {
  const docs = [
    { _id: 1, epicUsername: null, epicUsernameLower: null }, // never linked — nothing to derive
    { _id: 2, epicUsername: '', epicUsernameLower: null }, // defensively-empty string
  ];

  return withStubbedBackfillModel(docs, async (fake) => {
    await backfill.main();
    assert.equal(fake.docs[0].epicUsernameLower, null);
    assert.equal(fake.docs[1].epicUsernameLower, null);
  });
});
