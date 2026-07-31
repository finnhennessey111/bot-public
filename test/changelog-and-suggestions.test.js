// Verifies item 4's two pieces:
//   - changelog.js / models/Changelog.js — the global "Recent Updates" feed shown in every
//     guild's #setup embed, and matchmaker-setup.js's refreshAllSetupEmbeds (pushed live by
//     index.js's /post-update rather than waiting on each server's admins to re-run setup).
//   - suggestions.js / models/Suggestion.js — centralized suggest-a-feature capture: every
//     submission is stored AND forwarded to the developer via a DM (discord-dm.js's dmUser).
//
// No real MongoDB is configured in this environment — same precedent as
// test/store-selective-persistence.test.js: the real Mongoose Model classes' methods
// (create/find/sort/limit/lean) are monkey-patched directly, so the actual production
// changelog.js/suggestions.js/matchmaker-setup.js code runs completely unmodified, only the
// network I/O boundary is stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const ChangelogModel = require('../models/Changelog');
const SuggestionModel = require('../models/Suggestion');
const GuildModel = require('../models/Guild');

const changelog = require('../changelog');
const suggestions = require('../suggestions');
const guildConfig = require('../guild-config');
const matchmakerSetup = require('../matchmaker-setup');

function stubChangelogFind(docs) {
  const original = ChangelogModel.find;
  ChangelogModel.find = () => ({
    sort: () => ({
      limit: () => ({
        lean: async () => docs,
      }),
    }),
  });
  return () => { ChangelogModel.find = original; };
}

