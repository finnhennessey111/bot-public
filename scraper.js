const puppeteer = require('puppeteer');
const config = require('./config');
const { proxyLaunchArgs, authenticatePage, logProxyMode } = require('./proxy-config');
const { resolveRosterSize } = require('./roster-size');

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

async function scrapePlayerOnce(epicUsername, region = 'EU', epicId = null) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyLaunchArgs()]
  });

  try {
    const page = await browser.newPage();
    await authenticatePage(page);
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const slug = encodeURIComponent(epicUsername);
    const url = config.ftUrls[region]
      .replace('{slug}', slug)
      .replace('{epicId}', epicId ?? '');

    console.log(`Scraping: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: PLAYER_SCRAPE_NAV_TIMEOUT_MS });

    const data = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        const content = script.innerText || script.textContent;
        if (content.includes('const profile =')) {
          const match = content.match(/const profile = ({.*?});/s);
          if (match) return JSON.parse(match[1]);
        }
      }
      return null;
    });

    if (!data) throw new Error(`Could not find profile data for: ${epicUsername}`);

    return parseProfileData(data);

  } finally {
    await browser.close();
  }
}

// Delegates through module.exports (not a direct call to scrapePlayerOnce) so a test can swap in
// a fake single-attempt implementation without needing a real Puppeteer/network round trip — the
// exported function is what actually gets called, same as any other real caller.
async function scrapePlayer(epicUsername, region = 'EU', epicId = null) {
  for (let attempt = 1; attempt <= PLAYER_SCRAPE_MAX_ATTEMPTS; attempt++) {
    try {
      return await module.exports.scrapePlayerOnce(epicUsername, region, epicId);
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

function parseProfileData(data) {
  const totalPR = extractPowerRank(data.powerRank);
  const prBand = extractPRBand(data.powerRank);

  // Match the player's segment for the site's authoritative current season — not just
  // whichever season segment they happen to have the highest number for. A player who
  // hasn't played the current season has no segment for it, and should show 0, not fall
  // back to their last-active season's points.
  let thisSeasonPR = 0;
  if (data.prSegments && data.currentSeason != null) {
    const currentSeasonSegment = data.prSegments.find(
      s => s.segmentType === 'season' && Number(s.segmentValue) === Number(data.currentSeason)
    );
    thisSeasonPR = currentSeasonSegment?.points ?? 0;
  }

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

function getPlacementScore(placement) {
  if (!placement) return 0;
  for (const band of config.placementScores) {
    if (placement <= band.threshold) return band.score;
  }
  return 0;
}

// soloModifier deliberately excludes ranked-cup events (name matches /ranked/i) even though
// they're otherwise eligible (rosterSize === 1): ranked cups have easy lobbies and no real
// stakes, so strong results there don't indicate real skill and must never feed this signal.
// This exclusion is specific to soloModifier's use of results as a GENERAL skill signal — it
// does NOT apply to ownTournamentModifier below, where self-referential history for the exact
// same tournament (even if that tournament is a ranked cup) is always a fair signal.
//
// Returns the individual modifiers alongside the final matchScore — used by queue.js's
// buildPlayer and creative-queue.js's buildCreativePlayer, both of which stamp soloModifier (not
// just the final score) onto the built player object so feedback.js can snapshot it verbatim at
// match time rather than re-deriving it later from a possibly-since-changed recentEvents history.
// calculateMatchScore below is unchanged for every existing caller — just now implemented in
// terms of this.
function computeMatchScoreBreakdown(playerData, tournamentName, homeRegion, queueRegion) {
  const base = (playerData.totalPR * 10) + (playerData.thisSeasonPR * 5);

  const ownTournamentEvents = playerData.recentEvents
    .filter(e => e.name === tournamentName)
    .slice(0, 3);
  const ownTournamentModifier = ownTournamentEvents.length > 0
    ? (ownTournamentEvents.reduce((sum, e) => sum + getPlacementScore(e.placement), 0) / ownTournamentEvents.length / 100) * 0.30
    : 0;

  const soloEvents = playerData.recentEvents
    .filter(e => e.rosterSize === 1 && !/ranked/i.test(e.name))
    .slice(0, 5);

  let soloModifier = 0;
  if (soloEvents.length > 0) {
    const placementQuality = (soloEvents.reduce((sum, e) => sum + getPlacementScore(e.placement), 0) / soloEvents.length) / 100;
    const killsQuality = Math.min((soloEvents.reduce((sum, e) => sum + e.elims, 0) / soloEvents.length) / 45, 1);
    const soloSignal = (placementQuality * 0.7) + (killsQuality * 0.3);
    soloModifier = soloSignal * 0.35;
  }

  const regionPenalty = homeRegion !== queueRegion
    ? (config.regionPenalties[homeRegion]?.[queueRegion] ?? 0)
    : 0;

  const matchScore = Math.round(base * (1 + soloModifier + ownTournamentModifier - regionPenalty));

  return { matchScore, base, ownTournamentModifier, soloModifier, regionPenalty };
}

function calculateMatchScore(playerData, tournamentName, homeRegion, queueRegion) {
  return computeMatchScoreBreakdown(playerData, tournamentName, homeRegion, queueRegion).matchScore;
}

module.exports = { scrapePlayer, scrapePlayerOnce, calculateMatchScore, computeMatchScoreBreakdown };