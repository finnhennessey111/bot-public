// Verifies the real change: creative-queue.js's 1v1 and 2v2 modes used to be scored IDENTICALLY —
// buildCreativePlayer always passed the creative mode string as computeMatchScoreBreakdown's
// tournamentName (which never matches a real scraped event, so ownTournamentModifier was always 0
// either way) while the "solo-cup performance" modifier itself was hardcoded to rosterSize === 1
// regardless of mode, so a 2v2 join got the exact same soloModifier a 1v1 join would have, ignoring
// the player's actual duo history entirely.
//
// Fix: scraper.js's computeMatchScoreBreakdown now takes a formRosterSize parameter (default 1,
// unchanged for every other real caller — queue.js's real tournaments, elo.js's public lookup).
// creative-queue.js's buildCreativePlayer derives it from the mode string
// (formRosterSizeForMode) — 1 for a 1v1 join (unchanged, still genuine recent SOLO form), 2 for a
// 2v2 join (genuine recent DUO form instead) — same real-decayed-PR mechanism, just a different
// team-size filter over the player's own recentEvents, same as solo's structural shape (general
// recent performance in that format, not tied to one specific tournament).
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeMatchScoreBreakdown, computeMatchScoreBreakdownWithTierComparison } = require('../scraper');
const creativeQueue = require('../creative-queue');
const playerStore = require('../players');

// A player with meaningfully different solo vs duo recent form: strong, consistent solo results
// (high decayed prPoints) but weak duo results (low decayed prPoints) — if 1v1/2v2 scoring is
// genuinely split, 1v1 must reflect the strong solo signal and 2v2 must reflect the weak duo one,
// not the same value.
function mixedFormPlayerData() {
  return {
    totalPR: 1000,
    thisSeasonPR: 100,
    recentEvents: [
      { name: 'Solo Cash Cup', date: '2026-08-01', rosterSize: 1, prPoints: 300, placement: 1 },
      { name: 'Solo Series', date: '2026-07-25', rosterSize: 1, prPoints: 280, placement: 3 },
      { name: 'Duos Cash Cup', date: '2026-08-02', rosterSize: 2, prPoints: 20, placement: 900 },
      { name: 'Duos Series', date: '2026-07-28', rosterSize: 2, prPoints: 15, placement: 950 },
      // Trios must never leak into either signal.
      { name: 'Trios Cup', date: '2026-07-20', rosterSize: 3, prPoints: 999, placement: 1 },
    ],
  };
}

// ── #1: scraper.js's formRosterSize parameter itself ─────────────────────────
test('computeMatchScoreBreakdown: formRosterSize=1 (default, solo) only counts rosterSize===1 events, ignoring duo/trio history', () => {
  const { soloEvents, soloModifier } = computeMatchScoreBreakdown(mixedFormPlayerData(), '__no_match__');
  assert.deepEqual(soloEvents.map(e => e.name), ['Solo Cash Cup', 'Solo Series']);
  assert.ok(soloModifier > 0);
});

test('computeMatchScoreBreakdown: formRosterSize=2 only counts rosterSize===2 events, ignoring solo/trio history', () => {
  const { soloEvents, soloModifier } = computeMatchScoreBreakdown(mixedFormPlayerData(), '__no_match__', 2);
  assert.deepEqual(soloEvents.map(e => e.name), ['Duos Cash Cup', 'Duos Series']);
  assert.ok(soloModifier > 0);
});

test('computeMatchScoreBreakdown: solo (strong history) and duo (weak history) modifiers for the SAME player are genuinely different, not coincidentally equal', () => {
  const solo = computeMatchScoreBreakdown(mixedFormPlayerData(), '__no_match__', 1);
  const duo = computeMatchScoreBreakdown(mixedFormPlayerData(), '__no_match__', 2);

  assert.notEqual(solo.soloModifier, duo.soloModifier);
  assert.notEqual(solo.matchScore, duo.matchScore);
  assert.ok(solo.soloModifier > duo.soloModifier, 'strong solo history must score higher than weak duo history for the same player');
});

