// Verifies the fix for a real double-join race in index.js's tournament duo/lf2 handler: unlike
// the creative and team queue handlers (which guard with creativeJoinInProgress/teamJoinInProgress
// Sets — see index.js), the tournament handler used to check "already queued?" once and only then
// await Epic identity resolution + buildPlayer (a real scrape that can take up to ~60s with
// retries) before pushing the new unit. Two near-simultaneous clicks (a double-click, or Discord
// redelivering the interaction) both passed the initial check, both scraped, and both landed as
// separate queue units carrying the same discordId — letting attemptMatchingForQueue match a
// player against their own second unit, and a single accept then satisfying acceptMatch's every()
// check trivially (the same discordId appears twice in match.players), silently "confirming" a
// match between one person and themselves.
//
// index.js itself can't be required directly in a test (it calls client.login() as a side effect
// of loading) — see test/epic-link-gate.test.js for the established precedent. This reimplements
// the exact gate sequence index.js's queue_duo/queue_lf2 handler now runs — existingTournamentUnit
// check, then the new tournamentJoinInProgress Set check/add (same shape as the real
// creativeJoinInProgress/teamJoinInProgress Sets), THEN the slow buildPlayer scrape, THEN
// joinQueue, with the Set entry released in a finally — using queue.js's real, unmodified
// findUnitByDiscordId/joinQueue for the actual unit bookkeeping. buildPlayer is stood in by a
// controllable-delay stub (real Puppeteer scrape isn't exercised here — that's
// scraper-resource-blocking.test.js's job) so two "clicks" can actually race the way they would
// across a real multi-second-to-60s scrape.
const test = require('node:test');
const assert = require('node:assert/strict');

const { findUnitByDiscordId, joinQueue, removeFromQueueAnywhere, getQueueCount } = require('../queue');

function makeJoinSimulator() {
  const tournamentJoinInProgress = new Set();

  return async function simulateJoin({ guildId, discordId, tournamentName, region, queueType, scrapeDelayMs }) {
    const joinKey = `${guildId}:${discordId}`;

    const existingUnit = findUnitByDiscordId(guildId, discordId);
    if (existingUnit) return { blocked: 'already_queued' };

    if (tournamentJoinInProgress.has(joinKey)) return { blocked: 'mid_join' };

    tournamentJoinInProgress.add(joinKey);
    try {
      await new Promise(r => setTimeout(r, scrapeDelayMs)); // stands in for the real resolveEpicIdentity + buildPlayer scrape
      const player = makePlayer(discordId, tournamentName, region, queueType);
      const { unit } = await joinQueue({ guildId, players: [player], tournamentName, region, queueType });
      return { blocked: null, unit };
    } finally {
      tournamentJoinInProgress.delete(joinKey);
    }
  };
}

function makePlayer(discordId, tournamentName, region, queueType) {
  return {
    guildId: 'g1',
    guildName: 'Test Guild',
    discordId,
    discordUsername: discordId,
    discordTag: discordId,
    epicUsername: discordId,
    epicId: discordId,
    tournamentName,
    homeRegion: region,
    queueRegion: region,
    queueType,
    platform: 'PC',
    consoleOnly: false,
    ingameRoles: [],
    languages: [],
    totalPR: 500,
    thisSeasonPR: 0,
    matchScore: 500,
    soloModifier: 0,
    recentEvents: [],
    joinedAt: new Date(),
  };
}

test('tournament join race: two near-simultaneous joins from the same discordId produce exactly one unit', async () => {
  const simulateJoin = makeJoinSimulator();
  const guildId = `g_${Math.random()}`;
  const tournamentName = `Race Test Tournament ${Math.random()}`;
  const region = 'EU';
  const discordId = 'racer-1';
  const joinArgs = { guildId, discordId, tournamentName, region, queueType: 'duo', scrapeDelayMs: 50 };

  try {
    // Fired back-to-back, before either has resolved its (simulated) scrape — this is the actual
    // double-click / redelivered-interaction race.
    const [resultA, resultB] = await Promise.all([simulateJoin(joinArgs), simulateJoin(joinArgs)]);
    const outcomes = [resultA, resultB];

    assert.equal(outcomes.filter(r => r.blocked === null).length, 1, 'exactly one of the two near-simultaneous joins should succeed');
    assert.equal(outcomes.filter(r => r.blocked === 'mid_join').length, 1, 'the other should be rejected as mid-join, not silently allowed through');

    const found = findUnitByDiscordId(guildId, discordId);
    assert.ok(found, 'the successful join should have actually landed a unit');
    assert.equal(found.unit.members.length, 1, 'exactly one member on the surviving unit');

    // The actual bug this test guards against: a second unit for the same discordId, which would
    // let attemptMatchingForQueue match this player against their own second unit.
    assert.equal(
      getQueueCount(guildId, tournamentName, region), 1,
      'total queued player count for this tournament/region must be 1, not 2 — the whole point of the lock'
    );
  } finally {
    removeFromQueueAnywhere(guildId, discordId);
  }
});

test('tournament join race: a single, non-racing join is completely unaffected by the lock', async () => {
  const simulateJoin = makeJoinSimulator();
  const guildId = `g_${Math.random()}`;
  const tournamentName = `Solo Test Tournament ${Math.random()}`;
  const region = 'EU';
  const discordId = 'solo-1';
  const joinArgs = { guildId, discordId, tournamentName, region, queueType: 'duo', scrapeDelayMs: 20 };

  try {
    const result = await simulateJoin(joinArgs);

    assert.equal(result.blocked, null, 'a normal, non-racing join must still succeed');
    assert.ok(result.unit);

    const found = findUnitByDiscordId(guildId, discordId);
    assert.ok(found);
    assert.equal(found.unit.members.length, 1);

    // The lock must be released after a successful join, not left stuck forever — leave the
    // queue (as a real player would via leave_queue), then confirm the same discordId can rejoin
    // immediately. If the finally block's tournamentJoinInProgress.delete() didn't run, this
    // would wrongly come back 'mid_join'.
    removeFromQueueAnywhere(guildId, discordId);
    const rejoin = await simulateJoin(joinArgs);
    assert.equal(rejoin.blocked, null, 'the lock must not leak past a completed join — a genuine rejoin must not be stuck as mid-join');
  } finally {
    removeFromQueueAnywhere(guildId, discordId);
  }
});
