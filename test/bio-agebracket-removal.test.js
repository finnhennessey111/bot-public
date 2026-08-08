// Verifies the removal of #get-roles' bio and age-bracket features — both confirmed dead by an
// earlier investigation this session (bio: fully wired through modal -> DB -> buildPlayer but
// never displayed anywhere; ageBracket: displayed on the tournament match card but never used for
// any actual matching/safety restriction). Removed entirely, not just stopped-going-forward:
//   - embeds.js: buildRolesComponents no longer builds the age-bracket select; buildBioButtonRow
//     is gone; the tournament match card no longer has an Age Bracket field.
//   - index.js: select_age_bracket, set_bio, and bio_modal handlers are gone.
//   - queue.js's buildPlayer: no longer accepts or returns ageBracket/bio.
//   - models/Player.js: ageBracket/bio removed from the schema.
//   - players.js's removeBioAndAgeBracketFields: startup self-heal clearing the stale fields off
//     any Player document that still has them from before the removal (neither field was ever
//     backed by a Discord role — confirmed via a real search — so this is a pure Mongo cleanup,
//     not a per-guild Discord-object migration the way guild-config.js's GUILD_CONFIG_MIGRATIONS
//     are).
const test = require('node:test');
const assert = require('node:assert/strict');

const embeds = require('../embeds');
const { buildPlayer } = require('../queue');
const playerStore = require('../players');
const PlayerModel = require('../models/Player');

// ── #1: embeds.js — get-roles now covers exactly region/extraRegion/ingameRole/language ──────
test('buildRolesComponents: exactly 4 rows, no age-bracket select anywhere in them', () => {
  const rows = embeds.buildRolesComponents().map(r => r.toJSON());
  assert.equal(rows.length, 4, 'region, extraRegion, ingameRole, language — ageBracket removed');

  const allCustomIds = rows.flatMap(r => r.components.map(c => c.custom_id));
  assert.deepEqual(allCustomIds, ['select_region', 'select_extra_regions', 'select_ingame_role', 'select_language']);
  assert.ok(!allCustomIds.includes('select_age_bracket'), 'select_age_bracket must not exist anywhere');
});

test('embeds.js: buildBioButtonRow no longer exists as an export', () => {
  assert.equal(embeds.buildBioButtonRow, undefined);
});

test('embeds.js: buildPlatformSelectRow (added last session) is unaffected by this removal', () => {
  const row = embeds.buildPlatformSelectRow().toJSON();
  assert.equal(row.components[0].custom_id, 'select_platform');
});

// ── #2: the tournament match card no longer shows Age Bracket ────────────────────────────────
test('buildMatchCard: a player with a leftover ageBracket value (pre-removal data) does NOT get an Age Bracket field — the display code is gone, not just conditionally hidden', () => {
  const player = {
    epicUsername: 'Leftover', discordUsername: 'leftover', discordTag: 'leftover',
    platform: 'PC', homeRegion: 'EU', totalPR: 500, queueType: 'duo',
    ingameRoles: [], languages: [], recentEvents: [],
    ageBracket: '16+', // simulates a Player doc that still has the stale field before cleanup runs
  };
  const embed = embeds.buildMatchCard(player, 'Some Cup').toJSON();
  assert.ok(!embed.fields.some(f => /age bracket/i.test(f.name)), 'must never render an Age Bracket field again, even if the field is still present on the object');
});

// ── #3: queue.js's buildPlayer no longer carries ageBracket/bio at all ───────────────────────
test('buildPlayer: the returned player object has no ageBracket/bio keys, even if a caller still passes them', async () => {
  const original = playerStore.getStatsForContext;
  playerStore.getStatsForContext = async () => ({
    stats: { totalPR: 500, thisSeasonPR: 0, recentEvents: [] },
    prContext: { region: 'EU', platformSegment: 'all', isHomeRegion: true, isHomePlatform: true },
  });
  try {
    const player = await buildPlayer({
      guildId: 'g1', guildName: 'Test', discordId: 'd1', discordUsername: 'd1', discordTag: 'd1',
      epicUsername: 'd1', epicId: 'd1', tournamentName: 'Cup', homeRegion: 'EU', queueRegion: 'EU',
      queueType: 'duo', platform: 'PC', consoleOnly: false, ingameRoles: [], languages: [],
      ageBracket: '16+', bio: 'still here?', // deliberately passed, must be ignored/dropped
    });
    assert.ok(!('ageBracket' in player), 'ageBracket must not exist on the built player object at all');
    assert.ok(!('bio' in player), 'bio must not exist on the built player object at all');
  } finally {
    playerStore.getStatsForContext = original;
  }
});

