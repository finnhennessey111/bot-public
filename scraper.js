const puppeteer = require('puppeteer');
const config = require('./config');
const { proxyLaunchArgs, authenticatePage, blockUnnecessaryResources, logProxyMode, withBrowserSlot, closeBrowserSafely } = require('./proxy-config');
const { resolveRosterSize } = require('./roster-size');
const epicApi = require('./epic-api');

logProxyMode('scraper');

// Same retry-with-backoff shape used elsewhere in this codebase for rotating-proxy Puppeteer
// scrapes — a rotating proxy gets a different exit IP each attempt, and some IPs get through
// cleanly, so a single Puppeteer navigation timeout (a known, occasional occurrence, not a real
// failure of the target site) used to fail this player's entire queue attempt outright and surface
// a raw error. This makes that the rare last-resort after 3 attempts, not the first-attempt norm.
//
// Investigated a real production failure where all 3 attempts hit the identical 15s timeout
// despite the paid rotating-residential-proxy plan (Webshare) this should be rare on. Confirmed
// (with a real test, see test/scraper-fresh-browser-per-attempt.test.js) that each attempt already
// launches a genuinely fresh puppeteer.launch() browser — the previous one is fully closed before
// the next launches, no shared browser/page/connection across retries. That rules out the most
// obvious client-side cause. The likely remaining explanation: rotating-residential-proxy backends
// commonly apply some form of session/connection affinity for a short window per authenticated
// user (to avoid needless backend IP churn), independent of the *local* connection being brand
// new — so repeat attempts using the same static PROXY_USERNAME/PROXY_PASSWORD only 1.5s apart
// could plausibly land in the same rotation window and get the same exit IP every time. This value
// was widened from 1.5s specifically to give that window more room to roll over between attempts.
// Not independently verified against Webshare's actual backend (no live proxy credentials were
// available to test this against) — if attempts still cluster on the same IP, check Webshare's
// dashboard/docs for an explicit per-request vs sticky-session rotation setting (or a session-
// suffix convention for the proxy username) rather than guessing at one here.
const PLAYER_SCRAPE_MAX_ATTEMPTS = 3;
const PLAYER_SCRAPE_RETRY_DELAY_MS = 8000;

