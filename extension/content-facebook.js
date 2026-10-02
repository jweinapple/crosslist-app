function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFacebookLoggedIn() {
  const path = window.location.pathname;
  if (path.includes('/login') || document.querySelector('input[name="email"], input[name="pass"]')) {
    return false;
  }
  return document.cookie.split(';').some((part) => part.trim().startsWith('c_user='));
}

function getFacebookPageState() {
  const url = window.location.href;
  const path = window.location.pathname;

  if (path.includes('/login') || document.querySelector('input[name="email"], input[name="pass"]')) {
    return 'login';
  }
  if (
    path.includes('/marketplace/you/selling') ||
    path.includes('/marketplace/you') ||
    path.includes('/marketplace/profile/')
  ) {
    return 'selling';
  }
  if (path === '/' || path === '/home.php' || url === 'https://www.facebook.com/') {
    return 'home';
  }
  return isFacebookLoggedIn() ? 'session' : 'unknown';
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch (_error) {
    return String(value || '')
      .replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, '/');
  }
}

function facebookListingIdFromHref(href) {
  const value = String(href || '');
  return (
    value.match(/\/marketplace\/item\/(\d+)/)?.[1] ||
    value.match(/[?&]listing_id=(\d+)/)?.[1] ||
    value.match(/\/marketplace\/edit\/[^?]*[?&]listing_id=(\d+)/)?.[1] ||
    null
  );
}

function facebookImageUrls(obj) {
  const urls = [];
  const push = (value) => {
    const url = String(value || '').replace(/\\\//g, '/');
    if (/^https?:/i.test(url) && /scontent|fbcdn|fbexternal/i.test(url)) urls.push(url);
  };
  const photo = obj?.primary_listing_photo || obj?.listing_photos?.[0] || obj?.photo;
  push(photo?.image?.uri);
  push(photo?.listing_image?.uri);
  push(photo?.uri);
  if (Array.isArray(obj?.listing_photos)) {
    for (const entry of obj.listing_photos) {
      push(entry?.image?.uri || entry?.uri);
    }
  }
  return [...new Set(urls)].slice(0, 4);
}

function listingFromFacebookJson(obj) {
  const { parseApiMoney, parseMoney, cleanTitle, buildListing } = globalThis.CrosslistScrape;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const title = obj.marketplace_listing_title || obj.custom_title || obj.listing_title;
  if (typeof title !== 'string' || !title.trim()) return null;
  if (obj.is_sold === true || obj.is_hidden === true) return null;
  if (obj.is_viewer_seller === false) return null;

  const id = String(
    obj.marketplace_listing_id ||
      obj.listingID ||
      obj.listing_id ||
      (obj.id != null ? obj.id : '')
  );
  if (!/^\d{8,}$/.test(id)) return null;

  return buildListing({
    id: `fb_${id}`,
    title: cleanTitle(title).slice(0, 140) || `Facebook item ${id}`,
    description: obj.redacted_description?.text || obj.description || '',
    price:
      parseApiMoney(obj.listing_price) ||
      parseMoney(obj.listing_price?.formatted_amount) ||
      parseMoney(obj.formatted_price?.text) ||
      parseApiMoney(obj.formatted_price) ||
      0,
    quantity: Number(obj.listing_inventory || obj.inventory_count || 1) || 1,
    images: facebookImageUrls(obj),
    platform: 'facebook',
    platformListingId: id,
    status: obj.is_pending ? 'pending' : 'active',
    url: `https://www.facebook.com/marketplace/item/${id}`,
  });
}

function listingsFromFacebookPageText(text) {
  const { parseMoney, cleanTitle, buildListing } = globalThis.CrosslistScrape;
  const listings = [];
  const seen = new Set();
  const titleRe = /"marketplace_listing_title"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match;

  while ((match = titleRe.exec(text))) {
    const title = cleanTitle(decodeJsonString(match[1]));
    if (!title) continue;

    const before = text.slice(Math.max(0, match.index - 2500), match.index);
    const after = text.slice(match.index, Math.min(text.length, match.index + 2500));
    const ids = [...before.matchAll(/"id"\s*:\s*"(\d{8,})"/g)];
    const id =
      before.match(/"marketplace_listing_id"\s*:\s*"(\d{8,})"/)?.[1] ||
      after.match(/"marketplace_listing_id"\s*:\s*"(\d{8,})"/)?.[1] ||
      ids[ids.length - 1]?.[1];
    if (!id || seen.has(id)) continue;

    const priceText =
      after.match(/"formatted_amount"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1] ||
      after.match(/"amount"\s*:\s*"([\d.]+)"/)?.[1] ||
      '';
    const imageRaw =
      after.match(/"uri"\s*:\s*"(https[^"]+)"/)?.[1] ||
      after.match(/"uri"\s*:\s*"(https:\\\/\\\/[^"]+)"/)?.[1] ||
      '';
    const image = decodeJsonString(imageRaw).replace(/\\\//g, '/');

    seen.add(id);
    listings.push(
      buildListing({
        id: `fb_${id}`,
        title: title.slice(0, 140),
        description: '',
        price: parseMoney(decodeJsonString(priceText)),
        quantity: 1,
        images: image && /^https?:/i.test(image) ? [image] : [],
        platform: 'facebook',
        platformListingId: id,
        status: 'active',
        url: `https://www.facebook.com/marketplace/item/${id}`,
      })
    );
  }

  return listings;
}

