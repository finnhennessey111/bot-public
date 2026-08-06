// elo.js - Public "check your ELO" lookup (webhook-server.js's GET /api/elo/:epicUsername).
// Looks up a player's STORED Epic username (players.js's findCanonicalByEpicUsername) — never a
// live Puppeteer/Fortnite Tracker scrape at request time — so this stays fast and cheap enough for
// a public, unauthenticated, potentially-hammered endpoint. Returns their creative and per-
// permanent-tournament match scores broken into the same components the real matching algorithm
// actually uses (scraper.js's computeMatchScoreBreakdown/computeOwnTournamentModifier) — no new
// scoring logic invented here, just the existing formula reused and exposed for display.
//
// "Creative" here means the SAME base+soloModifier calculation queue.js's tournament path and
// creative-queue.js's creative path both already share — confirmed identical for 1v1 and 2v2
// (neither ever matches a real recentEvents tournament name, so ownTournamentModifier is always 0
// for creative regardless of which mode string is used) — so this computes it once, generically,
// rather than once per creative mode.
//
// Also exposes derived-not-invented pieces per score: `baseline` (the PR-only portion of the SAME
// formula, before soloModifier/ownTournamentModifier are applied) and `vsBaselinePercent` (this
// score vs. that baseline). Note `vsBaselinePercent` can only ever be >= 0 — soloModifier and
// ownTournamentModifier never go negative in the real formula — so it is NOT a genuine above/
// below-average signal on its own, just "how much bonus is this score carrying over its floor."
// `relativeToAveragePercent` is the real two-sided comparison: this player's OWN vsBaselinePercent
// minus the comparison pool's AVERAGE vsBaselinePercent for that same category — positive means a
// bigger-than-typical bonus (genuinely above average), negative means smaller (genuinely below).
// `percentile` is this score's rank against every other real scored player's score for that same
// category. Both `relativeToAveragePercent` and `percentile` are built from the SAME pool
// (players.js's getAllScoredPlayers, deduped one entry per real account, fed through the SAME
// formula so it's apples-to-apples) — computed once per request, not twice. Unlike the rest of
// this endpoint, that pool query is NOT free — see getAllScoredPlayers' doc comment for the scale
// assumption behind doing it as a live full collection scan.
//
// `examples` surfaces up to 3 real events behind soloPerformance/ownTournamentPlacement — the
// EXACT events those modifiers were computed from (scraper.js's computeMatchScoreBreakdown now
// also returns soloEvents; computeOwnTournamentModifier already returned matchedEvents), not a
// separately re-derived "recent events" list. No new selection logic lives here.

const { computeMatchScoreBreakdown, computeOwnTournamentModifier } = require('./scraper');
const { PERMANENT_KEYWORDS } = require('./tournament-scraper');
const { findCanonicalByEpicUsername, getAllScoredPlayers } = require('./players');
const config = require('./config');

// Never a real tournament title (recentEvents' names all come from real scraped Fortnite Tracker
// event titles) — passed as computeMatchScoreBreakdown's tournamentName so ownTournamentModifier
// always comes back 0, exactly reproducing creative-queue.js's real behavior without needing a
// second, parallel implementation of the base/soloModifier math.
const NEVER_MATCHES_A_REAL_TOURNAMENT = '__matchmaker_creative_elo__';

// Friendly display labels for tournament-scraper.js's PERMANENT_KEYWORDS — the SAME classification
// already used to decide which tournaments get a permanent, always-open Discord channel (FNCS
// Divisions, Console Duos Victory Cup — confirmed the same "real tournaments only, never skin cups
// or ranked cups" set this feature needs). Not a second list: the actual matching keyword always
// comes from PERMANENT_KEYWORDS itself; this only maps each one to a readable label. A keyword
// with no entry here still works (falls back to a title-cased version of the keyword), so a future
// PERMANENT_KEYWORDS addition never silently vanishes from this endpoint.
const PERMANENT_TYPE_LABELS = {
  'fncs division': 'FNCS Division',
  'console duos victory cup': 'Console Duos Victory Cup',
};

