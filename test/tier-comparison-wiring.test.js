// Verifies tier-comparison.js is actually WIRED into every live scoring path, not just correct in
// isolation (test/tier-comparison.test.js covers the module's own logic; this file covers the
// integration — that scraper.js's async wrappers genuinely call it and correctly fold a real
// modifier into the final matchScore/segments).
//
// tier-comparison.js's own getTierComparisonModifier is stubbed directly here (module.exports
// delegation) rather than the underlying Model, since these tests are about the WIRING in
// scraper.js/elo.js, not tier-comparison.js's own band math (already covered elsewhere) — same
// "stub the thing this test is actually about" precedent as test/epic-integration.test.js stubbing
// epicApi.getEpicOwnTournamentModifier directly instead of fetchJson. scraper.js's own require of
// tier-comparison.js is deferred (inside applyTierComparisonModifier, not at module top level — see
// that function's doc comment on the circular-require risk this avoids), which re-reads
// tierComparison.getTierComparisonModifier fresh on every call, so stubbing the property here is
// picked up correctly without needing to touch scraper.js's require cache at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const scraperModule = require('../scraper');
const { computeMatchScoreBreakdown, computeMatchScoreBreakdownWithEpic, computeMatchScoreBreakdownWithTierComparison } = scraperModule;
const tierComparison = require('../tier-comparison');
const epicApi = require('../epic-api');

function withStubbedTierModifier(stub, fn) {
  const original = tierComparison.getTierComparisonModifier;
  tierComparison.getTierComparisonModifier = stub;
  return Promise.resolve(fn()).finally(() => { tierComparison.getTierComparisonModifier = original; });
}

const PLAYER_DATA = { totalPR: 500, recentEvents: [] };

test('computeMatchScoreBreakdownWithTierComparison: a real signal from tier-comparison.js is folded into matchScore, not just carried as a side field', async () => {
  await withStubbedTierModifier(
    async () => ({ modifier: 0.05, hasSignal: true, resemblance: 0.5, ownBand: { bandMin: 0 }, nextBand: { bandMin: 200 } }),
    async () => {
      const plain = computeMatchScoreBreakdown(PLAYER_DATA, '__no_match__');
      const result = await computeMatchScoreBreakdownWithTierComparison(PLAYER_DATA, '__no_match__');

      assert.equal(result.tierModifier, 0.05);
      assert.equal(result.tierComparisonHasSignal, true);
      assert.equal(
        result.matchScore,
        Math.round(plain.base * (1 + plain.soloModifier + plain.ownTournamentModifier + 0.05)),
        'matchScore must genuinely incorporate the tier modifier into the real formula, not just report it alongside an unchanged score'
      );
      assert.ok(result.matchScore > plain.matchScore, 'a positive real tier modifier must raise the score above the plain FT-only baseline');
    }
  );
});

test('computeMatchScoreBreakdownWithTierComparison: hasSignal:false (the real current-scale default) leaves matchScore identical to the plain breakdown', async () => {
  await withStubbedTierModifier(
    async () => ({ modifier: 0, hasSignal: false, reason: 'own PR band has too few real players for valid stats yet' }),
    async () => {
      const plain = computeMatchScoreBreakdown(PLAYER_DATA, '__no_match__');
      const result = await computeMatchScoreBreakdownWithTierComparison(PLAYER_DATA, '__no_match__');
      assert.equal(result.matchScore, plain.matchScore);
      assert.equal(result.tierComparisonHasSignal, false);
    }
  );
});

test('computeMatchScoreBreakdownWithTierComparison: tier-comparison.js throwing is caught — never rejects, never leaves a queue-join without a score', async () => {
  await withStubbedTierModifier(
    async () => { throw new Error('simulated DB blip'); },
    async () => {
      const result = await computeMatchScoreBreakdownWithTierComparison(PLAYER_DATA, '__no_match__');
      assert.equal(result.tierComparisonHasSignal, false);
      assert.equal(result.tierModifier, 0);
      assert.equal(typeof result.matchScore, 'number');
    }
  );
});

