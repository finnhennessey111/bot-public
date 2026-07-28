const puppeteer = require('puppeteer');
const config = require('./config');
const { proxyLaunchArgs, authenticatePage, logProxyMode } = require('./proxy-config');
const { inferRosterSize } = require('./roster-size');

logProxyMode('scraper');

async function scrapePlayer(epicUsername, region = 'EU', epicId = null) {
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
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

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
      // populate it on this payload shape — so fall back to a title keyword. If the title has no
      // team-size word either (e.g. some skin/creator cups like "PlayStation Typical Gamer Icon
      // Cup Battle Royale"), leave it null rather than guessing a default: soloModifier's
      // rosterSize === 1 check just won't count this event either way, but a wrong guess could
      // make it count (or wrongly exclude it) silently. Logged so unclassified titles stay visible.
      let rosterSize = event.rosterSize ?? null;
      if (rosterSize == null) {
        rosterSize = inferRosterSize(name.toLowerCase());
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

module.exports = { scrapePlayer, calculateMatchScore, computeMatchScoreBreakdown };