function labelForKeyword(keyword) {
  return PERMANENT_TYPE_LABELS[keyword] ?? keyword.replace(/\b\w/g, c => c.toUpperCase());
}

// Which of PERMANENT_KEYWORDS are console-exclusive tournament TYPES — collapsed to the keyword
// level since this endpoint has no single real scraped tournament instance to read a per-event
// consoleOnly flag from (tournament-scraper.js's real consoleOnly detection), only the generic type
// the website groups by. 'console duos victory cup' is unambiguous by name and console-exclusive in
// every real scraped instance; 'fncs division' is not platform-restricted. Drives which Fortnite
// Tracker input segment (players.js's getStatsForContext, same logic queue.js's buildPlayer already
// uses for a real queue join) a Console player's PR/solo-event signal is drawn from for each type —
// without this, a Console player was always shown their combined "all"-input PR/history here,
// never the gamepad-specific numbers a real queue attempt for the same tournament type would use
// (confirmed real symptom: Console Duos Victory Cup showing kbm/PC-segment PR for a console player).
const PERMANENT_KEYWORD_CONSOLE_ONLY = {
  'console duos victory cup': true,
};

// Resolves the SAME Fortnite Tracker platform segment a real queue join for this tournament type
// would use (players.js's getStatsForContext computes this exact same segment — the resolution
// RULE is reused, not reimplemented): tournamentConsoleOnly decides whether a Console player's
// segment is gamepad or kbm (a PC player always stays on the combined "all" segment either way, so
// this is a no-op for them, same as in a real queue join).
//
// Deliberately read-only, unlike getStatsForContext itself: this file's top doc comment guarantees
// "never a live Puppeteer/Fortnite Tracker scrape at request time" for this public, unauthenticated
// endpoint — calling getStatsForContext directly would silently break that guarantee, since its
// cache-miss path calls scrapePlayer (a real headless-Chromium launch) whenever a (region,
// platform-segment) context has never been fetched before. So this only ever reads whatever's
// ALREADY cached on the player doc (home fields for the "all" segment, statsByContext for
// kbm/gamepad — both populated lazily by a real queue join, players.js's getContextualPlayerStats),
// regardless of TTL staleness (staleness matters for a queue-join's accuracy, not for a display-only
// lookup). If a Console player has never actually queued THIS specific platform-segment context
// before (no cached entry exists yet), this falls back to their home snapshot rather than either
// showing a fake 0 or paying for a live scrape — a real but narrow edge case, distinct from the
// reported bug (a console player who HAS queued before, so the correct context is already cached,
// just never being read).
function resolvePlayerDataForContext(player, tournamentConsoleOnly) {
  const platform = player.platform ?? 'PC';
  const platformSegment = platform === 'Console'
    ? (tournamentConsoleOnly ? config.ftPlatformSegments.Console : config.ftPlatformSegments.PC)
    : 'all';

  if (platformSegment !== 'all') {
    const key = `${player.region}|${platformSegment}`;
    const cached = player.statsByContext?.[key];
    if (cached && cached.totalPR != null) {
      return {
        totalPR: cached.totalPR ?? 0,
        thisSeasonPR: cached.thisSeasonPR ?? 0,
        recentEvents: cached.recentEvents ?? [],
      };
    }
  }

  return {
    totalPR: player.totalPR ?? 0,
    thisSeasonPR: player.thisSeasonPR ?? 0,
    recentEvents: player.recentEvents ?? [],
  };
}

