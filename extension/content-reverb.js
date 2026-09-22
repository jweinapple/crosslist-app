function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reverbPageText() {
  return String(document.body?.innerText || '');
}

function isReverbSignInPage() {
  return /\/(signin|login|signup)(\/|$)/i.test(window.location.pathname);
}

function isReverbUnavailablePage() {
  const text = reverbPageText();
  return (
    /this page isn't available/i.test(text) ||
    /you may need to log in to access this page/i.test(text)
  );
}

function reverbHeaderRoot() {
  return document.querySelector('header, [role="banner"]') || document.querySelector('nav');
}

function isReverbOwnShopPage() {
  if (!/^\/shop\//i.test(window.location.pathname)) return false;
  const text = reverbPageText().slice(0, 8000);
  return /edit shop|promote shop|your shop is empty|list an item/i.test(text);
}

function isReverbListingsPage() {
  const path = window.location.pathname;
  return (
    path.includes('/my/selling/listings') ||
    path.includes('/my/listings') ||
    path.includes('/selling/listings') ||
    isReverbOwnShopPage()
  );
}

function isReverbLoggedIn() {
  if (isReverbUnavailablePage() || isReverbSignInPage()) return false;

  const header = reverbHeaderRoot();
  const controls = [...(header?.querySelectorAll('a, button, [role="button"]') || [])].slice(0, 40);
  const labels = controls.map((el) => String(el.textContent || '').replace(/\s+/g, ' ').trim());
  if (labels.some((label) => /^(log in|sign in)$/i.test(label))) return false;

  if (isReverbOwnShopPage()) return true;
  if (/edit shop|promote shop/i.test(reverbPageText().slice(0, 5000))) return true;
  if (labels.some((label) => /^(menu|notifications)$/i.test(label))) return true;
  if (document.querySelector('[aria-label="Menu" i], [aria-label="Notifications" i], a[href*="/logout"]')) {
    return true;
  }
  if (/^\/my\//i.test(window.location.pathname)) return true;
  return false;
}

function getReverbPageState() {
  const path = window.location.pathname;
  if (isReverbSignInPage()) return 'login';
  if (isReverbUnavailablePage()) return 'login';
  if (isReverbListingsPage()) return 'selling';
  if (/^\/shop\//i.test(path)) return 'shop';
  if (path === '/') return 'home';
  return 'unknown';
}

function isReverbPageReady() {
  if (isReverbSignInPage() || isReverbUnavailablePage()) return true;
  const text = reverbPageText();
  if (/listings\s*\(\s*\d+\s*\)/i.test(text)) return true;
  if (/your shop is empty|0 listings/i.test(text)) return true;
  if (document.querySelector('a[href*="/item/"], [data-listing-id], a[href*="/p/"]')) return true;
  if (isReverbOwnShopPage()) return true;
  return false;
}

function getReverbAccount() {
  const heading = document.querySelector('h1');
  const name = String(heading?.textContent || '').replace(/\s+/g, ' ').trim();
  if (name) return name;
  const shop = window.location.pathname.match(/\/shop\/([^/?#]+)/i);
  if (shop?.[1]) {
    try {
      return decodeURIComponent(shop[1]).replace(/-\d+$/, '').replace(/-/g, ' ');
    } catch (_error) {
      return shop[1];
    }
  }
  return '';
}

async function waitForReverbReady(timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (isReverbPageReady()) return;
    await sleep(400);
  }
}

function reverbListingIdFromValue(value) {
  const text = String(value || '');
  return (
    text.match(/\/item\/(\d+)/i)?.[1] ||
    text.match(/\/p\/(\d+)/i)?.[1] ||
    text.match(/\/selling\/(\d+)/i)?.[1] ||
    (/^\d{5,}$/.test(text) ? text : '')
  );
}

function scrapeReverbListings() {
  if (!isReverbLoggedIn() || isReverbUnavailablePage() || !isReverbListingsPage()) return [];

  const {
    findListingCard,
    priceFromNode,
    extractImages,
    titleFromCard,
    quantityFromNode,
    listingsFromEmbeddedJson,
    parseApiMoney,
    parseMoney,
    buildListing,
  } = globalThis.CrosslistScrape;
  const listings = [];
  const seen = new Set();

  listingsFromEmbeddedJson((obj) => {
    const listingId = reverbListingIdFromValue(
      obj.id || obj.listing_id || obj.listingId || obj._links?.web?.href || obj.url
    );
    if (!listingId || !obj.title) return null;
    const price =
      parseApiMoney(obj.price) ||
      parseMoney(obj.price?.amount || obj.price?.display || obj.price) ||
      0;
    const photo =
      obj.photos?.[0]?._links?.large_crop?.href ||
      obj.photos?.[0]?._links?.full?.href ||
      obj.photos?.[0]?.url ||
      obj.photo?.url ||
      obj.image;
    return buildListing({
      id: `reverb_${listingId}`,
      title: obj.title,
      description: obj.description || '',
      price,
      quantity: obj.inventory || obj.quantity || 1,
      images: [photo].filter(Boolean),
      platform: 'reverb',
      platformListingId: String(listingId),
      status: obj.state?.slug === 'live' || obj.state === 'live' ? 'active' : obj.state?.slug || 'active',
      url: obj._links?.web?.href || obj.url || `https://reverb.com/item/${listingId}`,
    });
  }).forEach((listing) => {
    if (seen.has(listing.platformListingId)) return;
    seen.add(listing.platformListingId);
    listings.push(listing);
  });

  document.querySelectorAll('a[href*="/item/"], a[href*="/p/"]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    const listingId = reverbListingIdFromValue(href);
    if (!listingId || seen.has(listingId)) return;
    seen.add(listingId);

    const card = findListingCard(anchor, { hrefIncludes: '/item/' })
      || findListingCard(anchor, { hrefIncludes: '/p/' });
    listings.push(
      buildListing({
        id: `reverb_${listingId}`,
        title: titleFromCard(card, anchor, `Reverb listing ${listingId}`),
        description: '',
        price: priceFromNode(card),
        quantity: quantityFromNode(card),
        images: extractImages(card),
        platform: 'reverb',
        platformListingId: listingId,
        status: 'active',
        url: href.startsWith('http') ? href.split('?')[0] : `https://reverb.com/item/${listingId}`,
      })
    );
  });

  return listings;
}

async function preparePageForScrape() {
  await waitForReverbReady();
  if (!isReverbPageReady()) return;
  window.scrollTo(0, document.body.scrollHeight);
  await sleep(600);
  window.scrollTo(0, 0);
  await sleep(400);
}

function reverbScrapePayload() {
  return {
    listings: scrapeReverbListings(),
    pageState: getReverbPageState(),
    loggedIn: isReverbLoggedIn(),
    ready: isReverbPageReady(),
    account: getReverbAccount() || undefined,
    url: window.location.href,
    debug: {
      path: window.location.pathname,
      ownShop: isReverbOwnShopPage(),
      listingsPage: isReverbListingsPage(),
    },
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.command !== 'SCRAPE_REVERB_LISTINGS') return;

  (async () => {
    await preparePageForScrape();
    sendResponse(reverbScrapePayload());
  })();

  return true;
});
