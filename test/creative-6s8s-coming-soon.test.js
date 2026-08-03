// Verifies the revised 6s/8s handling: /matchmaker-setup creates creative-6s/creative-8s channels
// (unlike an earlier version of this change, which skipped creating them entirely), but posts
// embeds.js's buildCreativeComingSoonEmbed — no queue button, nothing to join — instead of the
// real queue embed, since 6s/8s is a planned premium feature not available during the current
// free-for-everyone period. 1v1/2v2 must be completely unaffected (real embed + buttons, as always).
//
// Also verifies the fix for the real deployed bug: a channel that was ALREADY set up before the
// coming-soon change shipped (still showing the old real queue embed + select-menu/button
// components) must get REPAIRED — its pinned message edited in place to the coming-soon embed with
// no components — both when /matchmaker-setup is re-run, AND via the one-time startup self-heal
// (creative-channel.js's repairComingSoonCreativeChannels, called from index.js's clientReady).
// Before this fix, ensureCreativeChannel's "already exists" branch returned early without ever
// touching an existing message's content, so a pre-existing 6s/8s channel kept its old real
// select-menus/buttons forever — clicking them still attempted a real queue join.
//
// Same withFakeGuildConfig/makeFakeGuild harness as test/matchmaker-category-grouping.test.js,
// extended so channels can be seeded with a pre-existing message (simulating "already set up
// before this feature shipped") and so channel.send/message.edit capture their payloads.
const test = require('node:test');
const assert = require('node:assert/strict');

// async + awaiting fn(...) below (rather than `return fn(...)`) is deliberate, not a style choice:
// `try { return somePromise; } finally { ... }` runs the finally block IMMEDIATELY once the
// (still-pending) promise is returned, NOT once it settles — so a bare `return fn(...)` restores
// require.cache while fn's own awaits (multiple runMatchmakerSetup calls, each with real
// microtask-level async work) are still in flight. Confirmed via a live repro: this let a LATER
// test's seeded "real queue" message data bleed into an EARLIER, already-finished-looking test's
// still-executing internals, producing a spurious repair log for a channel that test never touched.
// Awaiting here ensures the cache is only ever restored after fn has fully completed.
async function withFakeGuildConfig(fn) {
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
    const { runMatchmakerSetup, CREATIVE_CHANNEL_SPECS } = require('../matchmaker-setup');
    const { repairComingSoonCreativeChannels } = require('../creative-channel');
    return await fn(runMatchmakerSetup, () => current, CREATIVE_CHANNEL_SPECS, stub.setGuildConfig, repairComingSoonCreativeChannels);
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
  const createCalls = [];
  const sentPayloadsByChannelName = {};
  const editCalls = [];

  function makeChannel(name, type, parentId) {
    const id = nextId('chan');
    let currentMessage = null;

    const channel = {
      id, name, type, parentId: parentId ?? null,
      permissionOverwrites: { edit: async () => {} },
      messages: {
        fetch: async (msgId) => {
          if (currentMessage && currentMessage.id === msgId) return currentMessage;
          throw new Error('Unknown Message');
        },
      },
      send: async (payload) => {
        sentPayloadsByChannelName[name] = payload;
        currentMessage = {
          id: nextId('msg'),
          // Resolved to plain JSON, same as a REAL fetched discord.js Message's .embeds[] (whose
          // Embed.title is a direct getter, unlike EmbedBuilder — which only exposes .data.title)
          // — critical for ensureComingSoonCreativeChannel's alreadyComingSoon check below to be
          // exercised faithfully against this fake the same way it behaves against a real fetch.
          embeds: (payload.embeds ?? []).map(e => (e.toJSON ? e.toJSON() : e)),
          components: payload.components ?? [],
          async pin() {},
          async edit(editPayload) {
            editCalls.push({ channelName: name, payload: editPayload });
            currentMessage.embeds = (editPayload.embeds ?? currentMessage.embeds).map(e => (e.toJSON ? e.toJSON() : e));
            currentMessage.components = editPayload.components ?? currentMessage.components;
          },
        };
        return currentMessage;
      },
      setParent: async (pid) => { channel.parentId = pid; },
      delete: async () => { throw new Error('unexpected delete'); },
      // Test-only seam: directly plants a pre-existing pinned message on this channel, bypassing
      // send() — simulates "this channel was already set up before the coming-soon feature
      // existed" without polluting sentPayloadsByChannelName/createCalls (which the tests use to
      // assert what NEW actions happened during the run under test).
      _seedExistingMessage(payload) {
        currentMessage = {
          id: nextId('msg'),
          embeds: (payload.embeds ?? []).map(e => (e.toJSON ? e.toJSON() : e)),
          components: payload.components ?? [],
          async pin() {},
          async edit(editPayload) {
            editCalls.push({ channelName: name, payload: editPayload });
            currentMessage.embeds = (editPayload.embeds ?? currentMessage.embeds).map(e => (e.toJSON ? e.toJSON() : e));
            currentMessage.components = editPayload.components ?? currentMessage.components;
          },
        };
        return currentMessage.id;
      },
      // Forum-channel shape (matchmaker-setup.js's ensureTournamentForum) — every fake channel gets
      // this, not just the one actually created as a forum, since it's harmless on the others and
      // this file's tests aren't about the forum itself.
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
        createCalls.push({ name, type, parent: parent ?? null });
        return c;
      },
    },
    client: { channels: { fetch: async (id) => channelsById[id] ?? null } },
  };

  return { guild, rolesById, channelsById, createCalls, sentPayloadsByChannelName, editCalls, makeChannel };
}