test('computeMatchScoreBreakdownWithTierComparison: formRosterSize threads through the tier-comparison wrapper too (creative-queue.js\'s real call path)', async () => {
  const solo = await computeMatchScoreBreakdownWithTierComparison(mixedFormPlayerData(), '1v1 Realistics', 1);
  const duo = await computeMatchScoreBreakdownWithTierComparison(mixedFormPlayerData(), '2v2 Realistics', 2);

  assert.notEqual(solo.matchScore, duo.matchScore);
  assert.deepEqual(solo.soloEvents.map(e => e.name), ['Solo Cash Cup', 'Solo Series']);
  assert.deepEqual(duo.soloEvents.map(e => e.name), ['Duos Cash Cup', 'Duos Series']);
});

// ── #2: creative-queue.js's formRosterSizeForMode + real mode-string wiring ──
test('formRosterSizeForMode: routes every real 1v1/2v2 mode string to the right roster size', () => {
  assert.equal(creativeQueue.formRosterSizeForMode('1v1 Realistics'), 1);
  assert.equal(creativeQueue.formRosterSizeForMode('1v1 Zone Wars'), 1);
  assert.equal(creativeQueue.formRosterSizeForMode('2v2 Realistics'), 2);
  assert.equal(creativeQueue.formRosterSizeForMode('2v2 Zone Wars'), 2);
});

// ── #3: end-to-end through buildCreativePlayer — the real join path ──────────
test('buildCreativePlayer: 1v1 and 2v2 joins for the SAME player with mixed solo/duo history produce genuinely different matchScores', async () => {
  const originalGetStatsForContext = playerStore.getStatsForContext;
  const originalGetPlayer = playerStore.getPlayer;

  playerStore.getPlayer = async () => ({ region: 'EU' });
  playerStore.getStatsForContext = async () => ({
    stats: mixedFormPlayerData(),
    prContext: { region: 'EU', platformSegment: 'all', isHomeRegion: true, isHomePlatform: true },
  });

  try {
    const baseArgs = {
      guildId: 'g1', guildName: 'Test Guild', discordId: 'p1', discordUsername: 'p1', discordTag: 'p1',
      epicUsername: 'p1', epicId: 'p1', region: 'EU',
    };

    const oneVOne = await creativeQueue.buildCreativePlayer({ ...baseArgs, mode: '1v1 Realistics' });
    const twoVTwo = await creativeQueue.buildCreativePlayer({ ...baseArgs, mode: '2v2 Realistics' });

    assert.equal(oneVOne.totalPR, twoVTwo.totalPR, 'sanity check: same underlying player/PR both times');
    assert.notEqual(oneVOne.matchScore, twoVTwo.matchScore, '1v1 and 2v2 must no longer produce identical scores for a player with different solo vs duo history');
    assert.notEqual(oneVOne.soloModifier, twoVTwo.soloModifier);
    assert.ok(oneVOne.matchScore > twoVTwo.matchScore, 'this player\'s strong solo form must score higher in 1v1 than their weak duo form scores in 2v2');
  } finally {
    playerStore.getStatsForContext = originalGetStatsForContext;
    playerStore.getPlayer = originalGetPlayer;
  }
});

test('buildCreativePlayer: a 1v1 join is unaffected by this change — still the plain solo-only signal, same as before', async () => {
  const originalGetStatsForContext = playerStore.getStatsForContext;
  const originalGetPlayer = playerStore.getPlayer;

  playerStore.getPlayer = async () => ({ region: 'EU' });
  playerStore.getStatsForContext = async () => ({
    stats: mixedFormPlayerData(),
    prContext: { region: 'EU', platformSegment: 'all', isHomeRegion: true, isHomePlatform: true },
  });

  try {
    const player = await creativeQueue.buildCreativePlayer({
      guildId: 'g1', guildName: 'Test Guild', discordId: 'p1', discordUsername: 'p1', discordTag: 'p1',
      epicUsername: 'p1', epicId: 'p1', region: 'EU', mode: '1v1 Realistics',
    });

    const expected = await computeMatchScoreBreakdownWithTierComparison(mixedFormPlayerData(), '1v1 Realistics', 1);
    assert.equal(player.matchScore, expected.matchScore);
    assert.equal(player.soloModifier, expected.soloModifier);
  } finally {
    playerStore.getStatsForContext = originalGetStatsForContext;
    playerStore.getPlayer = originalGetPlayer;
  }
});