// Every real successful scrape observed (manual tests and production) finishes in 2-15s — 30s was
// sized to catch a genuinely hung request, not describe the normal case, and burning the full 30s
// before a bad exit IP's attempt gets abandoned made each retry cycle needlessly slow. 15s stays
// comfortably above every observed real completion time while still meaningfully speeding up how
// fast a bad attempt fails and retries.
const PLAYER_SCRAPE_NAV_TIMEOUT_MS = 15000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// The browser's whole launch-through-close lifetime runs inside withBrowserSlot (proxy-config.js)
// so no more than MAX_CONCURRENT_BROWSERS headless Chromium processes are ever alive at once
// across the whole bot — see that function's header comment for why (a thundering herd of
// simultaneous scrapes, e.g. every registered player's cache expiring the instant a tournament
// goes live, is a real path to exhausting a small VPS's memory).
// platformSegment is a real Fortnite Tracker input-method URL segment (config.ftPlatformSegments —
// confirmed live: kbm, gamepad, touch, all). Defaults to 'all' (the combined/every-input segment,
// prior behavior unchanged) — only players.js's getStatsForContext ever passes a specific segment,
// for the one (region, platform) context a queueing player actually needs.
async function scrapePlayerOnce(epicUsername, region = 'EU', epicId = null, platformSegment = 'all') {
  return withBrowserSlot(async () => {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyLaunchArgs()]
    });

    try {
      const page = await browser.newPage();
      await authenticatePage(page);
      await blockUnnecessaryResources(page);
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      const slug = encodeURIComponent(epicUsername);
      const url = config.ftUrlTemplate
        .replace('{platform}', platformSegment)
        .replace('{slug}', slug)
        .replace('{region}', region)
        .replace('{epicId}', epicId ?? '');

      console.log(`Scraping: ${url}`);
      // domcontentloaded, not networkidle2: the profile data this scrape needs is server-rendered
      // into a <script> tag in the initial HTML document (confirmed live — present and fully parseable
      // immediately at domcontentloaded, before any images/analytics finish), so waiting for it doesn't
      // require network activity to go fully quiet. networkidle2 additionally waits for every
      // sub-resource (this page's tournament banner images, analytics beacons, ad-tech calls) to settle
      // — including ones a rotating residential proxy plan may be unable to reach at all (e.g. Webshare
      // dashboard evidence showing a real, non-flaky 32.83% client_connect_forbidden_host block rate
      // specifically for cdn2.unrealengine.com), which would hang the whole navigation until timeout
      // regardless of exit IP. domcontentloaded only waits on the main document, so a permanently-
      // blocked unrelated asset can no longer stall a scrape that already has everything it needs.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PLAYER_SCRAPE_NAV_TIMEOUT_MS });

      const { profile, thisSeasonPR: domThisSeasonPR } = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script'));
        let profile = null;
        for (const script of scripts) {
          const content = script.innerText || script.textContent;
          if (content.includes('const profile =')) {
            const match = content.match(/const profile = ({.*?});/s);
            if (match) { profile = JSON.parse(match[1]); break; }
          }
        }

        // The live "This Season" PR figure is a continuously-decayed number Fortnite Tracker only
        // ever server-renders as display text (e.g. "40,262") — confirmed absent from `profile`
        // above (and every other <script> tag) via a full-payload search against a real, live
        // account. profile.prSegments' matching season entry is a DIFFERENT, static, non-decaying
        // historical total that meaningfully OVERSTATES the real current value — confirmed ~16-18%
        // high on two independent real accounts — so it's read from the rendered DOM instead.
        // Structure confirmed live: a `.profile-stat__label` div whose text is exactly "This
        // Season", sharing a `.profile-stat__container` parent with a sibling `.profile-stat__value`
        // div holding the formatted number (both as its title attribute and its text content).
        function extractStatValue(label) {
          const labelEl = Array.from(document.querySelectorAll('.profile-stat__label'))
            .find(el => el.textContent.trim() === label);
          if (!labelEl) return null; // confirmed: this whole block doesn't render at all for a player with no competitive/PR history
          const valueEl = labelEl.parentElement?.querySelector('.profile-stat__value');
          if (!valueEl) return null;
          const raw = (valueEl.getAttribute('title') || valueEl.textContent || '').trim();
          const num = Number(raw.replace(/,/g, ''));
          return Number.isFinite(num) ? num : null;
        }

        return { profile, thisSeasonPR: extractStatValue('This Season') };
      });

      if (!profile) throw new Error(`Could not find profile data for: ${epicUsername}`);

      return parseProfileData(profile, domThisSeasonPR);

    } finally {
      await closeBrowserSafely(browser);
    }
  });
}

// Delegates through module.exports (not a direct call to scrapePlayerOnce) so a test can swap in
// a fake single-attempt implementation without needing a real Puppeteer/network round trip — the
// exported function is what actually gets called, same as any other real caller.
async function scrapePlayer(epicUsername, region = 'EU', epicId = null, platformSegment = 'all') {
  for (let attempt = 1; attempt <= PLAYER_SCRAPE_MAX_ATTEMPTS; attempt++) {
    try {
      return await module.exports.scrapePlayerOnce(epicUsername, region, epicId, platformSegment);
    } catch (err) {
      console.log(`  [scraper:${epicUsername}] attempt ${attempt}/${PLAYER_SCRAPE_MAX_ATTEMPTS} threw: ${err.message}`);
      if (attempt < PLAYER_SCRAPE_MAX_ATTEMPTS) {
        await sleep(PLAYER_SCRAPE_RETRY_DELAY_MS);
        continue;
      }
      throw new Error(`profile scrape for ${epicUsername} failed after ${PLAYER_SCRAPE_MAX_ATTEMPTS} attempts (last error: ${err.message})`);
    }
  }
}