function fakeRealQueuePayload() {
  return {
    embeds: [{ toJSON: () => ({ title: '🎮 Creative 6s Queue' }) }],
    components: [{ type: 1, components: [{ type: 3, custom_id: 'creative_mode_6s' }] }],
  };
}

test('matchmaker-setup: CREATIVE_CHANNEL_SPECS includes 6s and 8s again (channels are created, not skipped)', () => {
  return withFakeGuildConfig((runMatchmakerSetup, getCurrent, CREATIVE_CHANNEL_SPECS) => {
    const keys = CREATIVE_CHANNEL_SPECS.map(s => s.key);
    assert.ok(keys.includes('6s'), 'creative-6s must be created (not skipped) during /matchmaker-setup');
    assert.ok(keys.includes('8s'), 'creative-8s must be created (not skipped) during /matchmaker-setup');
    assert.ok(keys.includes('1v1'));
    assert.ok(keys.includes('2v2'));
  });
});

test('a fresh /matchmaker-setup run: creative-6s/creative-8s get created with a Coming Soon embed and NO components; creative-1v1/2v2 get the real queue embed with buttons', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent) => {
    const { guild, createCalls, sentPayloadsByChannelName } = makeFakeGuild();

    await runMatchmakerSetup(guild);

    assert.ok(createCalls.some(c => c.name === 'creative-6s'), 'creative-6s channel must actually be created');
    assert.ok(createCalls.some(c => c.name === 'creative-8s'), 'creative-8s channel must actually be created');

    for (const name of ['creative-6s', 'creative-8s']) {
      const payload = sentPayloadsByChannelName[name];
      assert.ok(payload, `expected a message to have been posted in #${name}`);
      assert.equal(payload.components, undefined, `#${name} must have no components (no queue button) — coming soon, nothing to join yet`);
      const embed = payload.embeds[0].toJSON();
      assert.match(embed.title, /coming soon/i, `#${name}'s embed should say Coming Soon`);
      assert.match(embed.description, /free trial coming soon/i, `#${name}'s embed should use the "Free trial coming soon" wording`);
    }

    for (const name of ['creative-1v1', 'creative-2v2']) {
      const payload = sentPayloadsByChannelName[name];
      assert.ok(payload, `expected a message to have been posted in #${name}`);
      assert.ok(payload.components && payload.components.length > 0, `#${name} must still have real queue components (unaffected by the 6s/8s change)`);
      const embed = payload.embeds[0].toJSON();
      assert.doesNotMatch(embed.title, /coming soon/i, `#${name} must not be treated as coming-soon`);
    }

    // The guild-config record persisted for 6s/8s must still exist (tracked like any other creative
    // channel), so a future launch just has to edit this message in place, not recreate anything.
    const saved = getCurrent();
    assert.ok(saved.creativeChannels['6s']?.channelId && saved.creativeChannels['6s']?.messageId);
    assert.ok(saved.creativeChannels['8s']?.channelId && saved.creativeChannels['8s']?.messageId);
  });
});

