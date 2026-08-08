// tier-comparison.js - A standalone, self-contained "does this player's recent behavior resemble
// the tier above them" comparison system. Deliberately NOT folded into scraper.js's
// computeMatchScoreBreakdown/PR-native formula's own logic — this is a distinct, separable layer
// with its own data model (models/TierBandStats.js), its own daily batch job, and its own gating,
// so it can be adjusted or disabled entirely without touching the core matching formula. Wired in
// via scraper.js's computeMatchScoreBreakdownWithTierComparison/computeMatchScoreBreakdownWithEpic
// (both call getTierComparisonModifier below at the very end) — every live scoring path
// (queue.js/creative-queue.js/elo.js) picks this up automatically. Safe to wire in immediately
// despite real player count being confirmed under 20 total: getTierComparisonModifier's gating
// means it returns a real, honest hasSignal:false for essentially every real lookup right now, the
// same safe default state as before it was wired in — see this file's bottom doc comment for how
// that non-effect was verified, not just assumed.
//
// REAL DATA CONSTRAINT this was designed around: registered/scraped player count right now is
// confirmed well under 20 total, across every guild. Every constant and every gate below is chosen
// assuming that reality — expect every band to sit below MIN_BAND_PLAYERS for a long time, which is
// CORRECT, SAFE behavior (getTierComparisonModifier degrades to a real, honest "no signal" result,
// never a guessed or fabricated one), not a bug to work around. BAND_WIDTH_PR in particular is a
// reasoned default, not verified against a real player-PR distribution (there wasn't a large enough
// real sample to check one against) — chosen to match this codebase's own existing calibration of
// "what PR gap is meaningful" (config.js's prDistancePenalties treats a 100-350 PR gap as the
// range where distance starts to matter), not picked arbitrarily. Cheap to retune later: every
// player-band assignment is recomputed fresh on every batch run, nothing is migrated.
//
// FOUR real factors, per the original design: window-average decayed PR ("level"), trend (an OLS
// slope across the window), consistency (coefficient of variation across the window), and
// efficiency (totalPR / real scraped Sessions count — computeEfficiency below). The first three
// come from computeWindowStats' recentEvents window; efficiency is a genuinely different KIND of
// signal (overall PR earned per session invested, not a per-event trajectory measure), so it's
// computed separately from the player's totalPR/sessions rather than folded into the window. A
// Fortnite Tracker "Sessions" count wasn't scraped anywhere in this codebase for a while — that
// gap is closed now (scraper.js's parseProfileData, same page load thisSeasonPR's DOM read already
// uses, no separate navigation — confirmed live before implementing, not assumed) — see
// models/Player.js's sessions field doc comment.
//
// "QUALIFYING EVENTS" — the window factors 1-3 above are computed from: the player's own
// recentEvents (scraper.js's parseProfileData, newest-first, already capped at 20), filtered to
// entries with a real numeric prPoints, taking up to TIER_WINDOW_SIZE most recent. Deliberately ONE
// unified window (not two parallel solo-only / own-tournament-only sub-windows): "own-tournament"
// only has a coherent meaning relative to ONE specific target tournament name (scraper.js's
// computeOwnTournamentModifier takes a tournamentName to match against) — there's no single target
// tournament for a general, not-tied-to-one-queue-attempt trend measure like this. A player's
// recentEvents already naturally mixes solo and team events, so "for both solo and own-tournament
// signals" is satisfied by not artificially excluding either kind, not by computing them twice
// separately.

const TierBandStatsModel = require('./models/TierBandStats');
const playerStore = require('./players');
const db = require('./db');

// Target window size ("last 5-10 qualifying events" per the real spec this was built against) —
// MIN_EVENTS_FOR_TIER_SIGNAL is the floor below which there simply isn't enough real history to
// trust a trend/consistency measure at all (2-3 points can produce a "trend" that's really just
// noise); TIER_WINDOW_SIZE is the cap.
const MIN_EVENTS_FOR_TIER_SIGNAL = 5;
const TIER_WINDOW_SIZE = 10;

// Width of one PR band. See this file's top doc comment for why 200 (not independently verified
// against a real distribution — there isn't a large enough real sample to check one against yet —
// but matches this codebase's own existing "100-350 PR gap is meaningfully different" calibration,
// config.js's prDistancePenalties).
const BAND_WIDTH_PR = 200;

// Minimum real, signal-contributing players (models/TierBandStats.js's playerCount) a band needs
// before its stats are trusted at all — real player count is confirmed under 20 TOTAL right now, so
// this floor is expected to gate off essentially every band for a long time. That's the intended,
// safe default state, not a bug. Picked from the lower end of the ~15-20 range this was scoped
// against — a single easy-to-retune constant either way.
const MIN_BAND_PLAYERS = 15;