// Splits a matchScore into UI-ready segments that sum EXACTLY to the total, for a segmented bar on
// the website — soloModifier/ownTournamentModifier are multiplicative percentages of base, so their
// absolute contribution can be fractional. soloPerformance absorbs whatever rounding remainder is
// left after current+ownTournament are each rounded independently, rather than every segment
// rounding on its own and the total silently drifting off by a point or two.
//
// PR-NATIVE FORMULA (scraper.js's computeMatchScoreBreakdown doc comment): Total = Current PR ×
// (1 + soloModifier + ownTournamentModifier). No seasonPR segment anymore — thisSeasonPR is a
// deliberately-removed formula input now (a blunt, unfiltered seasonal aggregate that didn't fit
// the "targeted, relevant recent form" philosophy soloModifier/ownTournamentModifier both follow),
// not just hidden from display; it no longer contributes to the score at all, so there's nothing
// left here for a "seasonPR" segment to represent.
//
// Named currentPR (not careerPR) deliberately: totalPR (scraper.js's extractPowerRank, reading
// data.powerRank.points) is Fortnite Tracker's continuously-recomputed, decaying "Power Ranking"
// figure — confirmed live to be exactly the number the site itself headlines on a profile page —
// NOT a frozen career/lifetime total (that's a genuinely different, separate field —
// data.powerRank.lifetimePR — which this codebase never captures or uses at all). "Career" implies
// a permanent, monotonically-growing sum; this value can and does go back down over time as older
// results decay out, so "current" is the accurate word.
function toSegments({ base, soloModifier, ownTournamentModifier }) {
  const total = Math.round(base * (1 + soloModifier + ownTournamentModifier));
  const currentPR = Math.round(base);
  const ownTournamentPlacement = ownTournamentModifier > 0 ? Math.round(base * ownTournamentModifier) : 0;
  const soloPerformance = total - currentPR - ownTournamentPlacement;
  return { total, currentPR, ownTournamentPlacement, soloPerformance };
}

// "base" from computeMatchScoreBreakdown IS Current PR itself now (the PR-only baseline, before
// soloModifier/ownTournamentModifier ever get applied) — no separate calculation is needed here,
// just exposing what was already being computed. Rounded for display parity with the (always-
// integer) final score.
function vsBaselinePercent(score, baseline) {
  if (!baseline) return null; // a brand-new/all-zero PR player — "% above/below zero" is meaningless
  return Math.round(((score / baseline) - 1) * 1000) / 10;
}

// Standard "mean rank" percentile: a tie counts as half above/half below rather than all-below or
// all-above, so (a) a lone top scorer lands just under the 100th percentile instead of getting
// rounded up to exactly 100 (nobody is "better than everyone including themselves"), and (b) a
// group of players tied on the same score all land on the exact same, fair percentile instead of
// an arbitrary tiebreak order. allScores includes the looked-up player's own score (they're a
// real scored player too), matching how the pool is built in getPublicElo below.
function percentileRank(score, allScores) {
  if (allScores.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const s of allScores) {
    if (s < score) below++;
    else if (s === score) equal++;
  }
  return Math.round(((below + equal / 2) / allScores.length) * 1000) / 10;
}

function rawTotal(base, soloModifier, ownTournamentModifier) {
  return Math.round(base * (1 + soloModifier + ownTournamentModifier));
}

