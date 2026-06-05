function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeGoogleMaps({ browser, query, city, maxResults = 20 }) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  const url = `https://www.google.com/maps/search/${encodeURIComponent(query + ' ' + city)}/`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(4000);

  const results = [];
  let prevCount = 0;
  let attempts = 0;

  while (results.length < maxResults && attempts < 20) {
    await sleep(2000);

    const items = await page.evaluate(() => {
      const cards = document.querySelectorAll('[role="feed"] > div > div, .m6QErb .NrDZNb, a[href*="/maps/place/"]');
      const seen = new Set();
      const data = [];
      for (const card of cards) {
        const nameEl = card.querySelector('.fontHeadlineSmall, .qBF1Pd, .fontBodyMedium');
        const name = nameEl?.textContent?.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);

        const phoneEl = card.querySelector('a[data-tooltip*="Phone"], a[href^="tel:"]');
        const phone = phoneEl?.getAttribute('href')?.replace('tel:', '')?.trim() || '';

        const addressEl = card.querySelector('.fontBodyMedium .W4Efsd, .Ahnjwc, .fontBodyMedium');
        const address = addressEl?.textContent?.trim() || '';

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

    if (items.length === prevCount && attempts > 5) break;
    prevCount = items.length;

    await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      if (feed) feed.scrollBy(0, 1200);
      window.scrollBy(0, 800);
    });
    attempts++;
  }

  await page.close();
  return results;
}

module.exports = { scrapeGoogleMaps };
