// One-off inspector — NOT part of the app, delete after use.
// Run with: node _inspect_schedule.js EU
// Requires the same PROXY_HOST/PROXY_PORT/PROXY_USERNAME/PROXY_PASSWORD env vars (or .env via
// dotenv, if this project loads it elsewhere) that the real scrapers use.
const puppeteer = require('puppeteer');
const fs = require('fs');
const { proxyLaunchArgs, authenticatePage, logProxyMode } = require('./proxy-config');

logProxyMode('inspect-schedule');

const region = process.argv[2] || 'EU';

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', ...proxyLaunchArgs()],
  });

  try {
    const page = await browser.newPage();
    await authenticatePage(page);
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const url = `https://www.fortnite.com/competitive/schedule?region=${region}`;
    console.log(`Navigating to ${url} ...`);
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log(`HTTP status: ${response.status()}`);

    const html = await page.content();
    fs.writeFileSync(`schedule_${region}.html`, html);
    console.log(`Wrote schedule_${region}.html (${html.length} bytes)`);

    // Look for a Next.js data blob or any embedded JSON script tags — dump keys/shape so we don't
    // have to eyeball a giant HTML file.
    const jsonBlobs = await page.evaluate(() => {
      const results = [];
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        const id = script.id || null;
        const type = script.type || null;
        const text = script.innerText || script.textContent || '';
        if (id === '__NEXT_DATA__' || text.includes('schedule') || text.includes('event') || text.includes('window.__')) {
          results.push({ id, type, length: text.length, preview: text.slice(0, 2000) });
        }
      }
      return results;
    });

    fs.writeFileSync(`schedule_${region}_jsonblobs.json`, JSON.stringify(jsonBlobs, null, 2));
    console.log(`Found ${jsonBlobs.length} candidate script tag(s), wrote schedule_${region}_jsonblobs.json`);

    // Also dump whatever text the page actually rendered, in case data is DOM-only (not JSON).
    const bodyText = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync(`schedule_${region}_bodytext.txt`, bodyText);
    console.log(`Wrote schedule_${region}_bodytext.txt (${bodyText.length} chars) — rendered visible text`);

  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('Inspector failed:', err);
  process.exit(1);
});