test('re-running /matchmaker-setup does not re-post or duplicate the coming-soon embed once it exists', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent) => {
    const { guild, createCalls } = makeFakeGuild();

    await runMatchmakerSetup(guild);
    const firstRunCreateCount = createCalls.filter(c => c.name === 'creative-6s').length;
    assert.equal(firstRunCreateCount, 1);

    await runMatchmakerSetup(guild);
    const secondRunCreateCount = createCalls.filter(c => c.name === 'creative-6s').length;
    assert.equal(secondRunCreateCount, 1, 're-running setup must not create a second creative-6s channel');
  });
});

test('THE ACTUAL BUG: an existing 6s channel from before the coming-soon change (real embed + real components already posted) gets REPAIRED to coming-soon when /matchmaker-setup is re-run', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent, CREATIVE_CHANNEL_SPECS, setGuildConfig) => {
    const { guild, editCalls } = makeFakeGuild();

    // Simulate a channel that was already fully set up back when 6s/8s still had the real queue
    // flow — created directly (bypassing runMatchmakerSetup) with a real embed+components message
    // already pinned, exactly like a live server hit by this bug would have.
    const existingChannel = await guild.channels.create({ name: 'creative-6s', type: 0, parent: null });
    const existingMessageId = existingChannel._seedExistingMessage(fakeRealQueuePayload());
    await setGuildConfig(guild.id, { creativeChannels: { '6s': { channelId: existingChannel.id, messageId: existingMessageId } } });

    await runMatchmakerSetup(guild);

    const repairEdit = editCalls.find(e => e.channelName === 'creative-6s');
    assert.ok(repairEdit, 'the pre-existing message must have been edited in place, not left untouched');
    assert.deepEqual(repairEdit.payload.components, [], 'the edit must strip the old real components — this is what stops the old select-menus/buttons from still working');
    const embed = repairEdit.payload.embeds[0].toJSON();
    assert.match(embed.title, /coming soon/i);

    // Fetch the (now-edited) message directly to confirm the channel's actual current state.
    const finalMsg = await existingChannel.messages.fetch(existingMessageId);
    assert.deepEqual(finalMsg.components, [], 'no components left on the message — nothing left to click that would attempt a real queue join');
  });
});

test('a SECOND /matchmaker-setup re-run does not re-edit a channel that is already showing the coming-soon embed (no needless API churn)', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent, CREATIVE_CHANNEL_SPECS, setGuildConfig) => {
    const { guild, editCalls } = makeFakeGuild();
    // Scoped to creative-6s/8s only — several OTHER channels (setup/getRoles/howto/register/
    // suggestions) are edited on EVERY /matchmaker-setup re-run by design (ensurePosted's existing,
    // unrelated "roll out wording changes" behavior), so a raw total editCalls.length would always
    // grow between runs regardless of whether this fix works.
    const creativeEditCount = () => editCalls.filter(e => e.channelName === 'creative-6s' || e.channelName === 'creative-8s').length;

    await runMatchmakerSetup(guild); // first run: creates creative-6s/8s fresh with the coming-soon embed already
    const creativeEditsAfterFirstRun = creativeEditCount();

    await runMatchmakerSetup(guild); // second run: should be a no-op for an already-correct channel
    assert.equal(creativeEditCount(), creativeEditsAfterFirstRun, 'a channel already showing coming-soon content must not be re-edited on every re-run');
  });
});

test('repairComingSoonCreativeChannels (startup self-heal): fixes an already-deployed 6s channel WITHOUT needing an admin to re-run /matchmaker-setup', () => {
  return withFakeGuildConfig(async (runMatchmakerSetup, getCurrent, CREATIVE_CHANNEL_SPECS, setGuildConfig, repairComingSoonCreativeChannels) => {
    const { guild, editCalls } = makeFakeGuild();

    const existingChannel = await guild.channels.create({ name: 'creative-8s', type: 0, parent: null });
    const existingMessageId = existingChannel._seedExistingMessage(fakeRealQueuePayload());
    await setGuildConfig(guild.id, { creativeChannels: { '8s': { channelId: existingChannel.id, messageId: existingMessageId } } });

    const fakeClient = { guilds: { cache: new Map([[guild.id, guild]]) } };
    await repairComingSoonCreativeChannels(fakeClient);

    const repairEdit = editCalls.find(e => e.channelName === 'creative-8s');
    assert.ok(repairEdit, 'the startup self-heal must edit the pre-existing real-queue message in place');
    assert.deepEqual(repairEdit.payload.components, []);
    assert.match(repairEdit.payload.embeds[0].toJSON().title, /coming soon/i);
  });
});
