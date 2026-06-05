function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeGoogleMaps({ browser, query, city, maxResults = 20 }) {
  const page = await browser.newPage();

  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  page.setDefaultTimeout(60000);

  const url = `https://www.google.com/maps/search/${encodeURIComponent(query + ' ' + city)}/`;
  console.log(`[Scraper] Navigating to ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (e) {
    console.log(`[Scraper] goto warning: ${e.message}`);
  }

  // Wait for either the results feed or a "no results" state
  try {
    await page.waitForSelector('[role="feed"], .section-result, a[href*="/maps/place/"], .Nv2PK, .hfpxzc', { timeout: 30000 });
  } catch {
    console.log('[Scraper] No feed selector found, page may have loaded differently');
  }
  await sleep(5000);

  const results = [];
  let prevCount = 0;
  let attempts = 0;

  while (results.length < maxResults && attempts < 30) {
    await sleep(2500);

    const items = await page.evaluate(() => {
      const data = [];

      // Try multiple selector strategies
      const allCards = document.querySelectorAll(
        '[role="feed"] > div > div, ' +
        'a[href*="/maps/place/"], ' +
        '.Nv2PK, ' +
        '.nr2S1f, ' +
        '[jsaction*="mouseover:pane"]'
      );

      const seen = new Set();
      for (const card of allCards) {
        // Skip if too small (likely not a result card)
        if (card.offsetWidth < 100 && card.offsetHeight < 30) continue;

        let name = '';
        const nameSelectors = [
          '.fontHeadlineSmall',
          '.qBF1Pd',
          '.fontBodyMedium',
          '.NrDZNb',
          'h3',
          '.section-result-title',
          '[role="heading"]',
        ];
        for (const sel of nameSelectors) {
          const el = card.querySelector(sel);
          if (el && el.textContent.trim()) { name = el.textContent.trim(); break; }
        }
        if (!name || seen.has(name)) continue;
        seen.add(name);

        const phoneEl = card.querySelector('a[data-tooltip*="Phone"], a[href^="tel:"]');
        const phone = phoneEl?.getAttribute('href')?.replace('tel:', '')?.trim() || '';

        let address = '';
        const addrSelectors = ['.W4Efsd', '.Ahnjwc', '.section-result-location', '.fontBodyMedium', '[itemprop="address"]'];
        for (const sel of addrSelectors) {
          const el = card.querySelector(sel);
          if (el && el.textContent.trim().length > 5) { address = el.textContent.trim(); break; }
        }

        const ratingEl = card.querySelector('[aria-label*="stars"], .MW4etd, [role="img"][aria-label]');
        let rating = '';
        if (ratingEl) {
          rating = ratingEl.getAttribute('aria-label') || ratingEl.textContent?.trim() || '';
        }

        const linkEl = card.querySelector('a[href*="maps/place"]');
        const mapsUrl = linkEl?.getAttribute('href') || card.getAttribute('href') || '';

        data.push({ name, phone, address, rating, mapsUrl });
      }
      return data;
    });

    // Filter and deduplicate
    for (const item of items) {
      const phone = item.phone.replace(/[^0-9]/g, '').slice(-11);
      if (!phone && !item.name) continue;
      const key = phone || item.name;
      if (results.some(r => r.phone && r.phone === key)) continue;
      if (results.some(r => !r.phone && r.business_name === item.name)) continue;
      if (results.length >= maxResults) break;

      results.push({
        business_name: item.name,
        phone,
        address: item.address,
        rating: item.rating,
        city,
        niche: query,
        google_maps_url: item.mapsUrl.startsWith('http') ? item.mapsUrl : `https://www.google.com${item.mapsUrl}`,
        status: 'new',
        source: 'scrape',
      });
    }

    if (items.length === prevCount && attempts > 10) break;
    prevCount = items.length;

    try {
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollBy(0, 1200);
        window.scrollBy(0, 800);
      });
    } catch {}
    attempts++;
  }

  console.log(`[Scraper] Found ${results.length} results for ${query} in ${city}`);
  await page.close();
  return results;
}

module.exports = { scrapeGoogleMaps };