function parseProfileData(data, domThisSeasonPR) {
  const totalPR = extractPowerRank(data.powerRank);
  const prBand = extractPRBand(data.powerRank);

  // domThisSeasonPR comes from the rendered page's own "This Season" stat (scrapePlayerOnce's
  // page.evaluate) — the real, live, decayed figure. data.prSegments' season-matching entry is
  // deliberately NOT used, even as a fallback: it's a different, static, non-decaying historical
  // total confirmed to meaningfully OVERSTATE the real current value (~16-18% high on two
  // independent real accounts), so falling back to it on a failed DOM read would silently
  // reintroduce the exact bug this fixes. null (DOM block genuinely absent — confirmed true for a
  // player with no competitive/PR history at all, not a markup-change false negative in the cases
  // checked) defaults to 0, same as "hasn't played this season" always meant here.
  const thisSeasonPR = domThisSeasonPR ?? 0;

  const recentEvents = [];
  if (data.myEvents) {
    for (const event of data.myEvents) {
      if (!event.isPrEvent) continue;
      const name = event.displayMetadata?.title_line_1?.trim() ?? 'Unknown';

      // Real scrapes show event.rosterSize coming back null across the board — FT Tracker doesn't
      // populate it on this payload shape — so fall back to the manually-verified override map,
      // then a title keyword. If neither resolves it (e.g. some skin/creator cups have no
      // team-size word AND aren't in the override map yet), leave it null rather than guessing a
      // default: soloModifier's rosterSize === 1 check just won't count this event either way, but
      // a wrong guess could make it count (or wrongly exclude it) silently. Logged so unclassified
      // titles stay visible.
      let rosterSize = event.rosterSize ?? null;
      if (rosterSize == null) {
        rosterSize = resolveRosterSize(name.toLowerCase());
        if (rosterSize == null) {
          console.warn(`⚠️ Could not determine roster size for event "${name}" — no rosterSize field and no team-size keyword in title. Leaving unclassified.`);
        }
      }

      for (const window of event.windows ?? []) {
        recentEvents.push({
          name,
          date: window.beginTime ?? null,
          placement: window.data?.rank ?? null,
          prPoints: window.powerRankingData?.points ?? 0,
          rosterSize,
          matches: window.data?.matchesPlayed ?? 0,
          wins: window.data?.wins ?? 0,
          elims: window.data?.kills ?? 0,
          kd: window.data?.kdRatio ?? 0,
        });
      }
    }
  }

  recentEvents.sort((a, b) => new Date(b.date) - new Date(a.date));

  // calculateMatchScore only ever reads at most 8 (3 for ownTournamentModifier, 5 for
  // soloModifier), so cap well above that to bound what gets stored without risking either signal.
  const cappedRecentEvents = recentEvents.slice(0, 20);

  return { totalPR, thisSeasonPR, prBand, recentEvents: cappedRecentEvents };
}

function extractPowerRank(powerRank) {
  if (!powerRank) return 0;
  if (typeof powerRank === 'number') return powerRank;
  if (typeof powerRank === 'object') return powerRank.points ?? powerRank.pr ?? powerRank.rank ?? 0;
  return 0;
}

// FT Tracker's Power Ranking groups players into named bands (e.g. "Unreal", "Elite",
// "Contender") — field name isn't fixed across profile payload shapes, so try the known
// candidates and fall back to null rather than guessing.
function extractPRBand(powerRank) {
  if (!powerRank || typeof powerRank !== 'object') return null;
  return powerRank.band ?? powerRank.bandName ?? powerRank.rankName ?? powerRank.tier ?? null;
}

// Averages an event's already-decayed Power Ranking contribution (prPoints — window.
// powerRankingData.points, confirmed live against a real account with genuinely old events: e.g.
// a Dec 2025 "Solo Series Qualifiers" showed prPoints 8.26 against a pointsNoDecay of 11.8, an 11.34
// point recorded loss on a Mar 2025 "Solo Cash Cup" matching prPoints 4.86 vs pointsNoDecay 16.2 —
// exact matches, both events, confirming prPoints IS the live decayed figure already, not a static
// pre-decay total the way profile.prSegments' season total turned out to be for thisSeasonPR).
// Fortnite Tracker's own decay curve is used as-is here — no separate recency weighting is applied
// on top of it, deliberately: building a second, independent decay system would either fight
// Tracker's own curve or double-count recency, and Tracker's number already reflects genuine
// recency-weighted form on its own.
function averagePrPoints(events) {
  return events.reduce((sum, e) => sum + (e.prPoints ?? 0), 0) / events.length;
}

