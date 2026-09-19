import './scrape-utils.js';

const { parseApiMoney, parseMoney, isJunkTitle, cleanTitle } = globalThis.CrosslistScrape;

const FB_SELLING =
  'https://www.facebook.com/marketplace/you/selling?order=CREATION_TIMESTAMP_DESC&state=LIVE&status=IN_STOCK';

const EBAY_ACTIVE = 'https://www.ebay.com/sh/lst/active?sort=-timeRemaining';

const DEPOP_HOME = 'https://www.depop.com/';
const DEPOP_SELLING = 'https://www.depop.com/selling/';
const DEPOP_LOGIN = 'https://www.depop.com/login/?redirect=%2Fselling%2F';
const DEPOP_API = 'https://webapi.depop.com/api';

const POSHMARK_CLOSET = 'https://poshmark.com/closet';
const POSHMARK_LOGIN = 'https://poshmark.com/login';

const ETSY_LISTINGS = 'https://www.etsy.com/your/shops/me/tools/listings';
const ETSY_LOGIN = 'https://www.etsy.com/signin';

function facebookLoginUrl() {
  const next = encodeURIComponent(FB_SELLING);
  return `https://www.facebook.com/login.php?next=${next}`;
}

function ebayLoginUrl() {
  const ru = encodeURIComponent(EBAY_ACTIVE);
  return `https://signin.ebay.com/ws/eBayISAPI.dll?SignIn&ru=${ru}`;
}