function mergeFacebookListings(groups) {
  const { isJunkTitle } = globalThis.CrosslistScrape;
  const weakTitle = (title) => isJunkTitle(title) || /^facebook item \d+$/i.test(String(title || ''));
  const byId = new Map();
  for (const listing of groups.flat()) {
    const id = listing?.platformListingId;
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, listing);
      continue;
    }
    byId.set(id, {
      ...existing,
      ...listing,
      title: weakTitle(listing.title) ? existing.title : listing.title,
      price: listing.price || existing.price,
      images: listing.images?.length ? listing.images : existing.images,
      description: listing.description || existing.description,
    });
  }
  return [...byId.values()];
}

function listingsFromFacebookDom() {
  const { findListingCard, priceFromNode, extractImages, titleFromCard, buildListing } =
    globalThis.CrosslistScrape;
  const listings = [];
  const seen = new Set();
  const nodes = document.querySelectorAll(
    'a[href*="/marketplace/item/"], a[href*="listing_id="], a[href*="/marketplace/edit"], [href*="/marketplace/item/"]'
  );

  nodes.forEach((anchor) => {
    const id = facebookListingIdFromHref(anchor.getAttribute('href') || anchor.href || '');
    if (!id || seen.has(id)) return;
    seen.add(id);

    const card = findListingCard(anchor, { hrefIncludes: '/marketplace/item/' });
    listings.push(
      buildListing({
        id: `fb_${id}`,
        title: titleFromCard(card, anchor, `Facebook item ${id}`),
        description: '',
        price: priceFromNode(card),
        quantity: 1,
        images: extractImages(card),
        platform: 'facebook',
        platformListingId: id,
        status: 'active',
        url: `https://www.facebook.com/marketplace/item/${id}`,
      })
    );
  });

  return listings;
}

function listingsFromFacebookJsonScripts() {
  const { listingsFromEmbeddedJson } = globalThis.CrosslistScrape;
  return listingsFromEmbeddedJson(listingFromFacebookJson, {
    maxDepth: 32,
    scriptFilter: (text) =>
      text.includes('marketplace_listing_title') || text.includes('/marketplace/item/'),
  });
}