// currentPR is the denominator every modifier is expressed against (see computeMatchScoreBreakdown
// below) — a genuine percentage of Current PR, not a 0-100 placement-bucket score. currentPR <= 0
// (no PR yet, e.g. a brand new unlinked-but-queued account) has nothing to express a percentage
// against, so this returns 0 rather than dividing by zero — same "no signal, never a penalty"
// shape as the no-history case just above it.
//
// Extracted from computeMatchScoreBreakdown below so elo.js's public ELO lookup can reuse the
// EXACT same own-tournament-history formula against a broader match predicate — a permanent
// tournament TYPE (e.g. "FNCS Division") needs to match whichever numbered division a player
// actually has recorded history in (e.g. "FNCS Division 2"), not one fixed exact title, unlike
// every existing real-time caller (queue.js, creative-queue.js), which always matches one exact
// tournamentName. matchesEvent is `e => boolean` — computeMatchScoreBreakdown below passes
// `e => e.name === tournamentName`, preserving its exact prior behavior unchanged.
function computeOwnTournamentModifier(recentEvents, matchesEvent, currentPR) {
  const ownTournamentEvents = recentEvents.filter(matchesEvent).slice(0, 3);
  if (ownTournamentEvents.length === 0 || !(currentPR > 0)) {
    return { modifier: 0, hasHistory: ownTournamentEvents.length > 0, matchedEvents: ownTournamentEvents };
  }

  const modifier = (averagePrPoints(ownTournamentEvents) / currentPR) * 0.30;
  return { modifier, hasHistory: true, matchedEvents: ownTournamentEvents };
}

// soloModifier deliberately excludes ranked-cup events (name matches /ranked/i) even though
// they're otherwise eligible (rosterSize === 1): ranked cups have easy lobbies and no real
// stakes, so strong results there don't indicate real skill and must never feed this signal.
// This exclusion is specific to soloModifier's use of results as a GENERAL skill signal — it
// does NOT apply to ownTournamentModifier below, where self-referential history for the exact
// same tournament (even if that tournament is a ranked cup) is always a fair signal.
//
// Real solo-event source confirmed unchanged: derived by filtering the player's own already-scraped
// recentEvents (rosterSize === 1, title not ranked) rather than a dedicated Fortnite Tracker
// playlist=solo fetch — investigated live: playlist=solo has no filtering effect on the per-player
// profile URL (identical unfiltered results with or without it) and doesn't isolate solo-only
// results on the tournament calendar URL either, so there's no real "corrected URL" to switch to.
//
// No region argument anymore: this used to also take homeRegion/queueRegion to apply a
// cross-region penalty when they differed, but that penalty is gone now that playerData ITSELF is
// already the correct region+platform-specific snapshot by the time it gets here (players.js's
// getStatsForContext resolves which context to scrape before this ever runs) — there is no longer
// a separate "penalize the mismatch" step because there is no mismatch left to penalize.
//
// Returns the individual modifiers alongside the final matchScore — used by queue.js's
// buildPlayer and creative-queue.js's buildCreativePlayer, both of which stamp soloModifier (not
// just the final score) onto the built player object so feedback.js can snapshot it verbatim at
// match time rather than re-deriving it later from a possibly-since-changed recentEvents history.
// calculateMatchScore below is unchanged for every existing caller — just now implemented in
// terms of this.
//
// PR-NATIVE FORMULA: Total = Current PR × (1 + soloModifier + ownTournamentModifier). base is
// Current PR itself now — the old (totalPR*10 + thisSeasonPR*5) blend is gone entirely (thisSeasonPR
// is a deliberately-removed input, not an oversight: a blunt, unfiltered seasonal aggregate that
// doesn't fit the "targeted, relevant recent form" philosophy soloModifier/ownTournamentModifier
// both follow), and both modifiers are now genuine percentage boosts on Current PR (each qualifying
// event's decayed prPoints as a fraction of currentPR, weighted the same 0.30/0.35 as before) rather
// than a 0-100 placement-bucket score applied on top of a pre-scaled base. matchScore is therefore
// inherently PR-equivalent by construction — no ×10/÷10 conversion needed anywhere this is
// displayed (Discord or the website).
function computeMatchScoreBreakdown(playerData, tournamentName) {
  const currentPR = playerData.totalPR;

  const { modifier: ownTournamentModifier } = computeOwnTournamentModifier(
    playerData.recentEvents, e => e.name === tournamentName, currentPR
  );

  const soloEvents = playerData.recentEvents
    .filter(e => e.rosterSize === 1 && !/ranked/i.test(e.name))
    .slice(0, 5);

  const soloModifier = (soloEvents.length > 0 && currentPR > 0)
    ? (averagePrPoints(soloEvents) / currentPR) * 0.35
    : 0;

  const matchScore = Math.round(currentPR * (1 + soloModifier + ownTournamentModifier));

  // soloEvents included alongside soloModifier — the exact (up to 5) events the modifier above was
  // actually computed from, not a re-derived approximation — so a caller (elo.js's public ELO
  // lookup) can show real example events behind the number instead of just the number itself.
  // base is Current PR — kept as the field name (not renamed to currentPR) since every existing
  // caller already reads .base as "the PR-only baseline before modifiers", which is still exactly
  // what it means; only its underlying VALUE changed (no ×10/×5 blend), not its role.
  return { matchScore, base: currentPR, ownTournamentModifier, soloModifier, soloEvents };
}

