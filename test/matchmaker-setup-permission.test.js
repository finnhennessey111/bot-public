// Verifies the /matchmaker-setup permission fix: it used to be locked to Discord's Administrator
// permission via register-commands.js's setDefaultMemberPermissions, which in practice only the
// server owner holds on a fresh server. Investigation found this codebase already has a real
// per-guild "MatchMaker Mod" role concept (permissions.js's isModMember, used at runtime by every
// other "[Mod]" command in index.js) — but a Discord-level setDefaultMemberPermissions bitfield
// can't reference a custom per-guild role at all, so the fix moves the check to runtime instead
// (same architecture the other mod commands already use) and falls back to Manage Server for a
// brand new server where the Mod role doesn't exist yet (matchmaker-setup itself is what creates
// it).
//
// isModMember was moved from index.js into permissions.js specifically so it's independently
// testable here — index.js can't be required directly in a test (client.login() side effect on
// load, same constraint documented in test/epic-link-gate.test.js). guild-config.js is stubbed at
// the require-cache level purely to control what getRoleId returns without hitting MongoDB (this
// session's established precedent, e.g. test/team-redesign.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');

function withStubbedGuildConfig(stubExports, fn) {
  const guildConfigPath = require.resolve('../guild-config');
  const permissionsPath = require.resolve('../permissions');
  const previous = require.cache[guildConfigPath];
  delete require.cache[guildConfigPath];
  delete require.cache[permissionsPath];

  require.cache[guildConfigPath] = { id: guildConfigPath, filename: guildConfigPath, loaded: true, exports: stubExports };

  try {
    const permissions = require('../permissions');
    return fn(permissions);
  } finally {
    delete require.cache[guildConfigPath];
    delete require.cache[permissionsPath];
    if (previous) require.cache[guildConfigPath] = previous;
  }
}

function fakeInteraction(memberRoleIds) {
  return { member: { roles: { cache: { has: (id) => memberRoleIds.includes(id) } } } };
}

test('register-commands.js: /matchmaker-setup no longer sets default_member_permissions (was Administrator-only)', () => {
  const { registerCommands } = require('../register-commands');
  assert.equal(typeof registerCommands, 'function'); // sanity: module still loads/exports fine

  const source = fs.readFileSync(path.join(__dirname, '..', 'register-commands.js'), 'utf8');
  const setupBlockMatch = source.match(/\.setName\('matchmaker-setup'\)[\s\S]*?(?=new SlashCommandBuilder|\]\.map)/);
  assert.ok(setupBlockMatch, 'could not locate the matchmaker-setup command builder in register-commands.js');
  assert.doesNotMatch(setupBlockMatch[0], /setDefaultMemberPermissions/, 'matchmaker-setup must not hard-code a Discord permission bit anymore — it is gated at runtime');
});

test('isModMember: a member holding the configured MatchMaker Mod role passes', () => {
  withStubbedGuildConfig({ getRoleId: (guildId, key) => (key === 'mod' ? 'mod-role-id' : null) }, (permissions) => {
    const interaction = fakeInteraction(['mod-role-id']);
    assert.equal(permissions.isModMember('guild1', interaction), true);
  });
});

test('isModMember: a member without the Mod role fails, even if some other role is configured', () => {
  withStubbedGuildConfig({ getRoleId: (guildId, key) => (key === 'mod' ? 'mod-role-id' : null) }, (permissions) => {
    const interaction = fakeInteraction(['some-other-role']);
    assert.equal(permissions.isModMember('guild1', interaction), false);
  });
});

test('isModMember: false when no Mod role is configured for the guild at all (brand new server)', () => {
  withStubbedGuildConfig({ getRoleId: () => null }, (permissions) => {
    const interaction = fakeInteraction(['anything']);
    assert.equal(permissions.isModMember('guild1', interaction), false);
  });
});

// The actual /matchmaker-setup gate is `!isModMember(...) && !hasManageGuild` (index.js) — verified
// here as a real, self-contained predicate (same two real inputs the handler uses: isModMember's
// real result, and a real PermissionsBitField#has(ManageGuild) check) rather than a source grep,
// since the whole point is proving the OR-of-two-conditions behavior actually works.
function canRunMatchmakerSetup(isMod, memberPermissions) {
  const hasManageGuild = !!memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  return isMod || hasManageGuild;
}

test('a member with Manage Server (but no Mod role, no role configured yet) CAN run /matchmaker-setup — the fresh-server bootstrap case', () => {
  withStubbedGuildConfig({ getRoleId: () => null }, (permissions) => {
    const interaction = fakeInteraction([]);
    const isMod = permissions.isModMember('guild1', interaction);
    const memberPermissions = new (require('discord.js').PermissionsBitField)(PermissionFlagsBits.ManageGuild);
    assert.equal(canRunMatchmakerSetup(isMod, memberPermissions), true);
  });
});

test('a member with the MatchMaker Mod role (but no Manage Server) CAN run /matchmaker-setup', () => {
  withStubbedGuildConfig({ getRoleId: (guildId, key) => (key === 'mod' ? 'mod-role-id' : null) }, (permissions) => {
    const interaction = fakeInteraction(['mod-role-id']);
    const isMod = permissions.isModMember('guild1', interaction);
    const memberPermissions = new (require('discord.js').PermissionsBitField)(0n); // no permissions at all
    assert.equal(canRunMatchmakerSetup(isMod, memberPermissions), true);
  });
});

test('a member with neither the Mod role nor Manage Server CANNOT run /matchmaker-setup', () => {
  withStubbedGuildConfig({ getRoleId: (guildId, key) => (key === 'mod' ? 'mod-role-id' : null) }, (permissions) => {
    const interaction = fakeInteraction(['some-unrelated-role']);
    const isMod = permissions.isModMember('guild1', interaction);
    const memberPermissions = new (require('discord.js').PermissionsBitField)(PermissionFlagsBits.SendMessages); // some unrelated permission
    assert.equal(canRunMatchmakerSetup(isMod, memberPermissions), false);
  });
});

test('index.js: the real /matchmaker-setup handler wires up isModMember and ManageGuild before calling runMatchmakerSetup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const handlerMatch = source.match(/commandName === 'matchmaker-setup'\)\s*{[\s\S]*?runMatchmakerSetup/);
  assert.ok(handlerMatch, 'could not locate the /matchmaker-setup handler in index.js');
  assert.match(handlerMatch[0], /isModMember\(interaction\.guild\.id, interaction\)/);
  assert.match(handlerMatch[0], /PermissionFlagsBits\.ManageGuild/);
});
