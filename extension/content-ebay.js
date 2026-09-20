function isEbaySignInPage() {
  const host = window.location.hostname;
  const path = window.location.pathname;
  return /signin\.ebay\./i.test(host) || /\/signin/i.test(path);
}

function usernameFromHref(href) {
  const match = String(href || '').match(/\/usr\/([^/?#]+)/i);
  if (!match?.[1] || match[1] === 'default') return '';
  try {
    return decodeURIComponent(match[1]).trim();
  } catch (_error) {
    return match[1].trim();
  }
}

function getEbayAccount() {
  const headerLinks = document.querySelectorAll(
    '#gh-ug a[href*="/usr/"], #gh-eb-u a[href*="/usr/"], header a[href*="/usr/"], [data-testid*="account" i] a[href*="/usr/"]'
  );
  for (const link of headerLinks) {
    const username = usernameFromHref(link.getAttribute('href') || link.href);
    if (username) return username;
  }

  if (/^\/usr\//i.test(window.location.pathname)) {
    const username = usernameFromHref(window.location.pathname);
    if (username) return username;
  }

  const greeting = document.querySelector('#gh-ug, [data-testid*="account" i]');
  const hiMatch = String(greeting?.textContent || '').match(/Hi[, ]+(.+)/i);
  if (hiMatch?.[1]) {
    return hiMatch[1].replace(/[▼▾].*$/g, '').trim();
  }

  return '';
}

function isEbayLoggedIn() {
  if (isEbaySignInPage()) return false;

  const headerSignIn = [...document.querySelectorAll('#gh-ug a, header a[href*="signin"]')].find(
    (link) => /sign\s*in/i.test(link.textContent || '')
  );
  if (headerSignIn) return false;

  const headerUser = document.querySelectorAll(
    '#gh-ug a[href*="/usr/"], #gh-eb-u a[href*="/usr/"], header a[href*="/usr/"], [data-testid*="account" i] a[href*="/usr/"]'
  );
  if ([...headerUser].some((link) => usernameFromHref(link.getAttribute('href') || link.href))) {
    return true;
  }

  const greeting = document.querySelector('#gh-ug, [data-testid*="account" i]');
  if (/Hi[, ]+/i.test(String(greeting?.textContent || ''))) return true;

  if (document.querySelector('a[href*="SignOut"], a[href*="signout"], a[href*="/logout"]')) {
    return true;
  }

  return /(?:^|;\s*)s=/.test(document.cookie);
}

function getEbayPageState() {
  const path = window.location.pathname;

  if (isEbaySignInPage()) return 'login';
  if (
    path.includes('/sh/') ||
    path.includes('/sl/') ||
    path.includes('/lstng') ||
    path.includes('/sellerhub') ||
    path.includes('/mys/') ||
    path.includes('/myb/') ||
    path.includes('/mye/')
  ) {
    return 'selling';
  }
  if (path.includes('/usr/') || path.includes('/str/')) {
    return 'profile';
  }
  if (path === '/' || path === '/n/all-categories') {
    return 'home';
  }
  return isEbayLoggedIn() ? 'session' : 'unknown';
}

function ebayItemIdFromValue(value) {
  const raw = String(value || '');
  const hrefMatch = raw.match(/(?:\/itm\/|item(?:id)?=)(\d{9,13})/i);
  if (hrefMatch) return hrefMatch[1];
  const digits = raw.replace(/\D/g, '');
  return /^\d{9,13}$/.test(digits) ? digits : '';
}

function ebayImageMap() {
  const { listingsFromEmbeddedJson } = globalThis.CrosslistScrape;
  const map = new Map();
  listingsFromEmbeddedJson((obj) => {
    const itemId = ebayItemIdFromValue(obj.legacyItemId || obj.itemId || obj.listingId || obj.id);
    if (!itemId) return null;
    const collected = [];
    const push = (value) => {
      if (typeof value === 'string' && /ebayimg|thumbs\.ebay/i.test(value)) collected.push(value);
      else if (value && typeof value === 'object') {
        if (typeof value.url === 'string') collected.push(value.url);
        if (typeof value.imageUrl === 'string') collected.push(value.imageUrl);
      }
    };
    push(obj.image);
    push(obj.thumbnail);
    push(obj.pictureURL);
    push(obj.imageUrl);
    push(obj.imgUrl);
    (obj.thumbnailImages || obj.images || obj.pictures || []).forEach(push);
    if (collected.length && !map.has(itemId)) map.set(itemId, collected.filter(Boolean));
    return null;
  });
  return map;
}

function addEbayListing(listings, seen, fields) {
  const { buildListing } = globalThis.CrosslistScrape;
  const itemId = ebayItemIdFromValue(fields.platformListingId || fields.id);
  if (!itemId || seen.has(itemId)) return;
  seen.add(itemId);
  listings.push(
    buildListing({
      ...fields,
      id: `ebay_${itemId}`,
      platform: 'ebay',
      platformListingId: itemId,
      url: fields.url || `https://www.ebay.com/itm/${itemId}`,
    })
  );
}

function scrapeEbayListings() {
  const { findListingCard, priceFromNode, extractImages, titleFromCard, quantityFromNode, listingsFromEmbeddedJson } =
    globalThis.CrosslistScrape;
  const pageState = getEbayPageState();
  if (pageState === 'login' || pageState === 'home') return [];

  const listings = [];
  const seen = new Set();
  const imageMap = ebayImageMap();

  listingsFromEmbeddedJson((obj) => {
    const itemId = ebayItemIdFromValue(obj.legacyItemId || obj.itemId || obj.listingId || obj.id);
    const title = obj.title || obj.listingTitle || obj.name;
    if (!itemId || !title) return null;
    addEbayListing(listings, seen, {
      title,
      description: obj.description || '',
      price: globalThis.CrosslistScrape.parseApiMoney(obj.price) || globalThis.CrosslistScrape.parseMoney(obj.price),
      quantity: obj.quantity || 1,
      images: imageMap.get(itemId) || [],
      platformListingId: itemId,
      status: 'active',
    });
    return null;
  });

  document.querySelectorAll('a[href*="/itm/"], a[href*="itemid=" i], a[href*="itemId="], [data-item-id], [data-listing-id]').forEach(
    (node) => {
      const itemId = ebayItemIdFromValue(
        node.getAttribute('href') ||
          node.getAttribute('data-item-id') ||
          node.getAttribute('data-listing-id') ||
          node.getAttribute('data-itemid')
      );
      if (!itemId || seen.has(itemId)) return;

      const card = node.tagName === 'A' ? findListingCard(node, { hrefIncludes: '/itm/' }) : node.closest('tr, [role="row"], li, article') || node;
      const row = node.closest('tr, [role="row"], li, article') || card;
      let images = extractImages(row);
      if (!images.length) images = extractImages(card);
      if (!images.length) images = imageMap.get(itemId) || [];
      addEbayListing(listings, seen, {
        title: titleFromCard(card, node, `eBay item ${itemId}`),
        description: '',
        price: priceFromNode(card),
        quantity: quantityFromNode(card),
        images,
        platformListingId: itemId,
        status: 'active',
        url: `https://www.ebay.com/itm/${itemId}`,
      });
    }
  );

  return listings;
}

async function preparePageForScrape() {
  for (let i = 0; i < 4; i += 1) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 700));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 400));
}

function ebayScrapePayload() {
  return {
    listings: scrapeEbayListings(),
    pageState: getEbayPageState(),
    url: window.location.href,
    loggedIn: isEbayLoggedIn(),
    account: getEbayAccount() || undefined,
  };
}

if (!globalThis.__crosslistEbayListener) {
  globalThis.__crosslistEbayListener = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.command !== 'SCRAPE_EBAY_LISTINGS') return;

    (async () => {
      await preparePageForScrape();
      sendResponse(ebayScrapePayload());
    })();

    return true;
  });
}