function calculateMatchScore(playerData, tournamentName) {
  return computeMatchScoreBreakdown(playerData, tournamentName).matchScore;
}

// Real-tournament-only upgrade path: computes the exact same breakdown as
// computeMatchScoreBreakdown above (base + soloModifier both stay Fortnite-Tracker-sourced, per
// the explicit decision to keep those two on FT — Epic's own PR only covers the top 10,000 players,
// and its per-event history needs a player OAuth token this bot can't require of everyone), then
// tries to upgrade ownTournamentModifier specifically using Epic's own recorded placement data
// (epic-api.js's getEpicOwnTournamentModifier) — a direct rank/points lookup for this exact
// tournament+region+player instead of scanning Fortnite Tracker's capped recentEvents for a name
// match. `tournament` needs { name, eventId, region } — eventId is tournament-scraper.js's own
// scraped identifier (confirmed live to be the same real Epic eventId the matches endpoint wants).
// Falls back to the plain FT-derived breakdown on absolutely any gap (no eventId, no Epic calendar
// match, no player standing found, a network/API failure) — this never throws, and never leaves a
// queue-join without a score. Only queue.js's buildPlayer (real tournaments) calls this — creative-
// queue.js and elo.js call computeMatchScoreBreakdownWithTierComparison instead (below), since
// neither has a real Epic-trackable tournament to look up, but both still want the (also async)
// tier-comparison modifier this function itself applies at the very end, via the shared
// applyTierComparisonModifier helper.
async function computeMatchScoreBreakdownWithEpic(playerData, tournament, accountId) {
  const breakdown = computeMatchScoreBreakdown(playerData, tournament?.name);

  // getEpicOwnTournamentModifier no longer needs tournament.eventId — it resolves Epic's own real
  // per-region eventId itself, from a fresh name+region calendar lookup (see epic-api.js's doc
  // comment on why: the value threaded through here meant different things depending on which
  // discovery path produced it, so trusting Epic's own freshly-resolved id is both simpler and more
  // correct). Only name/region/accountId are actually required to attempt it. currentPR (breakdown.
  // base) is threaded through so Epic's own modifier can be expressed as the same PR-native
  // percentage the FT-derived one is, not a separate placement-bucket score.
  //
  // Still runs applyTierComparisonModifier even when Epic can't be attempted at all — tier-
  // comparison doesn't need tournament/accountId info, only playerData, so a missing eventId/region/
  // accountId should never silently skip it too.
  if (!tournament?.name || !tournament?.region || !accountId) {
    return applyTierComparisonModifier(breakdown, playerData);
  }

  let epicResult = null;
  try {
    epicResult = await epicApi.getEpicOwnTournamentModifier(tournament, accountId, breakdown.base);
  } catch (err) {
    console.warn(`[scraper] Epic own-tournament lookup threw for "${tournament.name}" — falling back to Fortnite Tracker history: ${err.message}`);
  }

  if (!epicResult) {
    return applyTierComparisonModifier(breakdown, playerData);
  }

  const matchScore = Math.round(breakdown.base * (1 + breakdown.soloModifier + epicResult.modifier));
  return applyTierComparisonModifier(
    { ...breakdown, matchScore, ownTournamentModifier: epicResult.modifier, ownTournamentSource: 'epic' },
    playerData
  );
}

