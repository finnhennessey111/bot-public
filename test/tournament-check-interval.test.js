// Verifies the tournament calendar check interval was actually widened from 20 minutes to 4
// hours (channel-manager.js's startScheduler, the setInterval driving runTournamentCheckTick).
// Reasoning: every detected tournament already sits behind tournament-approval.js's manual
// DM-approval gate before it goes live anywhere, so scrape cadence was never the bottleneck for
// real-world responsiveness — approval turnaround is. "Run immediately on startup" is unrelated
// to this interval and stays unchanged.
//
// Deliberately does NOT call the real startScheduler() — it would trigger a real live
// Puppeteer scrape immediately (scrapeUpcomingTournaments is a destructured import, so it can't be
// monkey-patched the way a namespace import can — same limitation documented in
// test/tournament-approval.test.js for discord-dm.js's dmUser), which is slow, network-dependent,
// and irrelevant to what this file actually verifies: the interval VALUE and that the scheduling
// code genuinely uses it (not a stray hardcoded number left behind).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const channelManager = require('../channel-manager');

test('channel-manager: TOURNAMENT_CHECK_INTERVAL_MS is 4 hours (widened from the old 20 minutes)', () => {
  assert.equal(channelManager.TOURNAMENT_CHECK_INTERVAL_MS, 4 * 60 * 60 * 1000);
});

test('channel-manager: startScheduler\'s tournament-check setInterval genuinely uses TOURNAMENT_CHECK_INTERVAL_MS, not a stray hardcoded value (static check on the real source)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'channel-manager.js'), 'utf8');

  const tickMatch = source.match(/await runTournamentCheckTick\(client, pinnedMessages\);\s*\n\s*\}, (\S+)\);/);
  assert.ok(tickMatch, 'expected to find the setInterval call driving runTournamentCheckTick');
  assert.equal(tickMatch[1], 'TOURNAMENT_CHECK_INTERVAL_MS', 'the tournament-check tick\'s setInterval must use the named constant, not an inline magic number');

  // No stray "20 * 60 * 1000" (the old value) left wired into this specific interval.
  assert.ok(!/runTournamentCheckTick[\s\S]{0,200}20 \* 60 \* 1000/.test(source), 'the old 20-minute value must not still be wired anywhere near the tournament-check tick');
});

test('channel-manager: "run immediately on startup" is unchanged — still calls runTournamentCheckTick synchronously before any interval is armed', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'channel-manager.js'), 'utf8');
  const startSchedulerBody = source.slice(source.indexOf('function startScheduler'), source.indexOf('module.exports'));

  const immediateCallIndex = startSchedulerBody.indexOf('runTournamentCheckTick(client, pinnedMessages);');
  const firstIntervalIndex = startSchedulerBody.indexOf('setInterval(');

  assert.ok(immediateCallIndex !== -1, 'expected an immediate (non-awaited-in-interval) runTournamentCheckTick call');
  assert.ok(immediateCallIndex < firstIntervalIndex, 'the immediate startup call must still happen before any setInterval is armed');
});
