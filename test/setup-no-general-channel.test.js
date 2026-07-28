// Verifies /matchmaker-setup never creates a "general" text/voice channel.
//
// Investigation before making any change found matchmaker-setup.js's CATEGORY_SPECS/
// CHANNEL_SPECS/CREATIVE_CHANNEL_SPECS already contain no such channel (confirmed by reading the
// real setup code, a repo-wide case-insensitive grep for "general" across every .js file, and
// `git log -S"general" -- matchmaker-setup.js` showing this file's history never added one) — so
// there was nothing to remove. This test locks in that invariant as a real regression guard against
// the actual exported specs matchmaker-setup.js uses to create channels (not a re-implementation
// of them), so it fails loudly if a "general" text/voice channel is ever reintroduced.
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');
const { CATEGORY_SPECS, CHANNEL_SPECS, CREATIVE_CHANNEL_SPECS } = require('../matchmaker-setup');

test('matchmaker-setup: no "general" channel/category in CHANNEL_SPECS, CATEGORY_SPECS, or CREATIVE_CHANNEL_SPECS', () => {
  const allSpecs = [...CHANNEL_SPECS, ...CATEGORY_SPECS, ...CREATIVE_CHANNEL_SPECS];
  const generalMatch = allSpecs.find(s => /general/i.test(s.key) || /general/i.test(s.name));

  assert.equal(generalMatch, undefined, `found an unexpected "general" spec: ${JSON.stringify(generalMatch)}`);
});

test('matchmaker-setup: setup never creates a voice channel (a "general voice channel" would have to be one)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'matchmaker-setup.js'), 'utf8');
  assert.equal(/GuildVoice/.test(source), false, 'matchmaker-setup.js should never create a voice channel');
});
