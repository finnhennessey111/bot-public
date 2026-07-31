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

const { computeMatchScoreBreakdown, computeOwnTournamentModifier } = require('./scraper');
const { PERMANENT_KEYWORDS } = require('./tournament-scraper');
const { findCanonicalByEpicUsername } = require('./players');

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

// Splits a matchScore into UI-ready segments that sum EXACTLY to the total, for a segmented bar on
// the website — careerPR/seasonPR are already whole numbers (totalPR*10/thisSeasonPR*5, both
// integer inputs), but soloModifier/ownTournamentModifier are multiplicative percentages, so their
// absolute contribution can be fractional. soloPerformance absorbs whatever rounding remainder is
// left after career+season+ownTournament are each rounded independently, rather than every segment
// rounding on its own and the total silently drifting off by a point or two.
function toSegments({ base, soloModifier, ownTournamentModifier, totalPR, thisSeasonPR }) {
  const total = Math.round(base * (1 + soloModifier + ownTournamentModifier));
  const careerPR = Math.round(totalPR * 10);
  const seasonPR = Math.round(thisSeasonPR * 5);
  const ownTournamentPlacement = ownTournamentModifier > 0 ? Math.round(base * ownTournamentModifier) : 0;
  const soloPerformance = total - careerPR - seasonPR - ownTournamentPlacement;
  return { total, careerPR, seasonPR, ownTournamentPlacement, soloPerformance };
}

function buildCreativeElo(playerData, homeRegion) {
  const { base, soloModifier } = computeMatchScoreBreakdown(playerData, NEVER_MATCHES_A_REAL_TOURNAMENT, homeRegion, homeRegion);
  const { total, careerPR, seasonPR, soloPerformance } = toSegments({
    base, soloModifier, ownTournamentModifier: 0, totalPR: playerData.totalPR, thisSeasonPR: playerData.thisSeasonPR,
  });

  return {
    score: total,
    components: { careerPR, seasonPR, soloPerformance },
  };
}

function buildTournamentElo(playerData, homeRegion) {
  const { base, soloModifier } = computeMatchScoreBreakdown(playerData, NEVER_MATCHES_A_REAL_TOURNAMENT, homeRegion, homeRegion);

  return PERMANENT_KEYWORDS.map(keyword => {
    const { modifier: ownTournamentModifier, hasHistory } = computeOwnTournamentModifier(
      playerData.recentEvents, e => e.name.toLowerCase().includes(keyword)
    );

    const { total, careerPR, seasonPR, ownTournamentPlacement, soloPerformance } = toSegments({
      base, soloModifier, ownTournamentModifier, totalPR: playerData.totalPR, thisSeasonPR: playerData.thisSeasonPR,
    });

    return {
      tournamentType: labelForKeyword(keyword),
      hasHistory,
      score: total,
      components: {
        careerPR, seasonPR, soloPerformance,
        // Only present when there's real history — same "just the shared base, no extra modifier"
        // behavior computeMatchScoreBreakdown already has for any tournament a player hasn't
        // played (ownTournamentModifier is 0, so `total` here already equals the creative score
        // exactly); omitted rather than a 0 field so the website can tell "no history" apart from
        // "history that happened to score zero placement value" at a glance.
        ...(hasHistory ? { ownTournamentPlacement } : {}),
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

  if (player.totalPR == null) {
    // Registered/linked but never actually scraped yet (no queue attempt has ever happened for
    // this account) — nothing real to show. Distinct from "not found" so the website can render a
    // different, honest "no stats yet" message instead of implying the account doesn't exist.
    return { found: true, hasStats: false, epicUsername: player.epicUsername };
  }

  const homeRegion = player.region ?? 'EU';
  const playerData = {
    totalPR: player.totalPR ?? 0,
    thisSeasonPR: player.thisSeasonPR ?? 0,
    recentEvents: player.recentEvents ?? [],
  };

  return {
    found: true,
    hasStats: true,
    epicUsername: player.epicUsername,
    creative: buildCreativeElo(playerData, homeRegion),
    tournaments: buildTournamentElo(playerData, homeRegion),
  };
}

module.exports = { getPublicElo };