// Layers tier-comparison.js's real-band-based modifier onto an already-computed breakdown (FT-only
// or Epic-upgraded — either shape works, this only reads breakdown.base/soloModifier/
// ownTournamentModifier and playerData.recentEvents/totalPR). Deferred require: tier-comparison.js
// requires players.js, which itself requires this file (scrapePlayer) — requiring tier-comparison.js
// back at this file's own top level would be a real circular require depending on which module
// happens to load first (same category of issue guild-config.js's matchmaker-setup migration
// already deferred a require to avoid — see that file's own doc comment on the same pattern).
// Deferring until this function actually runs sidesteps it entirely, since by call time every
// module involved has already finished loading.
//
// Fails soft on absolutely anything (a DB hiccup, tier-comparison.js throwing) — same "never leaves
// a queue-join without a score" guarantee computeMatchScoreBreakdownWithEpic's own Epic lookup
// already has. hasSignal:false (the real, expected, common case — see tier-comparison.js's top doc
// comment on real current player count) is a normal, non-error result, not something this needs to
// catch.
async function applyTierComparisonModifier(breakdown, playerData) {
  const { getTierComparisonModifier } = require('./tier-comparison');

  let tierResult;
  try {
    tierResult = await getTierComparisonModifier(playerData);
  } catch (err) {
    console.warn(`[scraper] Tier-comparison lookup threw — falling back to no tier modifier: ${err.message}`);
    return { ...breakdown, tierModifier: 0, tierComparisonHasSignal: false };
  }

  if (!tierResult.hasSignal) {
    return { ...breakdown, tierModifier: 0, tierComparisonHasSignal: false };
  }

  const matchScore = Math.round(
    breakdown.base * (1 + breakdown.soloModifier + breakdown.ownTournamentModifier + tierResult.modifier)
  );
  return {
    ...breakdown,
    matchScore,
    tierModifier: tierResult.modifier,
    tierComparisonHasSignal: true,
    tierComparisonInfo: { resemblance: tierResult.resemblance, ownBand: tierResult.ownBand, nextBand: tierResult.nextBand },
  };
}

// The non-Epic counterpart to computeMatchScoreBreakdownWithEpic — for callers with no real,
// Epic-trackable tournament context (creative-queue.js's creative matches; elo.js's public lookup,
// which deliberately never calls Epic live — see that file's own top doc comment on staying a fast,
// DB-only endpoint). Still layers the real tier-comparison modifier on top of the plain FT-derived
// breakdown, since tier-comparison isn't tournament-specific the way Epic's own placement lookup is
// — it's a general "does this player's own recent behavior resemble the tier above them" signal,
// equally applicable to a creative match or a generic tournament-type check as to a real tournament
// queue join.
async function computeMatchScoreBreakdownWithTierComparison(playerData, tournamentName) {
  const breakdown = computeMatchScoreBreakdown(playerData, tournamentName);
  return applyTierComparisonModifier(breakdown, playerData);
}

module.exports = {
  scrapePlayer, scrapePlayerOnce, calculateMatchScore, computeMatchScoreBreakdown,
  computeMatchScoreBreakdownWithEpic, computeMatchScoreBreakdownWithTierComparison, computeOwnTournamentModifier,
};