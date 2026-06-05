function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeGoogleMaps({ browser, query, city, maxResults = 20 }) {
  const page = await browser.newPage();

  // Minimize memory: block images, fonts, CSS
  await page.setRequestInterception(true);
  const blockedTypes = new Set(['image', 'stylesheet', 'font', 'media', 'other']);
  page.on('request', req => {
    if (blockedTypes.has(req.resourceType())) return req.abort();
    req.continue();
  });

  await page.setViewport({ width: 800, height: 600 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  page.setDefaultTimeout(20000);

  const url = `https://www.google.com/maps/search/${encodeURIComponent(query + ' ' + city)}/`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log(`[Scraper] goto warning: ${e.message}`);
  }

  try {
    await page.waitForSelector('a[href*="/maps/place/"], [role="feed"]', { timeout: 15000 });
  } catch {}
  await sleep(3000);

  const results = [];
  let prevCount = 0;

  for (let attempt = 0; attempt < 15 && results.length < maxResults; attempt++) {
    await sleep(1500);

    const items = await page.evaluate(() => {
      const data = [];
      const cards = document.querySelectorAll('a[href*="/maps/place/"], .Nv2PK, [role="feed"] > div > div');
      const seen = new Set();
      for (const card of cards) {
        const name = card.querySelector('.fontHeadlineSmall, .qBF1Pd, h3')?.textContent?.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);

        const phone = card.querySelector('a[href^="tel:"]')?.getAttribute('href')?.replace('tel:', '')?.trim() || '';

        let address = '';
        const addrEl = card.querySelector('[itemprop="address"], .Ahnjwc, .W4Efsd');
        if (addrEl) {
          const t = addrEl.textContent.trim();
          if (t.includes(',') || t.includes(' ') && t.length > 8) address = t;
        }

        let rating = '';
        const rEl = card.querySelector('[role="img"][aria-label*="star"], [aria-label*="stars"]');
        if (rEl) rating = rEl.getAttribute('aria-label') || '';
        else {
          const r2 = card.querySelector('.MW4etd');
          if (r2) rating = r2.textContent.trim();
        }

        const link = card.querySelector('a[href*="maps/place"]')?.getAttribute('href') || card.getAttribute('href') || '';
        data.push({ name, phone, address, rating, link });
      }
      return data;
    });

    for (const item of items) {
      if (results.length >= maxResults) break;
      const phone = item.phone.replace(/[^0-9]/g, '').slice(-11);
      const key = phone || item.name;
      if (results.some(r => (r.phone || r.business_name) === key)) continue;
      results.push({
        business_name: item.name, phone,
        address: item.address, rating: item.rating,
        city, niche: query,
        google_maps_url: item.link.startsWith('http') ? item.link : `https://www.google.com${item.link}`,
        status: 'new', source: 'scrape',
      });
    }

    if (items.length === prevCount && attempt > 5) break;
    prevCount = items.length;
    try { await page.evaluate(() => { const f = document.querySelector('[role="feed"]'); if (f) f.scrollBy(0, 800); window.scrollBy(0, 400); }); } catch {}
  }

  await page.close();
  return results;
}

module.exports = { scrapeGoogleMaps };