// Caps how much of a boost a full (resemblance = 1.0) "this player's real behavior fully matches
// the band above" result can contribute — deliberately modest relative to the existing formula's
// soloModifier (0.35 max) / ownTournamentModifier (0.30 max) weights, since this is a smaller,
// complementary signal layered on top, not a replacement for either. Only meaningful once this
// module is actually wired into a live score somewhere (see bottom doc comment) — unused by
// anything today.
const MAX_TIER_MODIFIER = 0.10;

function average(nums) {
  if (nums.length === 0) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

// Ordinary-least-squares slope of y against x = 0..n-1 (chronological event index, not calendar
// time — real events aren't evenly spaced, and index-based slope is simpler and still a genuine
// "is this trending up or down across these events" signal, which is all this needs to be). A
// positive slope means later (more recent) events scored higher prPoints than earlier ones in the
// window — genuinely improving, not just currently-high.
function linearRegressionSlope(valuesOldestFirst) {
  const n = valuesOldestFirst.length;
  if (n < 2) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let x = 0; x < n; x++) {
    const y = valuesOldestFirst[x];
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0; // degenerate (shouldn't happen for n >= 2, guarded anyway)
  return (n * sumXY - sumX * sumY) / denom;
}

// recentEvents is already newest-first (scraper.js's parseProfileData) — takes the most recent
// TIER_WINDOW_SIZE entries that carry a real, positive, PR-contributing value. Entries with
// prPoints of exactly 0 are excluded, same "not a real signal" treatment scraper.js's own
// soloModifier/ownTournamentModifier give a zero-point event.
function qualifyingEvents(recentEvents) {
  return (recentEvents ?? [])
    .filter(e => typeof e.prPoints === 'number' && e.prPoints > 0)
    .slice(0, TIER_WINDOW_SIZE);
}

// Returns null (not a zeroed-out object) when there isn't enough real history — every caller must
// treat null as "no signal," never as "signal that happens to be zero," so a brand-new/inactive
// player is never silently scored as if they had a flat, stable trend.
function computeWindowStats(recentEvents) {
  const qualifying = qualifyingEvents(recentEvents);
  if (qualifying.length < MIN_EVENTS_FOR_TIER_SIGNAL) return null;

  // newest-first -> oldest-first, so index 0 is the OLDEST event in the window (a genuine
  // chronological trend needs oldest-to-newest order, not scraped-order).
  const chronological = [...qualifying].reverse();
  const values = chronological.map(e => e.prPoints);

  const avgLevel = average(values);
  const trend = linearRegressionSlope(values);

  const variance = average(values.map(v => (v - avgLevel) ** 2));
  const stdDev = Math.sqrt(variance);
  // Coefficient of variation — scale-invariant (a 300-PR player and an 800-PR player's raw stdDev
  // aren't comparable on their own, but stdDev/mean is), which matters because even within one
  // 200-PR-wide band, two players' own window averages can genuinely differ enough that raw stdDev
  // wouldn't be a fair comparison. null when avgLevel is 0 — can't normalize against a zero mean,
  // and MIN_EVENTS_FOR_TIER_SIGNAL/the prPoints > 0 filter above make this rare in practice anyway.
  const consistency = avgLevel > 0 ? stdDev / avgLevel : null;

  return { sampleSize: values.length, avgLevel, trend, consistency };
}

// The fourth factor — PR earned per real lifetime session played (players.js's/scraper.js's
// sessions, platform-scoped the same way totalPR already is). Deliberately independent of
// computeWindowStats above: this doesn't need a qualifying-events window at all, just the
// player's own current totalPR and their scraped Sessions count, so it's computed separately
// rather than folded into that function's signature. null (never 0, never a guessed ratio) — same
// "no signal, not a zeroed-out result" discipline as consistency's own null case — whenever either
// input isn't a real positive number: sessions missing/zero (not yet scraped since this field
// existed, or a genuinely brand-new account with no recorded sessions) or totalPR not yet
// established. Callers null-filter this exactly like consistency, so a player/band missing it
// simply contributes one fewer factor to the average, never a fabricated value.
function computeEfficiency(totalPR, sessions) {
  if (!(totalPR > 0) || !(sessions > 0)) return null;
  return totalPR / sessions;
}

// Real PR band a given totalPR falls into — bandMax of one band is exactly bandMin of the next, so
// "the next band up" is always a simple, exact lookup (bandMin: thisBand.bandMax), never a
// recomputation or an off-by-one guess.
function bandRangeForPR(totalPR) {
  const bandMin = Math.floor((totalPR ?? 0) / BAND_WIDTH_PR) * BAND_WIDTH_PR;
  return { bandMin, bandMax: bandMin + BAND_WIDTH_PR };
}

// Groups a real, already-deduped player list (players.js's getAllScoredPlayers — reused as-is, not
// reimplemented, same real "one entry per real account" guarantee that function already provides)
// into bands, returning only the aggregate stats — never individual player data. A player whose own
// computeWindowStats comes back null (not enough real history) contributes NOTHING to any band's
// stats and is not counted in playerCount — see models/TierBandStats.js's doc comment on why
// counting them would misrepresent how statistically trustworthy a band's averages actually are.
function computeBandStatsFromPlayers(players) {
  const byBand = new Map(); // bandMin -> { bandMin, bandMax, levels: [], trends: [], consistencies: [], efficiencies: [] }

  for (const player of players) {
    const windowStats = computeWindowStats(player.recentEvents);
    if (!windowStats) continue;

    // Efficiency gated on the SAME per-player qualification as level/trend/consistency (a real
    // windowStats) — not an independent bypass. A player already needs genuine recent competitive
    // history for tier-comparison to apply to them at all; efficiency is one more factor evaluated
    // once they qualify, not a separate door in.
    const efficiency = computeEfficiency(player.totalPR, player.sessions);

    const { bandMin, bandMax } = bandRangeForPR(player.totalPR);
    if (!byBand.has(bandMin)) byBand.set(bandMin, { bandMin, bandMax, levels: [], trends: [], consistencies: [], efficiencies: [] });
    const bucket = byBand.get(bandMin);
    bucket.levels.push(windowStats.avgLevel);
    bucket.trends.push(windowStats.trend);
    if (windowStats.consistency != null) bucket.consistencies.push(windowStats.consistency);
    if (efficiency != null) bucket.efficiencies.push(efficiency);
  }

  return [...byBand.values()].map(({ bandMin, bandMax, levels, trends, consistencies, efficiencies }) => ({
    bandMin,
    bandMax,
    playerCount: levels.length,
    avgLevel: average(levels),
    avgTrend: average(trends),
    avgConsistency: consistencies.length > 0 ? average(consistencies) : null,
    avgEfficiency: efficiencies.length > 0 ? average(efficiencies) : null,
  }));
}

// The daily batch job (startTierComparisonScheduler below). This collection is always fully
// DERIVED, never incrementally patched — every run replaces the entire contents from a fresh read
// of real player data, so a band that no longer has any signal-contributing player is simply
// absent afterward, rather than a stale, now-inflated-looking playerCount lingering from a
// previous run (models/TierBandStats.js's own top doc comment covers this same point).
async function runDailyTierBandComputation() {
  const players = await playerStore.getAllScoredPlayers();
  const bandStats = computeBandStatsFromPlayers(players);

  await TierBandStatsModel.deleteMany({});
  if (bandStats.length > 0) {
    await TierBandStatsModel.insertMany(bandStats.map(b => ({ ...b, computedAt: new Date() })));
  }

  console.log(`[tier-comparison] Daily band computation: ${players.length} real player(s) -> ${bandStats.length} band(s) with enough signal to be valid`);
  return { totalPlayers: players.length, bandsComputed: bandStats.length };
}

const DAILY_MS = 24 * 60 * 60 * 1000;

function startTierComparisonScheduler() {
  console.log('📊 Running initial tier-band computation on startup...');
  runDailyTierBandComputation().catch(err => console.error('[tier-comparison] Initial computation failed:', err.message));

  setInterval(() => {
    runDailyTierBandComputation().catch(err => console.error('[tier-comparison] Daily computation failed:', err.message));
  }, DAILY_MS);

  console.log('📊 Tier-comparison scheduler started — daily band computation armed');
}

// Linear position of playerValue between ownAvg (0.0) and nextAvg (1.0), clamped to [0, 1] —
// direction-agnostic on purpose: whichever way "better" actually points for a given real factor
// (e.g. a lower coefficient-of-variation is normally "more consistent," but this never assumes
// that — it just measures where the player's own real number falls relative to the two real
// measured anchors, whichever direction they happen to point) is whatever the real aggregate data
// itself shows, never hardcoded. A player short of their own band's average scores 0 (fully
// resembles their own band, no partial credit for approaching from below); a player past the next
// band's average is capped at 1 (never extrapolated beyond "fully resembles the next tier").
function resemblance(playerValue, ownAvg, nextAvg) {
  if (playerValue == null || ownAvg == null || nextAvg == null) return null;
  if (nextAvg === ownAvg) return null; // no discriminating signal between the two bands for this factor
  const t = (playerValue - ownAvg) / (nextAvg - ownAvg);
  return Math.max(0, Math.min(1, t));
}

// The real per-player entry point. playerData needs { totalPR, recentEvents } (the same shape
// computeMatchScoreBreakdown already takes — no new shape invented) plus sessions (players.js's
// getStatsForContext-resolved, platform-scoped count — optional: a missing/null sessions just
// drops the efficiency factor below, same as a missing consistency already does, never a hard
// failure). Always resolves to a real, honest result — hasSignal:false + modifier:0 whenever ANY
// required real signal is missing (the player's own window, their own band, or the next band up),
// per the explicit "plain PR-native scoring with no tier-comparison modifier at all" fallback
// requirement — never a guessed or partial modifier from incomplete data.
async function getTierComparisonModifier(playerData) {
  const windowStats = computeWindowStats(playerData?.recentEvents);
  if (!windowStats) {
    return { modifier: 0, hasSignal: false, reason: 'not enough real qualifying event history for this player' };
  }

  // Fails fast rather than letting a real Mongoose query hang against a down/unconfigured
  // connection — this is now called on every real queue join / creative queue join / public ELO
  // lookup (scraper.js's computeMatchScoreBreakdownWithEpic/WithTierComparison), not just the
  // once-daily batch job, so a slow DB hiccup here would otherwise stall every one of those live
  // paths for however long Mongoose's own connection-buffering timeout takes, on top of the
  // eventual (correct) fallback to hasSignal:false anyway. db.isConnected() is a cheap, already-
  // tracked in-memory flag (db.js), not a real round trip.
  if (!db.isConnected()) {
    return { modifier: 0, hasSignal: false, reason: 'database not connected' };
  }

  const { bandMin, bandMax } = bandRangeForPR(playerData.totalPR);
  const [ownBand, nextBand] = await Promise.all([
    TierBandStatsModel.findOne({ bandMin }).lean(),
    TierBandStatsModel.findOne({ bandMin: bandMax }).lean(),
  ]);

  if (!ownBand || ownBand.playerCount < MIN_BAND_PLAYERS) {
    return { modifier: 0, hasSignal: false, reason: 'own PR band has too few real players for valid stats yet' };
  }
  if (!nextBand || nextBand.playerCount < MIN_BAND_PLAYERS) {
    return { modifier: 0, hasSignal: false, reason: 'next PR band up has too few real players for valid stats yet' };
  }

  const efficiency = computeEfficiency(playerData.totalPR, playerData.sessions);

  const factorResemblances = [
    resemblance(windowStats.avgLevel, ownBand.avgLevel, nextBand.avgLevel),
    resemblance(windowStats.trend, ownBand.avgTrend, nextBand.avgTrend),
    resemblance(windowStats.consistency, ownBand.avgConsistency, nextBand.avgConsistency),
    resemblance(efficiency, ownBand.avgEfficiency, nextBand.avgEfficiency),
  ].filter(r => r != null);

  if (factorResemblances.length === 0) {
    return { modifier: 0, hasSignal: false, reason: 'no comparable factors between this player and the two real bands' };
  }

  const overallResemblance = average(factorResemblances);
  const modifier = overallResemblance * MAX_TIER_MODIFIER;

  return {
    modifier,
    hasSignal: true,
    resemblance: overallResemblance,
    factorsUsed: factorResemblances.length,
    ownBand: { bandMin: ownBand.bandMin, bandMax: ownBand.bandMax, playerCount: ownBand.playerCount },
    nextBand: { bandMin: nextBand.bandMin, bandMax: nextBand.bandMax, playerCount: nextBand.playerCount },
  };
}

module.exports = {
  MIN_EVENTS_FOR_TIER_SIGNAL,
  TIER_WINDOW_SIZE,
  BAND_WIDTH_PR,
  MIN_BAND_PLAYERS,
  MAX_TIER_MODIFIER,
  computeWindowStats,
  computeEfficiency,
  bandRangeForPR,
  computeBandStatsFromPlayers,
  runDailyTierBandComputation,
  startTierComparisonScheduler,
  getTierComparisonModifier,
};

// WIRED INTO EVERY LIVE SCORE: getTierComparisonModifier is called from scraper.js's
// computeMatchScoreBreakdownWithEpic (queue.js's real tournament path) and
// computeMatchScoreBreakdownWithTierComparison (creative-queue.js, elo.js) — every real matching/
// display path picks this up automatically, no second activation step needed. Safe at real current
// scale (confirmed under 20 total players): every real lookup returns hasSignal:false today (the
// MIN_BAND_PLAYERS gate), so this has zero effect on any live score right now — exactly the same
// safe default as before it was wired in, just without needing a future code change to activate it.
// db.isConnected() is checked before ever touching TierBandStatsModel specifically because this now
// runs on every real queue join / creative queue join / public ELO lookup, not just the once-daily
// batch job — a slow or down DB must never stall one of those live paths waiting on a query this
// function is going to fall back away from anyway.
