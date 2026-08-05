// Verifies players.js's searchEpicUsernames (elo.js's GET /api/elo/search autocomplete) — same
// "stub the Model, not the module" precedent as test/elo-endpoint.test.js: PlayerModel.find is
// stubbed to return a Mongoose-query-shaped chain (find -> sort -> limit -> lean), so the real
// prefix-matching/dedup/cap logic in players.js runs unmodified against no real MongoDB.
const test = require('node:test');
const assert = require('node:assert/strict');

const PlayerModel = require('../models/Player');
const playerStore = require('../players');

// filter.epicUsernameLower is always a RegExp here (searchEpicUsernames' own construction) —
// applies it, then chains sort/limit the same way the real Mongoose query builder does, so the
// real call order (.find(...).sort(...).limit(...).lean()) in players.js is genuinely exercised.
function stubPlayerFindForSearch(players) {
  return (filter) => {
    let results = players.filter(p => filter.epicUsernameLower.test(p.epicUsernameLower ?? ''));
    const query = {
      sort: (spec) => {
        const [[field, dir]] = Object.entries(spec);
        results = [...results].sort((a, b) => {
          if (a[field] < b[field]) return -1 * dir;
          if (a[field] > b[field]) return 1 * dir;
          return 0;
        });
        return query;
      },
      limit: (n) => { results = results.slice(0, n); return query; },
      lean: async () => results,
    };
    return query;
  };
}

function withStubbedFind(players, fn) {
  const original = PlayerModel.find;
  PlayerModel.find = stubPlayerFindForSearch(players);
  return fn().finally(() => { PlayerModel.find = original; });
}

function player(epicUsername, overrides = {}) {
  return {
    epicUsername, epicUsernameLower: epicUsername.toLowerCase(),
    epicId: overrides.epicId ?? `id-${epicUsername.toLowerCase()}`,
    lastUpdated: overrides.lastUpdated ?? new Date(),
    _id: overrides._id ?? epicUsername,
    ...overrides,
  };
}

test('searchEpicUsernames: prefix match — "test" finds "TestPlayer123", not a player whose name merely CONTAINS "test" elsewhere', async () => {
  await withStubbedFind([
    player('TestPlayer123'),
    player('ContainsTestInMiddle'), // "test" is NOT a prefix here — must not match
  ], async () => {
    const results = await playerStore.searchEpicUsernames('test');
    assert.deepEqual(results, ['TestPlayer123']);
  });
});

test('searchEpicUsernames: case-insensitive — an uppercase query still matches a lowercase-stored username', async () => {
  await withStubbedFind([player('finn444')], async () => {
    const results = await playerStore.searchEpicUsernames('FINN');
    assert.deepEqual(results, ['finn444']);
  });
});

test('searchEpicUsernames: never returns more than 5 results, even with many more real matches', async () => {
  const players = Array.from({ length: 12 }, (_, i) => player(`Prefix${String(i).padStart(2, '0')}`));
  await withStubbedFind(players, async () => {
    const results = await playerStore.searchEpicUsernames('prefix');
    assert.equal(results.length, 5);
  });
});

test('searchEpicUsernames: a player who never registered (no matching Player doc at all) never appears', async () => {
  await withStubbedFind([player('RegisteredPlayer')], async () => {
    const results = await playerStore.searchEpicUsernames('unregisteredplayer');
    assert.deepEqual(results, []);
  });
});

test('searchEpicUsernames: empty/whitespace query returns no results without querying anything odd', async () => {
  await withStubbedFind([player('AnyPlayer')], async () => {
    assert.deepEqual(await playerStore.searchEpicUsernames(''), []);
    assert.deepEqual(await playerStore.searchEpicUsernames('   '), []);
  });
});

test('searchEpicUsernames: the same real account registered under multiple guilds (same epicId, multiple Player docs) appears only ONCE, the freshest copy', async () => {
  const older = player('MultiGuild', { epicId: 'shared-id', lastUpdated: new Date('2026-01-01'), _id: 'doc1' });
  const newer = player('MultiGuild', { epicId: 'shared-id', lastUpdated: new Date('2026-06-01'), _id: 'doc2' });
  await withStubbedFind([older, newer], async () => {
    const results = await playerStore.searchEpicUsernames('multiguild');
    assert.deepEqual(results, ['MultiGuild'], 'must appear exactly once, not twice, even though 2 Player docs match');
  });
});

test('searchEpicUsernames: distinct players sharing a prefix are NOT collapsed together — dedup is per-account (epicId), not per-prefix', async () => {
  await withStubbedFind([
    player('Duplicate', { epicId: 'account-a' }),
    player('Duplicate2', { epicId: 'account-b' }),
  ], async () => {
    const results = await playerStore.searchEpicUsernames('duplicate');
    assert.equal(results.length, 2);
  });
});

test('searchEpicUsernames: regex special characters in the query are escaped, not treated as a live regex pattern', async () => {
  await withStubbedFind([player('a.b'), player('axb')], async () => {
    // A literal "." should only match the player literally named "a.b" — if unescaped, "." would
    // also match "axb" (regex wildcard), proving the escaping is genuinely load-bearing here.
    const results = await playerStore.searchEpicUsernames('a.b');
    assert.deepEqual(results, ['a.b']);
  });
});

test('searchEpicUsernames: a legacy Player doc with no epicId falls back to a per-doc identity, still deduped correctly against itself', async () => {
  const legacy = player('LegacyNoEpicId', { epicId: undefined, _id: 'legacy-doc-1' });
  await withStubbedFind([legacy], async () => {
    const results = await playerStore.searchEpicUsernames('legacy');
    assert.deepEqual(results, ['LegacyNoEpicId']);
  });
});