// ── #4: models/Player.js — schema no longer declares these fields ────────────────────────────
test('models/Player.js: ageBracket and bio are not declared in the schema', () => {
  const paths = PlayerModel.schema.paths;
  assert.equal(paths.ageBracket, undefined);
  assert.equal(paths.bio, undefined);
});

// ── #5: players.js's removeBioAndAgeBracketFields — the startup self-heal ────────────────────
function withStubbedUpdateMany(impl, fn) {
  const original = PlayerModel.updateMany;
  PlayerModel.updateMany = impl;
  return Promise.resolve(fn()).finally(() => { PlayerModel.updateMany = original; });
}

test('removeBioAndAgeBracketFields: issues exactly one $unset across every Player doc that still has either field, regardless of guild', async () => {
  const calls = [];
  await withStubbedUpdateMany(async (filter, update) => {
    calls.push({ filter, update });
    return { matchedCount: 3 };
  }, async () => {
    await playerStore.removeBioAndAgeBracketFields();
  });

  assert.equal(calls.length, 1, 'must be a single global update, not one per guild');
  assert.deepEqual(calls[0].filter, { $or: [{ bio: { $exists: true } }, { ageBracket: { $exists: true } }] });
  assert.deepEqual(calls[0].update, { $unset: { bio: '', ageBracket: '' } });
});

test('removeBioAndAgeBracketFields: a clean database (nothing left to clean) is a safe, cheap no-op', async () => {
  await withStubbedUpdateMany(async () => ({ matchedCount: 0 }), async () => {
    await assert.doesNotReject(() => playerStore.removeBioAndAgeBracketFields());
  });
});

test('removeBioAndAgeBracketFields: safe to call again after cleanup already ran (idempotent — same call shape every time)', async () => {
  let callCount = 0;
  await withStubbedUpdateMany(async () => { callCount++; return { matchedCount: 0 }; }, async () => {
    await playerStore.removeBioAndAgeBracketFields();
    await playerStore.removeBioAndAgeBracketFields();
  });
  assert.equal(callCount, 2, 'each call issues its own cheap query — no crash, no duplicate-run guard needed since $unset on an absent field is already a no-op');
});

// ── #6: end-to-end — a fresh /matchmaker-setup run never posts a bio button anywhere ──────────
// Same require-cache-stub/fake-guild precedent as test/matchmaker-category-grouping.test.js, with
// one addition: channel.send captures its payload (that file's version discards it, since it only
// ever needed to inspect which channels were CREATED, not what was POSTED into them).
function withFakeGuildConfig(fn) {
  const guildConfigPath = require.resolve('../guild-config');
  const dependents = ['../matchmaker-setup', '../permissions', '../creative-channel'].map(require.resolve);
  const previousGuildConfig = require.cache[guildConfigPath];
  const previousDependents = dependents.map(p => require.cache[p]);

  delete require.cache[guildConfigPath];
  for (const p of dependents) delete require.cache[p];

  let current = { channelIds: {}, roleIds: {}, categoryIds: {}, creativeChannels: {}, setupMessageIds: {}, secrets: {} };
  const stub = {
    getGuildConfig: () => current,
    setGuildConfig: async (guildId, partial) => {
      current = {
        channelIds: { ...current.channelIds, ...partial.channelIds },
        roleIds: { ...current.roleIds, ...partial.roleIds },
        categoryIds: { ...current.categoryIds, ...partial.categoryIds },
        creativeChannels: {
          ...current.creativeChannels,
          ...Object.fromEntries(Object.entries(partial.creativeChannels ?? {}).map(([k, v]) => [k, { ...current.creativeChannels?.[k], ...v }])),
        },
        setupMessageIds: { ...current.setupMessageIds, ...partial.setupMessageIds },
        secrets: { ...current.secrets, ...partial.secrets },
      };
      return current;
    },
    getChannelId: (g, k) => current.channelIds?.[k] ?? null,
    getRoleId: (g, k) => current.roleIds?.[k] ?? null,
    getCategoryId: (g, k) => current.categoryIds?.[k] ?? null,
    getCreativeChannelInfo: (g, c) => current.creativeChannels?.[c] ?? null,
  };
  require.cache[guildConfigPath] = { id: guildConfigPath, filename: guildConfigPath, loaded: true, exports: stub };

  try {
    const { runMatchmakerSetup } = require('../matchmaker-setup');
    return fn(runMatchmakerSetup);
  } finally {
    delete require.cache[guildConfigPath];
    for (const p of dependents) delete require.cache[p];
    if (previousGuildConfig) require.cache[guildConfigPath] = previousGuildConfig;
    dependents.forEach((p, i) => { if (previousDependents[i]) require.cache[p] = previousDependents[i]; });
  }
}