test('changelog.postUpdate: creates a doc with the given text and postedBy', async () => {
  const calls = [];
  const original = ChangelogModel.create;
  ChangelogModel.create = async (doc) => { calls.push(doc); return doc; };
  try {
    await changelog.postUpdate('Added Ranked Cup per-rank queues', 'owner-id-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, 'Added Ranked Cup per-rank queues');
    assert.equal(calls[0].postedBy, 'owner-id-1');
  } finally {
    ChangelogModel.create = original;
  }
});

test('changelog.getRecentEntries: returns whatever the capped/sorted Mongo query yields', async () => {
  const fakeDocs = [{ text: 'Newest', createdAt: new Date() }, { text: 'Older', createdAt: new Date() }];
  const restore = stubChangelogFind(fakeDocs);
  try {
    const entries = await changelog.getRecentEntries();
    assert.deepEqual(entries, fakeDocs);
  } finally {
    restore();
  }
});

test('changelog.getRecentEntries: a Mongo failure returns [] rather than throwing (never blocks #setup from posting)', async () => {
  const original = ChangelogModel.find;
  ChangelogModel.find = () => { throw new Error('Mongo unavailable'); };
  try {
    const entries = await changelog.getRecentEntries();
    assert.deepEqual(entries, []);
  } finally {
    ChangelogModel.find = original;
  }
});

test('buildSetupInstructionsEmbed: renders a "Recent Updates" field from real changelog entries, omits it when empty', () => {
  const { buildSetupInstructionsEmbed } = require('../embeds');

  const withNone = buildSetupInstructionsEmbed([]).toJSON();
  assert.ok(!withNone.fields.some(f => /recent updates/i.test(f.name)), 'no changelog entries -> no field at all');

  const withEntries = buildSetupInstructionsEmbed([
    { text: 'Ranked Cup queues now split by rank', createdAt: new Date() },
  ]).toJSON();
  const field = withEntries.fields.find(f => /recent updates/i.test(f.name));
  assert.ok(field, 'expected a Recent Updates field');
  assert.match(field.value, /Ranked Cup queues now split by rank/);
});

test('matchmaker-setup.refreshAllSetupEmbeds: edits every guild\'s already-posted #setup message with the latest changelog, skips guilds with no #setup message', async () => {
  const restoreFind = stubChangelogFind([{ text: 'New suggestion channel added', createdAt: new Date() }]);
  const guildUpdateOneOriginal = GuildModel.updateOne;
  GuildModel.updateOne = async () => ({});

  const edits = [];
  try {
    const configuredGuildId = `guild_configured_${Math.random()}`;
    const unconfiguredGuildId = `guild_unconfigured_${Math.random()}`;

    await guildConfig.setGuildConfig(configuredGuildId, {
      channelIds: { setup: 'setup-channel-1' },
      setupMessageIds: { setup: 'setup-message-1' },
    });
    // unconfiguredGuildId deliberately gets no setGuildConfig call — simulates a guild that has
    // never run /matchmaker-setup at all (getGuildConfig falls back to emptyConfig()).

    const fakeGuilds = new Map([
      [configuredGuildId, {
        id: configuredGuildId,
        channels: {
          async fetch(channelId) {
            assert.equal(channelId, 'setup-channel-1');
            return {
              messages: {
                async fetch(messageId) {
                  assert.equal(messageId, 'setup-message-1');
                  return { async edit(payload) { edits.push({ guildId: configuredGuildId, payload }); } };
                },
              },
            };
          },
        },
      }],
      [unconfiguredGuildId, {
        id: unconfiguredGuildId,
        channels: { async fetch() { throw new Error('must not be called — this guild has no #setup message'); } },
      }],
    ]);

    const fakeClient = { guilds: { cache: fakeGuilds } };

    const refreshedCount = await matchmakerSetup.refreshAllSetupEmbeds(fakeClient);

    assert.equal(refreshedCount, 1, 'only the configured guild should have been refreshed');
    assert.equal(edits.length, 1);
    assert.equal(edits[0].guildId, configuredGuildId);
    const embedJson = edits[0].payload.embeds[0].toJSON ? edits[0].payload.embeds[0].toJSON() : edits[0].payload.embeds[0];
    const field = embedJson.fields.find(f => /recent updates/i.test(f.name));
    assert.match(field.value, /New suggestion channel added/);
  } finally {
    GuildModel.updateOne = guildUpdateOneOriginal;
    restoreFind();
  }
});

test('suggestions.recordSuggestion: stores guild/discord identity, text, and timestamp fields', async () => {
  const calls = [];
  const original = SuggestionModel.create;
  SuggestionModel.create = async (doc) => { calls.push(doc); return doc; };
  try {
    await suggestions.recordSuggestion({
      guildId: 'g1', guildName: 'Test Guild', discordId: 'u1', discordTag: 'user#0001', text: 'Add trios ranked cups',
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      guildId: 'g1', guildName: 'Test Guild', discordId: 'u1', discordTag: 'user#0001', text: 'Add trios ranked cups',
    });
  } finally {
    SuggestionModel.create = original;
  }
});

// discord-dm.js's dmUser is destructured at require time inside suggestions.js (`const { dmUser }
// = require('./discord-dm')`), so monkey-patching discord-dm's exported property (the trick used
// for the Mongoose Models above) would silently miss the already-bound local reference. Instead
// this stubs at the real boundary dmUser itself calls: client.users.fetch(id).send(payload) — the
// actual Discord API surface, one level down.
function makeFakeDmClient() {
  const sent = [];
  const client = {
    users: {
      async fetch(discordId) {
        return { async send(payload) { sent.push({ discordId, payload }); } };
      },
    },
  };
  return { client, sent };
}

test('suggestions.forwardSuggestionToOwner: DMs BOT_OWNER_DISCORD_ID with the suggestion content', async () => {
  // suggestions.js reads BOT_OWNER_DISCORD_ID from process.env once at require time, so this test
  // exercises the module's exported constant directly rather than re-requiring with a different env.
  if (!suggestions.BOT_OWNER_DISCORD_ID) {
    // Environment-dependent: without BOT_OWNER_DISCORD_ID set, forwardSuggestionToOwner is a no-op
    // by design (see its own guard) — covered by the next test instead.
    return;
  }

  const { client, sent } = makeFakeDmClient();
  await suggestions.forwardSuggestionToOwner(client, {
    guildName: 'Test Guild', discordId: 'u1', discordTag: 'user#0001', text: 'Add trios ranked cups',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].discordId, suggestions.BOT_OWNER_DISCORD_ID);
  const embed = sent[0].payload.embeds[0];
  assert.match(embed.description, /Add trios ranked cups/);
  assert.match(embed.fields.find(f => f.name === 'Server').value, /Test Guild/);
  assert.match(embed.fields.find(f => f.name === 'From').value, /user#0001/);
});

test('suggestions.forwardSuggestionToOwner: with no BOT_OWNER_DISCORD_ID configured, does not throw and does not DM', async () => {
  if (suggestions.BOT_OWNER_DISCORD_ID) return; // covered by the previous test in that environment

  const { client, sent } = makeFakeDmClient();
  await suggestions.forwardSuggestionToOwner(client, { guildName: 'G', discordId: 'u1', discordTag: 't', text: 'x' });
  assert.equal(sent.length, 0, 'must not attempt a DM with no configured owner ID');
});