test('computeMatchScoreBreakdownWithEpic: a real tier signal is folded in ON TOP OF a successful Epic ownTournamentModifier upgrade — both real upgrades stack', async () => {
  const tournament = { name: 'Duos Ranked Cup (Zero Build)', region: 'EU' };
  const originalEpic = epicApi.getEpicOwnTournamentModifier;
  epicApi.getEpicOwnTournamentModifier = async () => ({ modifier: 0.2, hasHistory: true, source: 'epic', matchedWindows: [] });

  await withStubbedTierModifier(
    async () => ({ modifier: 0.05, hasSignal: true, resemblance: 0.5, ownBand: {}, nextBand: {} }),
    async () => {
      try {
        const result = await computeMatchScoreBreakdownWithEpic(PLAYER_DATA, tournament, 'acc1');
        assert.equal(result.ownTournamentSource, 'epic');
        assert.equal(result.tierModifier, 0.05);
        assert.equal(
          result.matchScore,
          Math.round(PLAYER_DATA.totalPR * (1 + result.soloModifier + 0.2 + 0.05)),
          'the Epic-upgraded ownTournamentModifier AND the tier modifier must both be reflected in the final score'
        );
      } finally {
        epicApi.getEpicOwnTournamentModifier = originalEpic;
      }
    }
  );
});

test('computeMatchScoreBreakdownWithEpic: a real tier signal is folded in even when Epic itself has no match (FT-only ownTournamentModifier path)', async () => {
  const tournament = { name: 'Some Unmatched Tournament', region: 'EU' };
  const originalEpic = epicApi.getEpicOwnTournamentModifier;
  epicApi.getEpicOwnTournamentModifier = async () => null; // no Epic calendar match

  await withStubbedTierModifier(
    async () => ({ modifier: 0.07, hasSignal: true, resemblance: 0.7, ownBand: {}, nextBand: {} }),
    async () => {
      try {
        const result = await computeMatchScoreBreakdownWithEpic(PLAYER_DATA, tournament, 'acc1');
        assert.equal(result.ownTournamentSource, undefined, 'no Epic match -> stays on the plain FT-derived ownTournamentModifier');
        assert.equal(result.tierModifier, 0.07);
        assert.equal(
          result.matchScore,
          Math.round(PLAYER_DATA.totalPR * (1 + result.soloModifier + result.ownTournamentModifier + 0.07))
        );
      } finally {
        epicApi.getEpicOwnTournamentModifier = originalEpic;
      }
    }
  );
});

test('computeMatchScoreBreakdownWithEpic: a real tier signal is folded in even on the earliest-exit path (missing tournament/accountId info) — not skipped just because Epic itself was never attempted', async () => {
  const tournament = { name: 'Some Cup' }; // no region -> Epic is never even attempted
  await withStubbedTierModifier(
    async () => ({ modifier: 0.03, hasSignal: true, resemblance: 0.3, ownBand: {}, nextBand: {} }),
    async () => {
      const result = await computeMatchScoreBreakdownWithEpic(PLAYER_DATA, tournament, 'acc1');
      assert.equal(result.tierComparisonHasSignal, true, 'tier-comparison only needs playerData, not tournament/accountId — must still run here');
      assert.equal(result.tierModifier, 0.03);
    }
  );
});

// ── Real consumers actually use the tier-comparison-aware wrapper, not the plain sync function ──
test('creative-queue.js: buildCreativePlayer uses computeMatchScoreBreakdownWithTierComparison, not the plain sync computeMatchScoreBreakdown', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'creative-queue.js'), 'utf8');
  assert.match(source, /require\('\.\/scraper'\)/);
  assert.match(source, /computeMatchScoreBreakdownWithTierComparison/);
  assert.match(source, /await computeMatchScoreBreakdownWithTierComparison\(playerData, mode\)/);
});

test('elo.js: buildCreativeElo/buildTournamentElo use computeMatchScoreBreakdownWithTierComparison, not the plain sync computeMatchScoreBreakdown', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'elo.js'), 'utf8');
  assert.match(source, /computeMatchScoreBreakdownWithTierComparison/);
  const occurrences = source.match(/await computeMatchScoreBreakdownWithTierComparison\(/g) ?? [];
  assert.equal(occurrences.length, 2, 'both buildCreativeElo and buildTournamentElo must call the tier-comparison-aware wrapper');
});

test('queue.js: buildPlayer still uses computeMatchScoreBreakdownWithEpic (which itself now also layers in tier-comparison) — no separate call needed', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'queue.js'), 'utf8');
  assert.match(source, /await computeMatchScoreBreakdownWithEpic\(/);
});