function makeFakeGuild() {
  let idCounter = 0;
  const nextId = (prefix) => `${prefix}-${++idCounter}`;
  const rolesById = {};
  const channelsById = {};
  const sentPayloadsByChannelName = {};

  function makeChannel(name, type, parentId) {
    const id = nextId('chan');
    const channel = {
      id, name, type, parentId: parentId ?? null,
      permissionOverwrites: { edit: async () => {} },
      messages: { fetch: async () => { throw new Error('Unknown Message'); } },
      send: async (payload) => {
        (sentPayloadsByChannelName[name] ??= []).push(payload);
        return { id: nextId('msg'), pin: async () => {}, edit: async () => {} };
      },
      setParent: async (pid) => { channel.parentId = pid; },
      delete: async () => { throw new Error('unexpected delete'); },
      availableTags: [],
      setAvailableTags: async (tags) => {
        channel.availableTags = tags.map(t => ({ id: t.id ?? nextId('tag'), name: t.name }));
        return channel;
      },
    };
    return channel;
  }

  const guild = {
    id: 'guild-1',
    members: { me: { id: 'bot-id' } },
    roles: {
      everyone: { permissions: { remove: () => ({ bitfield: 0n }), bitfield: 0n }, setPermissions: async () => {} },
      fetch: async (id) => rolesById[id] ?? null,
      create: async ({ name }) => { const r = { id: nextId('role'), name, delete: async () => {} }; rolesById[r.id] = r; return r; },
    },
    channels: {
      fetch: async (id) => channelsById[id] ?? null,
      create: async ({ name, type, parent }) => {
        const c = makeChannel(name, type, parent ?? null);
        channelsById[c.id] = c;
        return c;
      },
    },
    client: { channels: { fetch: async (id) => channelsById[id] ?? null } },
  };

  return { guild, sentPayloadsByChannelName };
}

test('a fresh /matchmaker-setup run: #get-roles never posts an age-bracket select, and the second message never posts a bio button — only the platform select', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup) => {
    const { guild, sentPayloadsByChannelName } = makeFakeGuild();
    await runMatchmakerSetup(guild);

    // Both messages are posted into the same #get-roles channel (matchmaker-setup.js's
    // ensurePosted call for 'getRolesBio' explicitly targets channelIds.getRoles) — two payloads
    // land on the same channel name.
    const payloads = sentPayloadsByChannelName['get-roles'];
    assert.equal(payloads.length, 2, 'expected exactly 2 messages posted into #get-roles (the main roles message + the platform-select message)');

    const allCustomIds = payloads.flatMap(p => (p.components ?? []).flatMap(row => row.toJSON().components.map(c => c.custom_id)));
    assert.ok(!allCustomIds.includes('select_age_bracket'), 'no age-bracket select anywhere in what was actually posted');
    assert.ok(!allCustomIds.includes('set_bio'), 'no bio button anywhere in what was actually posted');
    assert.ok(allCustomIds.includes('select_platform'), 'the platform select must still be posted');
    assert.ok(allCustomIds.includes('select_region'), 'sanity check: the main roles message still posted normally');
  });
});
