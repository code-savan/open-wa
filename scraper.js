function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeGoogleMaps({ browser, query, city, maxResults = 20 }) {
  const page = await browser.newPage();

  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  page.setDefaultTimeout(30000);

  const url = `https://www.google.com/maps/search/${encodeURIComponent(query + ' ' + city)}/`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  } catch (e) {
    console.log(`[Scraper] goto warning: ${e.message}`);
  }
  try {
    await page.waitForSelector('a[href*="/maps/place/"], [role="feed"], .Nv2PK, .hfpxzc', { timeout: 20000 });
  } catch {}
  await sleep(4000);

  const results = [];
  let prevCount = 0;
  let attempts = 0;

  while (results.length < maxResults && attempts < 25) {
    await sleep(2000);

    const items = await page.evaluate(() => {
      const data = [];
      const cards = document.querySelectorAll('a[href*="/maps/place/"], .Nv2PK, [role="feed"] > div > div, .nr2S1f');
      const seen = new Set();
      for (const card of cards) {
        const nameEl = card.querySelector('.fontHeadlineSmall, .qBF1Pd, h3, [role="heading"]');
        const name = nameEl?.textContent?.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);

        const phoneEl = card.querySelector('a[href^="tel:"]');
        const phone = phoneEl?.getAttribute('href')?.replace('tel:', '')?.trim() || '';
        const addrEl = card.querySelector('.W4Efsd, .Ahnjwc, .fontBodyMedium');
        const address = addrEl?.textContent?.trim() || '';
        const ratingEl = card.querySelector('[aria-label*="stars"], [role="img"][aria-label]');
        const rating = ratingEl?.getAttribute('aria-label') || '';
        const linkEl = card.querySelector('a[href*="maps/place"]');
        const mapsUrl = linkEl?.getAttribute('href') || card.getAttribute('href') || '';
        data.push({ name, phone, address, rating, mapsUrl });
      }
      return data;
    });

    for (const item of items) {
      if (results.length >= maxResults) break;
      const phone = item.phone.replace(/[^0-9]/g, '').slice(-11);
      const key = phone || item.name;
      if (results.some(r => (r.phone || r.business_name) === key)) continue;
      results.push({
        business_name: item.name,
        phone,
        address: item.address, rating: item.rating,
        city, niche: query,
        google_maps_url: item.mapsUrl.startsWith('http') ? item.mapsUrl : `https://www.google.com${item.mapsUrl}`,
        status: 'new', source: 'scrape',
      });
    }

    if (items.length === prevCount && attempts > 8) break;
    prevCount = items.length;

    try { await page.evaluate(() => { const f = document.querySelector('[role="feed"]'); if (f) f.scrollBy(0, 1200); window.scrollBy(0, 800); }); } catch {}
    attempts++;
  }

  await page.close();
  return results;
}

module.exports = { scrapeGoogleMaps };
