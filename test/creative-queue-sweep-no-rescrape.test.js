// Investigates a real hypothesis: a creative-queue entry stuck waiting 26+ hours (real confirmed
// case: waf_waf_/FortObs5, waited=96477s per production logs) — well past players.js's 24h stats
// cache TTL — might have its stats silently re-scraped by the periodic sweep every time it noticed
// the cache had gone stale, which would explain sustained Fortnite Tracker scraping traffic with no
// obvious external cause.
//
// Verdict: FALSE. creative-queue.js's attemptMatchingForQueue/sweepAllCreativeQueues never call
// playerStore.getStatsForContext (or any scraping function) at all — they only ever read
// unit.totalPR/unit.matchScore, values snapshotted exactly ONCE by buildCreativePlayer at
// joinCreativeQueue/requeueCreativeUnit time. This test proves that invariant directly: a real
// stuck unit, swept many times over a simulated 26+ hour stale wait, triggers getStatsForContext
// exactly once — at join — and never again. Kept as a permanent regression guard, not just a
// one-off investigation script, since a future change that added a "refresh stale queued players'
// stats" call inside the sweep would silently reintroduce exactly this risk (a single stuck entry
// causing a real scrape every ~sweep interval, indefinitely, for as long as it stays unmatched).
//
// (Separately confirmed, real, but different bug: config.js's creativeWideningSchedule has no
// unlimited final tier — unlike tournamentWideningSchedule's Infinity tier — so a genuine PR
// outlier can legitimately never get matched no matter how long they wait. That's the real
// explanation for the specific 26+ hour stuck case; this file only covers the re-scrape hypothesis.)
const test = require('node:test');
const assert = require('node:assert/strict');

const creativeQueue = require('../creative-queue');
const playerStore = require('../players');

function makeMemberArgs(discordId, mode) {
  return {
    guildId: 'g1', guildName: 'Test Guild', discordId, discordUsername: discordId, discordTag: discordId,
    epicUsername: discordId, epicId: discordId, mode, region: 'EU', platform: 'PC',
  };
}

test('creative-queue sweep: a queued player\'s stats are fetched exactly ONCE at join time — never re-fetched by the sweep, even across many ticks over a simulated 26+ hour stale wait', async () => {
  const originalGetStatsForContext = playerStore.getStatsForContext;
  const originalGetPlayer = playerStore.getPlayer;
  let getPlayerStatsCalls = 0;
  playerStore.getStatsForContext = async () => {
    getPlayerStatsCalls++;
    return {
      stats: { totalPR: 500, thisSeasonPR: 50, recentEvents: [] },
      prContext: { region: 'EU', platformSegment: 'all', isHomeRegion: true, isHomePlatform: true },
    };
  };
  playerStore.getPlayer = async () => ({ region: 'EU' });

  // Unique mode string per run — an isolated pool with no one else queued, so this unit genuinely
  // stays queued (unmatched) for the whole test, same as the real stuck-forever case.
  const mode = `1v1 Realistics ${Math.random()}`;

  try {
    const player = await creativeQueue.buildCreativePlayer(makeMemberArgs('stuck-player', mode));
    const { unit } = creativeQueue.joinCreativeQueue({ guildId: 'g1', player, mode, region: 'EU' });

    assert.equal(getPlayerStatsCalls, 1, 'exactly one real fetch, at join time');

    // Simulate the real reported scenario directly: this exact unit has now been waiting 96477s
    // (~26.8h) — well past the 24h cache TTL that would make its snapshot "stale" if anything ever
    // re-checked it.
    unit.joinedAt = new Date(Date.now() - 96477 * 1000);

    // Multiple sweep ticks — the same function config.matchSweepIntervalSeconds's setInterval
    // calls repeatedly in production.
    for (let i = 0; i < 10; i++) {
      creativeQueue.sweepAllCreativeQueues();
    }

    assert.equal(
      getPlayerStatsCalls, 1,
      '10 more sweep ticks over a simulated 26+ hour stale wait must NOT trigger any additional stats fetch — the sweep only ever reads unit.totalPR/matchScore, snapshotted once at join'
    );
  } finally {
    creativeQueue.removeFromCreativeQueueAnywhere('g1', 'stuck-player');
    playerStore.getStatsForContext = originalGetStatsForContext;
    playerStore.getPlayer = originalGetPlayer;
  }
});

// ── The real, separate bug: no unlimited widening tier for creative ──────────────────────────
test('creative-queue: getCreativeWideningTier permanently caps at maxLogPRDiff:60 — confirms the real explanation for a genuine PR outlier waiting forever, no eventual unlimited tier the way tournaments get', () => {
  const at25s = creativeQueue.getCreativeWideningTier(25);
  const at1Hour = creativeQueue.getCreativeWideningTier(3600);
  const at27Hours = creativeQueue.getCreativeWideningTier(96477); // the real reported wait

  assert.equal(at25s.maxLogPRDiff, 60);
  assert.equal(at1Hour.maxLogPRDiff, 60, 'no widening at all beyond the 25s tier — 1 hour waited gets the exact same cap as 25 seconds');
  assert.equal(at27Hours.maxLogPRDiff, 60, 'even 26.8 real hours waited never widens further — this is genuinely a permanent, not just slow-to-open, ceiling');
  assert.notEqual(at27Hours.maxLogPRDiff, Infinity, 'unlike tournamentWideningSchedule, creative never reaches an unlimited tier at all');
});