function waitForTabLoad(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for page load'));
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function scrapeFromTab(tabId, command, attempts = 4) {
  await waitForTabLoad(tabId);
  let lastError;

  for (let i = 0; i < attempts; i += 1) {
    await new Promise((r) => setTimeout(r, 2000 + i * 1500));
    try {
      const response = await chrome.tabs.sendMessage(tabId, { command });
      if (response) return response;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Could not communicate with page content script');
}

async function connectMarketplace({
  platform,
  targetUrl,
  loginUrl,
  scrapeCommand,
}) {
  const tab = await chrome.tabs.create({ url: targetUrl, active: true });

  let scraped;
  try {
    scraped = await scrapeFromTab(tab.id, scrapeCommand);
  } catch (error) {
    scraped = {
      listings: [],
      pageState: 'unknown',
      url: targetUrl,
      error: error.message,
    };
  }

  const listings = scraped.listings || [];
  const pageState = scraped.pageState || 'unknown';
  const onSellingPage =
    pageState === 'selling' ||
    (scraped.url || '').includes('/marketplace/you/selling') ||
    (scraped.url || '').includes('/sh/lst/') ||
    (scraped.url || '').includes('depop.com/products/') ||
    (scraped.url || '').includes('depop.com/selling') ||
    (scraped.url || '').includes('poshmark.com/closet') ||
    (scraped.url || '').includes('poshmark.com/listing') ||
    (scraped.url || '').includes('etsy.com/your/shops') ||
    (scraped.url || '').includes('etsy.com/listing');

  const needsLogin =
    pageState === 'login' ||
    pageState === 'home' ||
    (!onSellingPage && listings.length === 0);

  if (needsLogin) {
    await chrome.tabs.update(tab.id, { url: loginUrl, active: true });
    return {
      connected: false,
      needsLogin: true,
      message:
        `Sign in on the ${platform} tab. After login you should land on your listings page, then click Connect ${platform} again.`,
      debug: { pageState, url: scraped.url },
    };
  }

  return {
    connected: true,
    mode: 'extension',
    account: `${platform}-browser-session`,
    listings,
    debug: { pageState, url: scraped.url, count: listings.length },
  };
}

async function connectFacebook() {
  return connectMarketplace({
    platform: 'Facebook',
    targetUrl: FB_SELLING,
    loginUrl: facebookLoginUrl(),
    scrapeCommand: 'SCRAPE_FACEBOOK_LISTINGS',
  });
}

async function connectEbay() {
  return connectMarketplace({
    platform: 'eBay',
    targetUrl: EBAY_ACTIVE,
    loginUrl: ebayLoginUrl(),
    scrapeCommand: 'SCRAPE_EBAY_LISTINGS',
  });
}

async function getDepopAccessToken() {
  const named = await chrome.cookies.get({
    url: 'https://www.depop.com',
    name: 'access_token',
  });
  if (named?.value) return named.value;

  const cookies = await chrome.cookies.getAll({ domain: 'depop.com' });
  const match = cookies.find((cookie) => /access.?token/i.test(cookie.name));
  return match?.value || null;
}

async function depopApi(token, path) {
  const url = path.startsWith('http') ? path : `${DEPOP_API}${path}`;
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const error = new Error(`Depop API ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function flattenDepopImages(node, urls = []) {
  if (!node) return urls;
  if (typeof node === 'string') {
    if (node.startsWith('http')) urls.push(node);
    return urls;
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => flattenDepopImages(entry, urls));
    return urls;
  }
  if (typeof node === 'object') {
    if (node.url) urls.push(node.url);
    else Object.values(node).forEach((entry) => flattenDepopImages(entry, urls));
  }
  return urls;
}

function parseDepopPrice(product) {
  return (
    parseApiMoney(product?.price) ||
    parseApiMoney(product?.pricing) ||
    parseApiMoney(product?.pricing?.originalPrice) ||
    parseApiMoney(product?.price_amount) ||
    parseMoney(product?.price)
  );
}

function mapDepopProduct(product) {
  const slug = String(product.slug || product.id || '');
  const description = product.description || product.preview?.content || '';
  const rawTitle =
    description.split('\n')[0] ||
    product.title ||
    product.preview?.content ||
    slug.replace(/-/g, ' ');
  const title = isJunkTitle(rawTitle) ? slug.replace(/-/g, ' ') : cleanTitle(rawTitle).slice(0, 120);
  const status = String(product.status || 'ONSALE').toUpperCase();
  const images = [
    ...new Set(
      flattenDepopImages(product.pictures || product.preview?.pictures || product.images)
    ),
  ].slice(0, 8);

  return {
    id: `depop_${slug}`,
    title: title || `Depop item ${slug}`,
    description,
    price: parseDepopPrice(product),
    quantity: 1,
    images,
    platform: 'depop',
    platformListingId: slug,
    status: ['SOLD', 'MARKED_AS_SOLD', 'DELETED'].includes(status)
      ? 'inactive'
      : 'active',
    url: slug ? `https://www.depop.com/products/${slug}` : DEPOP_HOME,
    lastUpdated: new Date().toISOString(),
  };
}

async function fetchDepopProduct(token, slugOrId) {
  const encoded = encodeURIComponent(slugOrId);
  const paths = [
    `/v2/product/${encoded}/`,
    `/v2/products/${encoded}/`,
    `/v2/product/by-id/${encoded}/`,
  ];
  for (const path of paths) {
    try {
      const data = await depopApi(token, path);
      return data.product || data.data || data;
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
    }
  }
  return null;
}

async function mapPool(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return results;
}

function listingNeedsHydration(listing) {
  return !listing.price || !listing.images?.length || !listing.description || isJunkTitle(listing.title);
}

async function hydrateDepopListings(token, listings) {
  if (!token || !listings?.length) return listings;
  return mapPool(listings, 4, async (listing) => {
    if (!listingNeedsHydration(listing)) return listing;
    try {
      const product = await fetchDepopProduct(token, listing.platformListingId);
      if (!product?.slug && !product?.id) return listing;
      const mapped = mapDepopProduct(product);
      return {
        ...listing,
        ...mapped,
        title: isJunkTitle(mapped.title) ? listing.title : mapped.title,
        price: mapped.price || listing.price,
        images: mapped.images.length ? mapped.images : listing.images,
        description: mapped.description || listing.description,
      };
    } catch (_error) {
      return listing;
    }
  });
}

async function fetchDepopUser(token) {
  const endpoints = ['/v1/user/', '/v2/users/', '/v1/users/'];
  for (const path of endpoints) {
    try {
      const data = await depopApi(token, path);
      if (data?.username || data?.id || data?.user) {
        return data.user || data;
      }
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
    }
  }
  return null;
}

async function fetchDepopProducts(token, user) {
  const products = [];
  const username = user?.username;
  const userId = user?.id;

  const tryCollect = (payload) => {
    const batch = payload?.products || payload?.objects || payload?.results || [];
    if (Array.isArray(payload) && payload.length) return payload;
    return Array.isArray(batch) ? batch : [];
  };

  if (userId) {
    try {
      const data = await depopApi(
        token,
        `/v1/shop/${userId}/products/?limit=40&offset=0`
      );
      products.push(...tryCollect(data));
    } catch (_error) {
      // Fall through to search.
    }
  }

  if (!products.length && username) {
    try {
      const data = await depopApi(
        token,
        `/v2/search/products/?what=&itemsPerPage=40&username=${encodeURIComponent(username)}`
      );
      products.push(...tryCollect(data));
    } catch (_error) {
      // Fall through to page scrape.
    }
  }

  const mapped = products.map(mapDepopProduct).filter((listing) => listing.platformListingId);
  return hydrateDepopListings(token, mapped);
}

async function connectDepopWithToken(token, source = 'api') {
  const user = await fetchDepopUser(token);
  if (!user) return null;
  const listings = await fetchDepopProducts(token, user);
  return {
    connected: true,
    mode: 'extension',
    account: user.username || user.id || 'depop-browser-session',
    listings,
    debug: { source, username: user.username, count: listings.length },
  };
}

async function connectPoshmark() {
  return connectMarketplace({
    platform: 'Poshmark',
    targetUrl: POSHMARK_CLOSET,
    loginUrl: POSHMARK_LOGIN,
    scrapeCommand: 'SCRAPE_POSHMARK_LISTINGS',
  });
}

async function connectEtsy() {
  return connectMarketplace({
    platform: 'Etsy',
    targetUrl: ETSY_LISTINGS,
    loginUrl: ETSY_LOGIN,
    scrapeCommand: 'SCRAPE_ETSY_LISTINGS',
  });
}

async function connectDepop() {
  const token = await getDepopAccessToken();
  if (token) {
    try {
      const connected = await connectDepopWithToken(token, 'api');
      if (connected) return connected;
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) {
        console.warn('Depop API connect failed, trying browser session', error.message);
      }
    }
  }

  const scraped = await connectMarketplace({
    platform: 'Depop',
    targetUrl: DEPOP_SELLING,
    loginUrl: DEPOP_LOGIN,
    scrapeCommand: 'SCRAPE_DEPOP_LISTINGS',
  });

  if (scraped.needsLogin) {
    return {
      ...scraped,
      message:
        'Sign in on the Depop tab. After you land on your selling page, click Connect Depop again.',
    };
  }

  const tokenAfterLogin = await getDepopAccessToken();
  const hydrateToken = tokenAfterLogin || token;
  if (hydrateToken) {
    try {
      const connected = await connectDepopWithToken(hydrateToken, 'api-after-login');
      if (connected?.listings?.length) {
        return connected;
      }
      scraped.listings = await hydrateDepopListings(hydrateToken, scraped.listings || []);
    } catch (_error) {
      try {
        scraped.listings = await hydrateDepopListings(hydrateToken, scraped.listings || []);
      } catch (_hydrateError) {
        // Keep the scraped session if the API is unavailable.
      }
    }
  }

  return scraped;
}

function facebookEditUrl(listingId) {
  return `https://www.facebook.com/marketplace/edit/?listing_id=${listingId}`;
}

async function applyFacebookPrices(listings = []) {
  const results = [];

  for (const listing of listings) {
    const listingId = listing.platformListingId;
    if (!listingId) {
      results.push({ id: listing.id, success: false, error: 'Missing listing id' });
      continue;
    }

    const tab = await chrome.tabs.create({
      url: facebookEditUrl(listingId),
      active: true,
    });

    let response;
    try {
      await waitForTabLoad(tab.id);
      await new Promise((r) => setTimeout(r, 3000));
      response = await chrome.tabs.sendMessage(tab.id, {
        command: 'UPDATE_FACEBOOK_PRICE',
        payload: { price: listing.price },
      });
    } catch (error) {
      response = { success: false, error: error.message };
    }

    await chrome.tabs.remove(tab.id).catch(() => {});
    results.push({
      id: listing.id,
      listingId,
      success: Boolean(response?.success),
      error: response?.error,
      price: listing.price,
    });
  }

  const successCount = results.filter((r) => r.success).length;
  return {
    success: successCount > 0,
    successCount,
    failCount: results.length - successCount,
    results,
  };
}

async function sessionStatus() {
  return {
    extensionInstalled: true,
    facebook: { target: FB_SELLING },
    ebay: { target: EBAY_ACTIVE },
    depop: { target: DEPOP_SELLING, login: DEPOP_LOGIN },
    poshmark: { target: POSHMARK_CLOSET, login: POSHMARK_LOGIN },
    etsy: { target: ETSY_LISTINGS, login: ETSY_LOGIN },
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.command) {
        case 'PING':
          sendResponse({ ok: true, version: '0.4.1' });
          break;
        case 'SESSION_STATUS':
          sendResponse(await sessionStatus());
          break;
        case 'CONNECT_FACEBOOK':
          sendResponse(await connectFacebook());
          break;
        case 'CONNECT_EBAY':
          sendResponse(await connectEbay());
          break;
        case 'CONNECT_DEPOP':
          sendResponse(await connectDepop());
          break;
        case 'CONNECT_POSHMARK':
          sendResponse(await connectPoshmark());
          break;
        case 'CONNECT_ETSY':
          sendResponse(await connectEtsy());
          break;
        case 'IMPORT_EBAY':
          sendResponse(await connectEbay());
          break;
        case 'IMPORT_FACEBOOK':
          sendResponse(await connectFacebook());
          break;
        case 'IMPORT_DEPOP':
          sendResponse(await connectDepop());
          break;
        case 'IMPORT_POSHMARK':
          sendResponse(await connectPoshmark());
          break;
        case 'IMPORT_ETSY':
          sendResponse(await connectEtsy());
          break;
        case 'APPLY_FACEBOOK_PRICES':
          sendResponse(await applyFacebookPrices(message.payload?.listings || []));
          break;
        default:
          sendResponse({ error: `Unknown command: ${message.command}` });
      }
    } catch (error) {
      sendResponse({ error: error.message });
    }
  })();
  return true;
});

chrome.runtime.onConnectExternal.addListener((port) => {
  port.onMessage.addListener(async (message) => {
    try {
      let result;
      if (message.command === 'CONNECT_FACEBOOK' || message.command === 'IMPORT_FACEBOOK') result = await connectFacebook();
      else if (message.command === 'CONNECT_EBAY' || message.command === 'IMPORT_EBAY') result = await connectEbay();
      else if (message.command === 'CONNECT_DEPOP' || message.command === 'IMPORT_DEPOP') result = await connectDepop();
      else if (message.command === 'CONNECT_POSHMARK' || message.command === 'IMPORT_POSHMARK') result = await connectPoshmark();
      else if (message.command === 'CONNECT_ETSY' || message.command === 'IMPORT_ETSY') result = await connectEtsy();
      else if (message.command === 'SESSION_STATUS') result = await sessionStatus();
      else if (message.command === 'PING') result = { ok: true };
      else result = { error: 'Unknown command' };
      port.postMessage({ ...message, result });
    } catch (error) {
      port.postMessage({ ...message, error: error.message });
    }
  });
});
