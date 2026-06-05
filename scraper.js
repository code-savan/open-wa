const puppeteer = require('puppeteer');

let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });
  return browser;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scrapeGoogleMaps({ query, city, maxResults = 20, startIndex = 0 }) {
  const b = await getBrowser();
  const page = await b.newPage();
  page.setDefaultTimeout(30000);

  const searchQuery = `${query} ${city}`.replace(/\s+/g, '+');
  const url = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}/`;

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(3000);

  const results = [];
  let previousCount = 0;
  let scrollAttempts = 0;

  while (results.length < maxResults && scrollAttempts < 15) {
    await sleep(2000);

    const items = await page.evaluate(() => {
      const cards = document.querySelectorAll('[role="feed"] > div > div, .m6QErb .NrDZNb');
      const data = [];
      for (const card of cards) {
        const nameEl = card.querySelector('.fontHeadlineSmall, .qBF1Pd, .fontBodyMedium');
        const name = nameEl?.textContent?.trim();
        if (!name) continue;

        const ratingEl = card.querySelector('.fontBodyMedium .MW4etd, span[aria-label*="stars"]');
        const rating = ratingEl?.textContent?.trim() || '';

        const addressEl = card.querySelector('.fontBodyMedium .W4Efsd, .Ahnjwc, .fontBodyMedium > span:nth-child(2)');
        const address = addressEl?.textContent?.trim() || '';

        const phoneEl = card.querySelector('a[data-tooltip*="Phone"], a[href^="tel:"]');
        const phone = phoneEl?.getAttribute('href')?.replace('tel:', '')?.trim() || '';

        const linkEl = card.querySelector('a[href*="maps/place"]');
        const mapsUrl = linkEl?.getAttribute('href') || '';

        data.push({ name, rating, address, phone, maps_url: mapsUrl });
      }
      return data;
    });

    for (const item of items) {
      const phone = item.phone || '';
      if (!phone) continue;
      const exists = results.some(r => r.phone === phone);
      if (!exists && results.length < maxResults) {
        results.push({
          business_name: item.name,
          phone: phone.replace(/[^0-9]/g, '').slice(-11),
          address: item.address,
          rating: item.rating,
          city,
          niche: query,
          google_maps_url: item.maps_url.startsWith('http') ? item.maps_url : `https://www.google.com${item.maps_url}`,
          status: 'new',
          source: 'scrape',
        });
      }
    }

    if (items.length === previousCount && scrollAttempts > 3) break;
    previousCount = items.length;

    await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      if (feed) feed.scrollBy(0, 1000);
    });
    scrollAttempts++;
  }

  await page.close();
  return results;
}

module.exports = { scrapeGoogleMaps };
