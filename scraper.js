function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeGoogleMaps({ browser, query, city, maxResults = 20 }) {
  const page = await browser.newPage();

  // Block unnecessary resource types to save memory
  await page.setRequestInterception(true);
  const blocked = new Set(['image', 'stylesheet', 'font', 'media']);
  page.on('request', req => {
    if (blocked.has(req.resourceType())) return req.abort();
    req.continue();
  });

  await page.setViewport({ width: 1200, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  page.setDefaultTimeout(30000);

  const searchQuery = `${query} in ${city}`;
  const url = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&gl=ng&hl=en`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log(`[Scraper] goto warning: ${e.message}`);
  }

  // Wait for local results or organic results
  try {
    await page.waitForSelector('[data-local-ads], [data-hveid], .VkpGBb, .YmvwI, .rllt__link, a[href*="maps/place"]', { timeout: 15000 });
  } catch {}
  await sleep(3000);

  const results = [];
  let seenNames = new Set();
  let prevCount = 0;

  for (let attempt = 0; attempt < 20 && results.length < maxResults; attempt++) {
    await sleep(2000);

    const items = await page.evaluate(() => {
      const data = [];

      // Try multiple selectors for local business listings
      const cards = document.querySelectorAll(
        '.VkpGBb, ' +           // local result card
        '.rllt__link, ' +       // result link
        '.YmvwI, ' +            // another local result
        '[data-local-ads] > div, ' +
        '.du5Ggc, ' +           // knowledge panel card
        'a[href*="maps/place/"]'
      );

      const seen = new Set();
      for (const card of cards) {
        let name = '';
        const nameSels = ['.dbg0pd', '.lW9g3e', '.OSrXXb', '.qBF1Pd', '.fontHeadlineSmall', 'h3'];
        for (const s of nameSels) {
          const el = card.querySelector(s);
          if (el && el.textContent.trim()) { name = el.textContent.trim(); break; }
        }
        if (!name || name.length < 2 || seen.has(name)) continue;
        seen.add(name);

        // Phone number
        let phone = '';
        const phoneEl = card.querySelector('a[href^="tel:"], [data-phone-number], [aria-label*="phone"], .zdqRlf');
        if (phoneEl) {
          phone = phoneEl.getAttribute('href')?.replace('tel:', '')?.trim()
                || phoneEl.getAttribute('data-phone-number')
                || phoneEl.textContent.trim();
        }
        // Fallback: search for phone pattern in text
        if (!phone) {
          const allText = card.textContent;
          const m = allText.match(/[\+\(]?[\d\s\-\(\)]{7,15}/);
          if (m) phone = m[0].trim();
        }

        // Address
        let address = '';
        const addrSels = ['.rllt__details div:nth-child(2)', '.lW9g3e', '.YhemCb', '.W4Efsd', '.Ahnjwc'];
        for (const s of addrSels) {
          const el = card.querySelector(s);
          if (el) { const t = el.textContent.trim(); if (t.length > 5) { address = t; break; } }
        }

        // Rating
        let rating = '';
        const rSels = ['[role="img"][aria-label*="star"]', '.MW4etd', '.YhemCb', '.hqzQac'];
        for (const s of rSels) {
          const el = card.querySelector(s);
          if (el) {
            rating = el.getAttribute('aria-label') || el.textContent.trim();
            if (rating) break;
          }
        }

        // Maps URL
        const link = card.getAttribute('href') || card.querySelector('a[href*="maps/place"]')?.getAttribute('href') || '';

        data.push({ name, phone, address, rating, link });
      }
      return data;
    });

    for (const item of items) {
      if (results.length >= maxResults) break;
      const phoneClean = item.phone.replace(/[^0-9]/g, '').slice(-11);
      const key = phoneClean || item.name;
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      results.push({
        business_name: item.name,
        phone: phoneClean,
        address: item.address,
        rating: item.rating,
        city,
        niche: query,
        google_maps_url: item.link.startsWith('http') ? item.link : `https://www.google.com${item.link}`,
        status: 'new',
        source: 'scrape',
      });
    }

    if (items.length === prevCount && attempt > 5) break;
    prevCount = items.length;

    // Scroll to load more
    try {
      await page.evaluate(() => {
        window.scrollBy(0, 1500);
        // Click "More places" if visible
        const moreBtn = document.querySelector('[jsname*="more"], .L2k7D, a[aria-label*="More"]');
        if (moreBtn) moreBtn.click();
      });
    } catch {}
  }

  await page.close();
  return results;
}

module.exports = { scrapeGoogleMaps };