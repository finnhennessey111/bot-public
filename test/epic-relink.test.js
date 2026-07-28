// Verifies the "can players re-link a different Epic account" fix.
//
// Investigation before changing anything found: re-triggering the Link Epic Account flow already
// mechanically overwrites an existing link (webhook-server.js's /epic-callback called a raw
// upsertPlayer unconditionally) — but getPlayerStats' 24h cache keys purely off lastUpdated with
// no check that cached stats belong to the *currently* linked epicId, so a re-link to a different
// account could keep serving the OLD account's stats (mislabeled as the new one's) for up to 24h.
// There was also no way to fully unlink at all. This fixes both: linkEpicAccount clears stale
// cached stats specifically when the epicId actually changes, and the new unlinkEpicAccount /
// /unlink-epic command provide a real "remove my link" path.
//
// players.js's getPlayer/upsertPlayer need a live MongoDB connection (confirmed to hang ~10s then
// reject without one, no live DB in this environment) — linkEpicAccount/unlinkEpicAccount delegate
// through module.exports (not closed-over local references) specifically so a test can stub those
// two functions and exercise the real decision logic (same pattern scraper.js's scrapePlayer uses
// for scrapePlayerOnce).
const test = require('node:test');
const assert = require('node:assert/strict');

const playerStore = require('../players');

function withStubbedStore({ getPlayer, upsertPlayer }, fn) {
  const originalGet = playerStore.getPlayer;
  const originalUpsert = playerStore.upsertPlayer;
  playerStore.getPlayer = getPlayer;
  playerStore.upsertPlayer = upsertPlayer;
  return Promise.resolve(fn()).finally(() => {
    playerStore.getPlayer = originalGet;
    playerStore.upsertPlayer = originalUpsert;
  });
}

// --- isEpicLinked (the actual gate used throughout index.js) --------------------------------

test('isEpicLinked: false when never linked', () => {
  assert.equal(playerStore.isEpicLinked(null), false);
  assert.equal(playerStore.isEpicLinked({ region: 'EU' }), false);
});

test('isEpicLinked: true once genuinely linked', () => {
  assert.equal(playerStore.isEpicLinked({ epicOAuthLinked: true, epicId: '1', epicUsername: 'Ninja' }), true);
});

// --- linkEpicAccount: the re-link path ------------------------------------------------------

test('linkEpicAccount: a fresh link (never linked before) does not need to clear anything, and sets the link fields', async () => {
  let upsertedFields = null;
  await withStubbedStore({
    getPlayer: async () => null,
    upsertPlayer: async (guildId, discordId, fields) => { upsertedFields = fields; return { guildId, discordId, ...fields }; },
  }, async () => {
    await playerStore.linkEpicAccount('g1', 'd1', { epicId: 'NEW_ID', epicUsername: 'NewPlayer' });
  });

  assert.equal(upsertedFields.epicId, 'NEW_ID');
  assert.equal(upsertedFields.epicUsername, 'NewPlayer');
  assert.equal(upsertedFields.epicOAuthLinked, true);
  assert.ok(upsertedFields.epicLinkedAt instanceof Date);
  // No stale stats to clear on a first-ever link — totalPR etc. simply weren't touched.
  assert.equal('totalPR' in upsertedFields, false);
});

test('linkEpicAccount: re-linking the SAME account does not clear cached stats (nothing stale to invalidate)', async () => {
  let upsertedFields = null;
  await withStubbedStore({
    getPlayer: async () => ({
      epicOAuthLinked: true, epicId: 'SAME_ID', epicUsername: 'OldName', totalPR: 500, lastUpdated: new Date(),
    }),
    upsertPlayer: async (guildId, discordId, fields) => { upsertedFields = fields; return fields; },
  }, async () => {
    // Same epicId, maybe a corrected display name — a legitimate re-authorization, not an account switch.
    await playerStore.linkEpicAccount('g1', 'd1', { epicId: 'SAME_ID', epicUsername: 'OldName' });
  });

  assert.equal(upsertedFields.epicId, 'SAME_ID');
  assert.equal('totalPR' in upsertedFields, false, 'same-account re-link must not touch cached stats');
  assert.equal('lastUpdated' in upsertedFields, false);
});

test('linkEpicAccount: re-linking to a DIFFERENT account clears stale cached stats (the actual bug this fixes)', async () => {
  let upsertedFields = null;
  await withStubbedStore({
    getPlayer: async () => ({
      epicOAuthLinked: true, epicId: 'OLD_ID', epicUsername: 'OldPlayer',
      totalPR: 999, thisSeasonPR: 400, prBand: 'Elite', recentEvents: [{ name: 'Old Cup' }], lastUpdated: new Date(),
    }),
    upsertPlayer: async (guildId, discordId, fields) => { upsertedFields = fields; return fields; },
  }, async () => {
    await playerStore.linkEpicAccount('g1', 'd1', { epicId: 'NEW_ID', epicUsername: 'NewPlayer' });
  });

  assert.equal(upsertedFields.epicId, 'NEW_ID');
  assert.equal(upsertedFields.epicUsername, 'NewPlayer');
  // The critical assertions: the OLD account's cached stats must not survive under the new link.
  assert.equal(upsertedFields.totalPR, null);
  assert.equal(upsertedFields.thisSeasonPR, null);
  assert.equal(upsertedFields.prBand, null);
  assert.deepEqual(upsertedFields.recentEvents, []);
  assert.equal(upsertedFields.lastUpdated, null);
});

// --- unlinkEpicAccount: the new /unlink-epic path -------------------------------------------

test('unlinkEpicAccount: clears the link fields and all cached stats', async () => {
  let upsertedFields = null;
  await withStubbedStore({
    getPlayer: async () => ({ epicOAuthLinked: true, epicId: 'X', epicUsername: 'Y', totalPR: 300 }),
    upsertPlayer: async (guildId, discordId, fields) => { upsertedFields = fields; return fields; },
  }, async () => {
    await playerStore.unlinkEpicAccount('g1', 'd1');
  });

  assert.equal(upsertedFields.epicId, null);
  assert.equal(upsertedFields.epicUsername, null);
  assert.equal(upsertedFields.epicOAuthLinked, false);
  assert.equal(upsertedFields.epicLinkedAt, null);
  assert.equal(upsertedFields.totalPR, null);
  assert.equal(upsertedFields.lastUpdated, null);

  // And the record now reads as unlinked through the same real gate index.js uses.
  assert.equal(playerStore.isEpicLinked(upsertedFields), false);
});
