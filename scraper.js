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
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  } catch (e) {
    console.log(`[Scraper] goto timeout for ${query} ${city}, trying to continue anyway`);
  }
  await sleep(5000);

  const results = [];
  let prevCount = 0;
  let attempts = 0;

  while (results.length < maxResults && attempts < 25) {
    await sleep(2500);

    const items = await page.evaluate(() => {
      const cards = document.querySelectorAll('[role="feed"] > div > div, .m6QErb .NrDZNb, a[href*="/maps/place/"], .Nv2PK');
      const seen = new Set();
      const data = [];
      for (const card of cards) {
        const nameEls = card.querySelectorAll('.fontHeadlineSmall, .qBF1Pd, .fontBodyMedium');
        let name = '';
        for (const el of nameEls) { name = el.textContent?.trim(); if (name) break; }
        if (!name || seen.has(name)) continue;
        seen.add(name);

        const phoneEl = card.querySelector('a[data-tooltip*="Phone"], a[href^="tel:"]');
        const phone = phoneEl?.getAttribute('href')?.replace('tel:', '')?.trim() || '';

        const addressEls = card.querySelectorAll('.fontBodyMedium .W4Efsd, .Ahnjwc, .W4Efsd');
        let address = '';
        for (const el of addressEls) { address = el.textContent?.trim(); if (address && address.length > 5) break; }

        const ratingEl = card.querySelector('[aria-label*="stars"], .MW4etd');
        const rating = ratingEl?.getAttribute('aria-label') || ratingEl?.textContent?.trim() || '';

        const linkEl = card.querySelector('a[href*="maps/place"]');
        const mapsUrl = linkEl?.getAttribute('href') || '';

        data.push({ name, phone, address, rating, mapsUrl });
      }
      return data;
    });

    for (const item of items) {
      const phone = item.phone.replace(/[^0-9]/g, '').slice(-11);
      if (!phone) continue;
      const exists = results.some(r => r.phone === phone);
      if (!exists && results.length < maxResults) {
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
    }

    if (items.length === prevCount && attempts > 8) break;
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

  await page.close();
  return results;
}

module.exports = { scrapeGoogleMaps };