function average(nums) {
  if (nums.length === 0) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

// Builds the comparison pools ONCE per request (not once per tournament type) — every scored
// player's creative score, plus their score for each permanent tournament type, using the SAME
// "no history in this type -> just the shared base" rule buildTournamentElo below gives the
// looked-up player, so the pool is genuinely apples-to-apples with what's being ranked against it.
// computeMatchScoreBreakdown no longer takes a region at all (see scraper.js's doc comment on it —
// region-aware PR now happens upstream, in WHICH data was scraped, not inside the formula), so
// every pool player's stored (home-context) totalPR/thisSeasonPR/recentEvents is used exactly as-
// is here.
//
// Also collects each pool player's OWN vsBaselinePercent (their score vs. their own PR floor) so
// getPublicElo can compare the looked-up player's bonus against the POOL AVERAGE bonus, not just
// their own floor. That average comparison is the only two-sided signal available here: every
// individual vsBaselinePercent is >= 0 (soloModifier/ownTournamentModifier never go negative — see
// vsBaselinePercent's doc comment) — averaging across real players doesn't change that; it turns
// "am I above MY OWN floor" (always yes/flat) into "am I getting a BIGGER bonus over my floor than
// the average real player gets over theirs" (a genuine above/below-average comparison).
function buildScorePools(allPlayers) {
  const creative = [];
  const creativeBonuses = [];
  const tournaments = Object.fromEntries(PERMANENT_KEYWORDS.map(k => [k, []]));
  const tournamentBonuses = Object.fromEntries(PERMANENT_KEYWORDS.map(k => [k, []]));

  for (const playerData of allPlayers) {
    const { base, soloModifier } = computeMatchScoreBreakdown(playerData, NEVER_MATCHES_A_REAL_TOURNAMENT);
    const baseline = Math.round(base);
    const creativeScore = rawTotal(base, soloModifier, 0);
    creative.push(creativeScore);
    const creativeBonus = vsBaselinePercent(creativeScore, baseline);
    if (creativeBonus !== null) creativeBonuses.push(creativeBonus);

    for (const keyword of PERMANENT_KEYWORDS) {
      const { modifier } = computeOwnTournamentModifier(playerData.recentEvents, e => e.name.toLowerCase().includes(keyword), base);
      const score = rawTotal(base, soloModifier, modifier);
      tournaments[keyword].push(score);
      const bonus = vsBaselinePercent(score, baseline);
      if (bonus !== null) tournamentBonuses[keyword].push(bonus);
    }
  }

  return {
    creative,
    tournaments,
    creativeAvgBonus: average(creativeBonuses),
    tournamentAvgBonus: Object.fromEntries(PERMANENT_KEYWORDS.map(k => [k, average(tournamentBonuses[k])])),
  };
}

// The looked-up player's own vsBaselinePercent minus the pool's average vsBaselinePercent for the
// same category — positive means a bigger-than-average bonus over their own floor (a real
// above-average performer), negative means a smaller one (genuinely below-average), even though
// ownPercent itself can never be negative on its own.
function relativeToAveragePercent(ownPercent, avgPercent) {
  if (ownPercent === null || avgPercent === null) return null;
  return Math.round((ownPercent - avgPercent) * 10) / 10;
}

// Up to 3 REAL example events behind a component's number — deliberately capped at 3 for display
// even for soloPerformance, whose modifier itself draws from up to 5 (scraper.js's
// computeMatchScoreBreakdown) — "example events", not a full audit trail of every input. Takes the
// first 3 of whatever was already selected to compute the modifier (both soloEvents and
// ownTournamentModifier's matchedEvents come back newest-first, same order recentEvents itself is
// sorted in), so this is genuinely a prefix of the real inputs, not a re-filtered/re-sorted
// approximation — no re-scrape, no new selection logic, just formatting what already fed the math.
function toExampleEvents(events) {
  return events.slice(0, 3).map(e => ({
    name: e.name, date: e.date, placement: e.placement, prPoints: e.prPoints,
  }));
}

// player is the raw Player doc (needs region/platform/statsByContext for
// resolvePlayerDataForContext), not a pre-shaped playerData object — creative queueing never has a
// console-exclusive-mode concept (same as creative-queue.js's buildCreativePlayer), so this always
// resolves the non-console-exclusive context (kbm for a Console player, "all" for a PC player).
function buildCreativeElo(player, pools) {
  const playerData = resolvePlayerDataForContext(player, false);
  const { base, soloModifier, soloEvents } = computeMatchScoreBreakdown(playerData, NEVER_MATCHES_A_REAL_TOURNAMENT);
  const { total, currentPR, soloPerformance } = toSegments({ base, soloModifier, ownTournamentModifier: 0 });
  const baseline = Math.round(base);
  const ownVsBaselinePercent = vsBaselinePercent(total, baseline);

  return {
    score: total,
    baseline,
    vsBaselinePercent: ownVsBaselinePercent,
    relativeToAveragePercent: relativeToAveragePercent(ownVsBaselinePercent, pools.creativeAvgBonus),
    percentile: percentileRank(total, pools.creative),
    components: { currentPR, soloPerformance },
    examples: { soloPerformance: toExampleEvents(soloEvents) },
  };
}

// player is the raw Player doc (see buildCreativeElo above) — each tournament type resolves its
// OWN platform-scoped context independently (PERMANENT_KEYWORD_CONSOLE_ONLY), since a Console
// player's correct segment genuinely differs per type (gamepad for Console Duos Victory Cup, kbm
// for FNCS Division) — there is deliberately no single shared playerData/base/soloModifier computed
// once and reused across every type the way there used to be, since that shared value could only
// ever be correct for one of the two contexts at a time for a Console player.
function buildTournamentElo(player, pools) {
  return PERMANENT_KEYWORDS.map(keyword => {
    const tournamentConsoleOnly = !!PERMANENT_KEYWORD_CONSOLE_ONLY[keyword];
    const playerData = resolvePlayerDataForContext(player, tournamentConsoleOnly);
    const { base, soloModifier, soloEvents } = computeMatchScoreBreakdown(playerData, NEVER_MATCHES_A_REAL_TOURNAMENT);
    const baseline = Math.round(base);

    const { modifier: ownTournamentModifier, hasHistory, matchedEvents: ownTournamentMatchedEvents } = computeOwnTournamentModifier(
      playerData.recentEvents, e => e.name.toLowerCase().includes(keyword), base
    );

    const { total, currentPR, ownTournamentPlacement, soloPerformance } = toSegments({ base, soloModifier, ownTournamentModifier });
    const ownVsBaselinePercent = vsBaselinePercent(total, baseline);

    return {
      tournamentType: labelForKeyword(keyword),
      hasHistory,
      score: total,
      baseline,
      vsBaselinePercent: ownVsBaselinePercent,
      relativeToAveragePercent: relativeToAveragePercent(ownVsBaselinePercent, pools.tournamentAvgBonus[keyword]),
      percentile: percentileRank(total, pools.tournaments[keyword]),
      components: {
        currentPR, soloPerformance,
        // Only present when there's real history — same "just the shared base, no extra modifier"
        // behavior computeMatchScoreBreakdown already has for any tournament a player hasn't
        // played (ownTournamentModifier is 0, so `total` here already equals the creative score
        // exactly); omitted rather than a 0 field so the website can tell "no history" apart from
        // "history that happened to score zero placement value" at a glance.
        ...(hasHistory ? { ownTournamentPlacement } : {}),
      },
      examples: {
        soloPerformance: toExampleEvents(soloEvents),
        // Same omission rule as components.ownTournamentPlacement above — no history means no real
        // events to show, not an empty-but-present array implying "checked, found none relevant".
        ...(hasHistory ? { ownTournamentPlacement: toExampleEvents(ownTournamentMatchedEvents) } : {}),
      },
    };
  });
}

// Returns null for "not found in our database at all" — webhook-server.js turns that into a clean
// 404, distinct from a 500, so the website can render an honest "no record" message rather than an
// error state.
async function getPublicElo(epicUsername) {
  const player = await findCanonicalByEpicUsername(epicUsername);
  if (!player) return null;

  // "Ever scraped in ANY context" — not just player.totalPR (the home, non-console-exclusive
  // context). A Console player's home fields can legitimately stay null forever under normal use:
  // getStatsForContext only ever writes them when the resolved segment is "all" (players.js's
  // isHomePlatform), and a Console player's segment is always kbm or gamepad, never "all" — so a
  // Console player who has only ever queued (never run /refresh-stats, which always scrapes the
  // "all" segment unconditionally) would otherwise incorrectly report hasStats:false here despite
  // having real, genuine statsByContext history.
  const hasAnyStats = player.totalPR != null || Object.keys(player.statsByContext ?? {}).length > 0;
  if (!hasAnyStats) {
    // Registered/linked but never actually scraped yet (no queue attempt has ever happened for
    // this account) — nothing real to show. Distinct from "not found" so the website can render a
    // different, honest "no stats yet" message instead of implying the account doesn't exist.
    return { found: true, hasStats: false, epicUsername: player.epicUsername };
  }

  // Fetched only once we know there's a real score to rank — the "registered but never scraped"
  // branch above already returned, so this never pays for a full scan on a lookup that couldn't
  // use it anyway.
  const allPlayers = await getAllScoredPlayers();
  const pools = buildScorePools(allPlayers);

  return {
    found: true,
    hasStats: true,
    epicUsername: player.epicUsername,
    creative: buildCreativeElo(player, pools),
    tournaments: buildTournamentElo(player, pools),
  };
}

module.exports = { getPublicElo };