function listingsFromFacebookIds(text) {
  const { buildListing } = globalThis.CrosslistScrape;
  const listings = [];
  const seen = new Set();
  const add = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    listings.push(
      buildListing({
        id: `fb_${id}`,
        title: `Facebook item ${id}`,
        description: '',
        price: 0,
        quantity: 1,
        images: [],
        platform: 'facebook',
        platformListingId: id,
        status: 'active',
        url: `https://www.facebook.com/marketplace/item/${id}`,
      })
    );
  };
  for (const match of String(text || '').matchAll(/\/marketplace\/item\/(\d{8,})/g)) add(match[1]);
  for (const match of String(text || '').matchAll(/listing_id=(\d{8,})/g)) add(match[1]);
  return listings;
}

function facebookSourceText() {
  const scripts = [...document.querySelectorAll('script')]
    .map((script) => script.textContent || '')
    .filter(
      (text) =>
        text.includes('marketplace_listing_title') ||
        text.includes('/marketplace/item/') ||
        text.includes('listing_id=')
    );
  if (scripts.length) return scripts.join('\n');
  return document.documentElement?.innerHTML || '';
}

function scrapeFacebookListings() {
  if (!globalThis.CrosslistScrape) return [];
  const text = facebookSourceText();
  const groups = {
    ids: listingsFromFacebookIds(text),
    dom: listingsFromFacebookDom(),
    json: listingsFromFacebookJsonScripts(),
    pageText: listingsFromFacebookPageText(text),
  };
  const listings = mergeFacebookListings(Object.values(groups));
  scrapeFacebookListings.lastDebug = {
    ...listingSignalCounts(),
    sources: Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, value.length])),
    count: listings.length,
  };
  return listings;
}

function facebookScrapeDebug() {
  return scrapeFacebookListings.lastDebug || { count: 0 };
}

function listingSignalCounts() {
  return {
    itemLinks: document.querySelectorAll('a[href*="/marketplace/item/"]').length,
    editLinks: document.querySelectorAll('[href*="listing_id="], [href*="/marketplace/edit"]').length,
  };
}

function clickSellingView() {
  const labels = ['your listings', 'for sale', 'see your listings', 'view listings'];
  const nodes = [...document.querySelectorAll('a, [role="tab"], [role="button"], [role="link"]')];
  for (const label of labels) {
    const match = nodes.find((node) => {
      const text = String(node.innerText || node.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (!text || text.length > 48) return false;
      return text === label || text.startsWith(`${label} `);
    });
    if (match) {
      match.click();
      return label;
    }
  }
  return null;
}

function deepestScroller() {
  const main = document.querySelector('[role="main"]') || document.body;
  let best = document.scrollingElement || document.body;
  let bestOverflow = best.scrollHeight - best.clientHeight;
  const candidates = [main, ...main.querySelectorAll('div')].slice(0, 120);
  for (const node of candidates) {
    const style = window.getComputedStyle(node);
    if (!/(auto|scroll)/.test(style.overflowY)) continue;
    const overflow = node.scrollHeight - node.clientHeight;
    if (overflow > bestOverflow + 80) {
      best = node;
      bestOverflow = overflow;
    }
  }
  return best;
}

function hasDomListingSignals() {
  return Boolean(
    document.querySelector(
      'a[href*="/marketplace/item/"], [href*="listing_id="], [href*="/marketplace/edit"]'
    )
  );
}

async function preparePageForScrape() {
  clickSellingView();
  await sleep(1000);
  const scroller = deepestScroller();
  for (let i = 0; i < 6; i += 1) {
    if (hasDomListingSignals()) break;
    scroller.scrollTop = scroller.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(700);
  }
  scroller.scrollTop = 0;
  window.scrollTo(0, 0);
  await sleep(400);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.command !== 'SCRAPE_FACEBOOK_LISTINGS') return;

  (async () => {
    await preparePageForScrape();
    const listings = scrapeFacebookListings();
    sendResponse({
      listings,
      pageState: getFacebookPageState(),
      url: window.location.href,
      loggedIn: isFacebookLoggedIn(),
      debug: facebookScrapeDebug(),
    });
  })();

  return true;
});
