const puppeteer = require('puppeteer');
const config = require('./config');

async function scrapePlayer(epicUsername, region = 'EU', epicId = null) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
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
      for (const window of event.windows ?? []) {
        recentEvents.push({
          name,
          date: window.beginTime ?? null,
          placement: window.data?.rank ?? null,
          prPoints: window.powerRankingData?.points ?? 0,
          rosterSize: event.rosterSize ?? null,
          matches: window.data?.matchesPlayed ?? 0,
          wins: window.data?.wins ?? 0,
          elims: window.data?.kills ?? 0,
          kd: window.data?.kdRatio ?? 0,
        });
      }
    }
  }

  recentEvents.sort((a, b) => new Date(b.date) - new Date(a.date));

  return { totalPR, thisSeasonPR, recentEvents };
}

function extractPowerRank(powerRank) {
  if (!powerRank) return 0;
  if (typeof powerRank === 'number') return powerRank;
  if (typeof powerRank === 'object') return powerRank.points ?? powerRank.pr ?? powerRank.rank ?? 0;
  return 0;
}

function getPlacementScore(placement) {
  if (!placement) return 0;
  for (const band of config.placementScores) {
    if (placement <= band.threshold) return band.score;
  }
  return 0;
}

function calculateMatchScore(playerData, tournamentName, homeRegion, queueRegion) {
  const tournamentEvents = playerData.recentEvents
    .filter(e => e.name === tournamentName)
    .slice(0, 3);

  const avgPlacementScore = tournamentEvents.length > 0
    ? tournamentEvents.reduce((sum, e) => sum + getPlacementScore(e.placement), 0) / tournamentEvents.length
    : 0;

  let matchScore = (playerData.totalPR * 10) + (playerData.thisSeasonPR * 5) + avgPlacementScore;

  if (homeRegion !== queueRegion) {
    const penalty = config.regionPenalties[homeRegion]?.[queueRegion] ?? 0;
    matchScore = matchScore * (1 - penalty);
  }

  return Math.round(matchScore);
}

module.exports = { scrapePlayer, calculateMatchScore };