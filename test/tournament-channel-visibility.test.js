// Verifies requirement 1's channel-visibility half: every tournament channel (any region,
// console-only or not) is visible to @everyone at creation time — region/console Discord roles no
// longer gate ViewChannel, even when those roles ARE configured for the guild. Queueing itself
// still requires the Registered role (unchanged, tested separately by inspecting the real
// index.js source below, since index.js can't be required directly in a test — it calls
// client.login() as a side effect of loading, same constraint documented in
// test/epic-link-gate.test.js).
//
// Exercises the real createTournamentChannel (not a reimplementation) against a fake Discord
// guild, same precedent as test/tournament-channel-rename.test.js. guild-config.js is stubbed at
// the require-cache level (test/team-redesign.test.js's precedent) purely to control what
// getRoleId/getCategoryId return without hitting MongoDB — createTournamentChannel's own
// permission-overwrite logic under test is untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');

const VIEW_CHANNEL = PermissionFlagsBits.ViewChannel;

function withStubbedGuildConfig(stubExports, fn) {
  const guildConfigPath = require.resolve('../guild-config');
  const channelManagerPath = require.resolve('../channel-manager');
  const previous = require.cache[guildConfigPath];
  delete require.cache[guildConfigPath];
  delete require.cache[channelManagerPath];

  require.cache[guildConfigPath] = {
    id: guildConfigPath, filename: guildConfigPath, loaded: true, exports: stubExports,
  };

  try {
    const channelManager = require('../channel-manager');
    return fn(channelManager);
  } finally {
    delete require.cache[guildConfigPath];
    delete require.cache[channelManagerPath];
    if (previous) require.cache[guildConfigPath] = previous;
  }
}

function makeFakeGuild() {
  let capturedOverwrites = null;
  const guild = {
    id: 'guild1',
    roles: { everyone: 'everyone-role-id' },
    client: { user: { id: 'bot-id' } },
    channels: {
      cache: { find: () => undefined }, // no existing channel — always the "create new" path
      fetch: async () => null,
      async create({ name, permissionOverwrites }) {
        capturedOverwrites = permissionOverwrites;
        return {
          id: '9999',
          name,
          async send() { return { id: 'msg-1', async pin() {} }; },
        };
      },
    },
  };
  return { guild, getCapturedOverwrites: () => capturedOverwrites };
}

function futureIso(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
}

function baseTournament(overrides = {}) {
  return {
    name: 'Some Cup',
    region: 'EU',
    beginTime: futureIso(20),
    lastBeginTime: futureIso(20),
    isTrios: false,
    consoleOnly: false,
    isPermanent: false,
    eventId: 'epicgames_somecup_EU',
    ...overrides,
  };
}

test('createTournamentChannel: @everyone gets ViewChannel even when NO region/console/mod role is configured at all', async () => {
  await withStubbedGuildConfig(
    { getRoleId: () => null, getCategoryId: () => null },
    async (channelManager) => {
      const { guild, getCapturedOverwrites } = makeFakeGuild();
      await channelManager.createTournamentChannel(guild, baseTournament(), {});

      const overwrites = getCapturedOverwrites();
      const everyoneOverwrite = overwrites.find(o => o.id === guild.roles.everyone);
      assert.ok(everyoneOverwrite, '@everyone must have an explicit overwrite');
      assert.ok(everyoneOverwrite.allow?.includes(VIEW_CHANNEL), 'ViewChannel must be allowed for @everyone');
      assert.equal(everyoneOverwrite.deny?.includes(VIEW_CHANNEL) ?? false, false, '@everyone must NOT have ViewChannel denied');

      clearTimeout(channelManager.managedChannels['9999']?.deleteTimer);
    }
  );
});

test('createTournamentChannel: @everyone STILL gets ViewChannel for a console-only tournament even when a Console role IS configured', async () => {
  await withStubbedGuildConfig(
    { getRoleId: (guildId, key) => (key === 'Console' ? 'console-role-id' : (key === 'mod' ? 'mod-role-id' : null)), getCategoryId: () => null },
    async (channelManager) => {
      const { guild, getCapturedOverwrites } = makeFakeGuild();
      await channelManager.createTournamentChannel(guild, baseTournament({ consoleOnly: true, eventId: 'epicgames_consolecup_EU' }), {});

      const overwrites = getCapturedOverwrites();
      const everyoneOverwrite = overwrites.find(o => o.id === guild.roles.everyone);
      assert.ok(everyoneOverwrite);
      assert.ok(everyoneOverwrite.allow?.includes(VIEW_CHANNEL), '@everyone must see a console-only tournament channel too');

      // The old behavior would have added an allow-overwrite keyed to the Console role instead of
      // @everyone — confirm that per-role gate is gone, not just that @everyone happens to also
      // have access now.
      const consoleRoleOverwrite = overwrites.find(o => o.id === 'console-role-id');
      assert.equal(consoleRoleOverwrite, undefined, 'no per-role Console overwrite should be added anymore');

      // mod role overwrite should still exist — that part is unrelated to region/console gating.
      const modOverwrite = overwrites.find(o => o.id === 'mod-role-id');
      assert.ok(modOverwrite, 'mod role should still get an explicit overwrite');

      clearTimeout(channelManager.managedChannels['9999']?.deleteTimer);
    }
  );
});

// The Registered-role queue gate (a different thing entirely — requirement 1 keeps this) and the
// removal of the console-role queue-blocking check are both verified at the source level: index.js
// can't be required directly in a test (client.login() side effect on load — same constraint
// test/epic-link-gate.test.js documents), so this greps the real handler source instead of
// re-implementing its control flow.
test('index.js: queue_duo/lf2 handler still requires the Registered role before queueing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(source, /Complete your profile in.*first \(set your region\)/);
  assert.match(source, /getRoleId\(guild\.id, 'Registered'\)/);
});

test('index.js: the console-role queue-blocking check (isPCPlayer/isConsolePlayer) is gone', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.doesNotMatch(source, /isPCPlayer/);
  assert.doesNotMatch(source, /isConsolePlayer/);
  assert.doesNotMatch(source, /console-only tournament\. (PC players cannot|You must have the Console role)/);
});
