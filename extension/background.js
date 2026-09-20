import './scrape-utils.js';

const { parseApiMoney, parseMoney, isJunkTitle, cleanTitle } = globalThis.CrosslistScrape;

const FB_SELLING =
  'https://www.facebook.com/marketplace/you/selling?order=CREATION_TIMESTAMP_DESC';

const EBAY_ACTIVE = 'https://www.ebay.com/sh/lst/active?sort=-timeRemaining';

const DEPOP_SELLING = 'https://www.depop.com/sellinghub/';
const DEPOP_LOGIN = 'https://www.depop.com/login/?redirect=%2Fsellinghub%2F';
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

const CONTENT_SCRIPTS = {
  SCRAPE_FACEBOOK_LISTINGS: ['scrape-utils.js', 'content-facebook.js'],
  SCRAPE_EBAY_LISTINGS: ['scrape-utils.js', 'content-ebay.js'],
  SCRAPE_DEPOP_LISTINGS: ['scrape-utils.js', 'content-depop.js'],
  SCRAPE_POSHMARK_LISTINGS: ['scrape-utils.js', 'content-poshmark.js'],
  SCRAPE_ETSY_LISTINGS: ['scrape-utils.js', 'content-etsy.js'],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTrace(label) {
  const steps = [];
  const note = (message, extra) => {
    const step = { at: new Date().toISOString(), message: String(message || '') };
    if (extra && typeof extra === 'object' && Object.keys(extra).length) step.extra = extra;
    steps.push(step);
    const text = `[crosslist ${label}] ${step.message}`;
    if (/fail|error|could not|timed out|denied|exception/i.test(step.message)) {
      console.error(text, extra || '');
    } else {
      console.log(text, extra || '');
    }
  };
  return { steps, note };
}

function logError(context, error, extra) {
  console.error(`[crosslist ${context}]`, error?.stack || error?.message || error, extra || '');
}

function attachLog(result, steps) {
  if (!result || typeof result !== 'object') return result;
  const existing = Array.isArray(result.log) ? result.log : [];
  return { ...result, log: [...existing, ...(steps || [])] };
}

function urlsMatch(a = '', b = '') {
  const normalize = (url) => String(url).split('?')[0].replace(/\/$/, '');
  return Boolean(a) && Boolean(b) && normalize(a) === normalize(b);
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for page load'));
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    }).catch((error) => {
      logError('waitForTabComplete', error, { tabId });
    });
  });
}

async function waitForTabLoad(tabId, timeoutMs = 45000) {
  const started = Date.now();
  const tab = await chrome.tabs.get(tabId);
  if (tab.status !== 'complete' || !tab.url || tab.url === 'about:blank') {
    await waitForTabComplete(tabId, Math.max(1000, timeoutMs - (Date.now() - started)));
  }

  let lastUrl = (await chrome.tabs.get(tabId)).url;
  while (Date.now() - started < timeoutMs) {
    await sleep(700);
    const current = await chrome.tabs.get(tabId);
    if (current.status === 'complete' && current.url && current.url !== 'about:blank' && current.url === lastUrl) {
      return current;
    }
    lastUrl = current.url;
    if (current.status !== 'complete') {
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) break;
      await waitForTabComplete(tabId, remaining);
    }
  }
  return chrome.tabs.get(tabId);
}

async function ensureContentScript(tabId, command) {
  const files = CONTENT_SCRIPTS[command];
  if (!files) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch (error) {
    logError('ensureContentScript', error, { tabId, command });
  }
}

async function scrapeViaPageFunction(tabId, command) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (cmd) => {
      if (cmd !== 'SCRAPE_FACEBOOK_LISTINGS') return null;
      if (typeof preparePageForScrape === 'function') await preparePageForScrape();
      if (typeof scrapeFacebookListings !== 'function') return null;
      const listings = scrapeFacebookListings();
      return {
        listings,
        pageState: typeof getFacebookPageState === 'function' ? getFacebookPageState() : 'unknown',
        url: window.location.href,
        loggedIn: typeof isFacebookLoggedIn === 'function' ? isFacebookLoggedIn() : false,
        debug: typeof facebookScrapeDebug === 'function' ? facebookScrapeDebug() : { count: listings.length },
      };
    },
    args: [command],
  });
  return result || null;
}

async function scrapeFromTab(tabId, command, attempts = 4, trace) {
  await waitForTabLoad(tabId);
  let lastError;
  trace?.note(`Waiting for page before ${command}`);

  for (let i = 0; i < attempts; i += 1) {
    await sleep(1200 + i * 800);
    try {
      const response = await chrome.tabs.sendMessage(tabId, { command });
      if (response) {
        trace?.note(`Scrape attempt ${i + 1} returned ${response.listings?.length || 0} listing(s)`, {
          pageState: response.pageState,
          url: response.url,
          loggedIn: response.loggedIn,
          ...(response.debug || {}),
        });
        return response;
      }
    } catch (error) {
      lastError = error;
      trace?.note(`Scrape attempt ${i + 1} failed: ${error.message}`);
      if (i === 0) await ensureContentScript(tabId, command);
      try {
        const injected = await scrapeViaPageFunction(tabId, command);
        if (injected) {
          trace?.note(`Injected scrape returned ${injected.listings?.length || 0} listing(s)`, {
            pageState: injected.pageState,
            url: injected.url,
            loggedIn: injected.loggedIn,
            ...(injected.debug || {}),
          });
          return injected;
        }
      } catch (injectError) {
        lastError = injectError;
        trace?.note(`Injected scrape failed: ${injectError.message}`);
      }
    }
  }

  throw lastError || new Error('Could not communicate with page content script');
}

function isEbayAuthenticatedUrl(url = '') {
  return /ebay\.(com|co\.uk|ca|com\.au|de)\//i.test(url) &&
    (/\/(sh|sl|mys|myb|mye|lstng|sellerhub)\b/i.test(url) || /\/sh\//i.test(url));
}

function marketplaceConnection(scraped, { platform, sessionHint = false } = {}) {
  const listings = scraped.listings || [];
  const pageState = scraped.pageState || 'unknown';
  const url = scraped.url || '';
  const loggedIn = Boolean(scraped.loggedIn || (sessionHint && pageState !== 'login'));
  const onSellingPage =
    pageState === 'selling' ||
    ((pageState === 'profile' || pageState === 'session') && loggedIn) ||
    url.includes('/marketplace/you/selling') ||
    url.includes('/marketplace/profile/') ||
    isEbayAuthenticatedUrl(url) ||
    url.includes('depop.com/products/') ||
    url.includes('depop.com/sellinghub') ||
    url.includes('poshmark.com/closet') ||
    url.includes('poshmark.com/listing') ||
    url.includes('etsy.com/your/shops') ||
    url.includes('etsy.com/listing');

  const needsLogin =
    pageState === 'login' ||
    (!loggedIn && (pageState === 'home' || pageState === 'profile' || (!onSellingPage && listings.length === 0)));

  const debug = {
    pageState,
    url,
    count: listings.length,
    loggedIn,
    ...(scraped.debug || {}),
    ...(scraped.error ? { error: scraped.error } : {}),
  };

  if (needsLogin) {
    return {
      connected: false,
      needsLogin: true,
      listings,
      message:
        `Sign in on the ${platform} tab. After login you should land on your listings page, then click Connect ${platform} again.`,
      debug,
    };
  }

  if (scraped.error && listings.length === 0) {
    return {
      connected: false,
      listings,
      error: scraped.error,
      message: `Could not read ${platform} listings: ${scraped.error}`,
      debug,
    };
  }

  return {
    connected: true,
    mode: 'extension',
    account: scraped.account || `${platform}-browser-session`,
    listings,
    debug,
    log: scraped.log || [],
  };
}

async function connectMarketplace({
  platform,
  targetUrl,
  loginUrl,
  scrapeCommand,
  sessionHint = false,
  fallbackUrls = [],
}) {
  const trace = createTrace(platform);
  trace.note(`Opening ${targetUrl}`, { sessionHint: Boolean(sessionHint) });
  const tab = await chrome.tabs.create({ url: targetUrl, active: true });
  trace.note(`Opened tab ${tab.id}`);

  const scrape = async () => {
    try {
      return await scrapeFromTab(tab.id, scrapeCommand, 4, trace);
    } catch (error) {
      trace.note(`Could not scrape tab: ${error.message}`);
      return {
        listings: [],
        pageState: 'unknown',
        url: (await chrome.tabs.get(tab.id).catch((tabError) => {
          logError('scrape tab lookup', tabError, { tabId: tab.id, targetUrl });
          return { url: targetUrl };
        })).url || targetUrl,
        error: error.message,
      };
    }
  };

  let scraped = await scrape();
  const loginLike = scraped.pageState === 'login' || /\/login|checkpoint/i.test(scraped.url || '');
  if (!(scraped.listings || []).length && !loginLike) {
    const urls = [targetUrl, ...fallbackUrls];
    const seen = new Set();
    for (const url of urls) {
      if ((scraped.listings || []).length) break;
      if (seen.has(url) || urlsMatch(url, scraped.url)) continue;
      seen.add(url);
      trace.note(`Retrying listings page ${url}`);
      await chrome.tabs.update(tab.id, { url, active: true });
      scraped = await scrape();
    }
  }

  const connection = attachLog(
    marketplaceConnection(scraped, { platform, sessionHint }),
    trace.steps
  );

  if (connection.needsLogin) {
    trace.note(`Needs login, opening ${loginUrl}`);
    connection.log = [...trace.steps];
    await chrome.tabs.update(tab.id, { url: loginUrl, active: true });
  } else {
    trace.note(
      connection.error
        ? `Finished with error: ${connection.error}`
        : `Finished with ${connection.listings?.length || 0} listing(s)`
    );
    connection.log = [...trace.steps];
  }

  return connection;
}

async function getFacebookUserId() {
  try {
    const named = await chrome.cookies.get({
      url: 'https://www.facebook.com/',
      name: 'c_user',
    });
    if (named?.value) return named.value;
    const cookies = await chrome.cookies.getAll({ domain: 'facebook.com' });
    return cookies.find((cookie) => cookie.name === 'c_user')?.value || null;
  } catch (error) {
    logError('getFacebookUserId', error);
    return null;
  }
}

async function connectFacebook() {
  const userId = await getFacebookUserId();
  const fallbackUrls = ['https://www.facebook.com/marketplace/you/selling'];
  if (userId) {
    fallbackUrls.push(
      `https://www.facebook.com/marketplace/profile/${userId}/`,
      `https://web.facebook.com/marketplace/profile/${userId}/`
    );
  }

  const result = await connectMarketplace({
    platform: 'Facebook',
    targetUrl: FB_SELLING,
    loginUrl: facebookLoginUrl(),
    scrapeCommand: 'SCRAPE_FACEBOOK_LISTINGS',
    sessionHint: Boolean(userId),
    fallbackUrls,
  });
  return {
    ...result,
    log: [
      {
        at: new Date().toISOString(),
        message: userId ? `Facebook cookie present (${userId})` : 'No Facebook c_user cookie',
      },
      ...(result.log || []),
    ],
  };
}

async function hasEbaySessionCookie() {
  const cookies = [
    ...(await chrome.cookies.getAll({ domain: 'ebay.com' })),
    ...(await chrome.cookies.getAll({ domain: 'ebay.co.uk' })),
  ];
  const names = new Set(cookies.map((cookie) => cookie.name));
  return names.has('s');
}

async function connectEbay() {
  const sessionHint = await hasEbaySessionCookie();
  return connectMarketplace({
    platform: 'eBay',
    targetUrl: EBAY_ACTIVE,
    loginUrl: ebayLoginUrl(),
    scrapeCommand: 'SCRAPE_EBAY_LISTINGS',
    sessionHint,
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

async function depopApi(token, path, { method = 'GET', body } = {}) {
  const url = path.startsWith('http') ? path : `${DEPOP_API}${path}`;
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method,
    credentials: 'include',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = new Error(`Depop API ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    logError('depopApi JSON', error, { path });
    return {};
  }
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
    url: slug ? `https://www.depop.com/products/${slug}` : DEPOP_SELLING,
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
      logError('fetchDepopProduct', error, { path, slugOrId });
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
    } catch (error) {
      logError('hydrateDepopListings', error, { listingId: listing.platformListingId });
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
      logError('fetchDepopUser', error, { path });
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
    } catch (error) {
      logError('fetchDepopProducts shop', error, { userId });
    }
  }

  if (!products.length && username) {
    try {
      const data = await depopApi(
        token,
        `/v2/search/products/?what=&itemsPerPage=40&username=${encodeURIComponent(username)}`
      );
      products.push(...tryCollect(data));
    } catch (error) {
      logError('fetchDepopProducts search', error, { username });
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
    log: [
      {
        at: new Date().toISOString(),
        message: `Depop API (${source}) found ${listings.length} listing(s) for ${user.username || user.id}`,
      },
    ],
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
  const trace = createTrace('Depop');
  trace.note(token ? 'Depop access token found in cookies' : 'No Depop access token cookie');

  const scraped = await connectMarketplace({
    platform: 'Depop',
    targetUrl: DEPOP_SELLING,
    loginUrl: DEPOP_LOGIN,
    scrapeCommand: 'SCRAPE_DEPOP_LISTINGS',
    sessionHint: Boolean(token),
  });

  if (scraped.needsLogin) {
    return attachLog({
      ...scraped,
      message:
        'Sign in on the Depop tab. After you land on your selling page, click Connect Depop again.',
    }, trace.steps);
  }

  const tokenAfterLogin = await getDepopAccessToken();
  const hydrateToken = tokenAfterLogin || token;
  if (hydrateToken) {
    try {
      const connected = await connectDepopWithToken(hydrateToken, 'api-after-login');
      if (connected?.listings?.length) {
        trace.note(`Depop API returned ${connected.listings.length} listing(s)`);
        return attachLog(connected, [...trace.steps, ...(scraped.log || [])]);
      }
      trace.note('Depop API returned no listings; hydrating scraped page results');
      scraped.listings = await hydrateDepopListings(hydrateToken, scraped.listings || []);
    } catch (error) {
      trace.note(`Depop API hydrate failed: ${error.message}`);
      try {
        scraped.listings = await hydrateDepopListings(hydrateToken, scraped.listings || []);
      } catch (hydrateError) {
        logError('Depop hydrate fallback', hydrateError);
      }
    }
  }

  return attachLog(scraped, trace.steps);
}

const PRICE_EDIT = {
  facebook: {
    files: ['content-facebook-edit.js', 'content-price-edit.js'],
    urls: (id) => [
      `https://www.facebook.com/marketplace/edit/?listing_id=${encodeURIComponent(id)}`,
      `https://www.facebook.com/marketplace/item/${encodeURIComponent(id)}/edit`,
    ],
  },
  ebay: {
    files: ['content-price-edit.js'],
    urls: (id) => [
      `https://www.ebay.com/lstng?mode=ReviseItem&itemId=${encodeURIComponent(id)}`,
      `https://www.ebay.com/sl/list?mode=ReviseItem&itemId=${encodeURIComponent(id)}`,
    ],
  },
  depop: {
    files: ['content-price-edit.js'],
    urls: (id) => [
      `https://www.depop.com/products/${encodeURIComponent(id)}/edit`,
      `https://www.depop.com/products/selling/edit/${encodeURIComponent(id)}`,
    ],
  },
  poshmark: {
    files: ['content-price-edit.js'],
    urls: (id) => [
      `https://poshmark.com/edit-listing/${encodeURIComponent(id)}`,
      `https://poshmark.com/listing/${encodeURIComponent(id)}`,
    ],
  },
  etsy: {
    files: ['content-price-edit.js'],
    urls: (id) => [
      `https://www.etsy.com/your/shops/me/listing-editor/edit/${encodeURIComponent(id)}`,
      `https://www.etsy.com/listing/${encodeURIComponent(id)}/edit`,
    ],
  },
};

async function applyDepopPriceViaApi(listing) {
  const token = await getDepopAccessToken();
  if (!token) return null;
  const product = await fetchDepopProduct(token, listing.platformListingId);
  if (!product?.id && !product?.slug) return null;

  const id = product.id || listing.platformListingId;
  const price = Number(listing.price);
  if (!price || Number.isNaN(price)) return { success: false, error: 'Invalid price payload' };

  const bodies = [
    { priceAmount: price.toFixed(2) },
    { price: { priceAmount: price.toFixed(2) } },
    { pricing: { priceAmount: price.toFixed(2) } },
  ];
  const paths = [`/v1/products/${id}/`, `/v2/product/${id}/`, `/v2/products/${id}/`];

  for (const path of paths) {
    for (const body of bodies) {
      try {
        await depopApi(token, path, { method: 'PATCH', body });
        return { success: true, via: 'api', path };
      } catch (error) {
        logError('applyDepopPriceViaApi', error, { path, listingId: listing.platformListingId });
      }
    }
  }
  return null;
}

async function sendPriceUpdate(tabId, platform, price, files) {
  await waitForTabLoad(tabId);
  await sleep(1800);
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
  } catch (error) {
    logError('sendPriceUpdate inject', error, { tabId, platform });
  }
  await sleep(700);

  let lastError;
  for (let i = 0; i < 4; i += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        command: 'UPDATE_LISTING_PRICE',
        payload: { platform, price },
      });
      if (response) return response;
    } catch (error) {
      lastError = error;
      logError('sendPriceUpdate message', error, { tabId, platform, attempt: i + 1 });
      await sleep(1000 + i * 400);
      try {
        await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
      } catch (injectError) {
        logError('sendPriceUpdate retry inject', injectError, { tabId, platform });
      }
    }
  }

  if (platform === 'facebook') {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        command: 'UPDATE_FACEBOOK_PRICE',
        payload: { price },
      });
      if (response) return response;
    } catch (error) {
      lastError = error;
      logError('sendPriceUpdate facebook fallback', error, { tabId });
    }
  }

  return { success: false, error: lastError?.message || 'Could not update listing price' };
}

async function applyMarketplacePrices(platform, listings = []) {
  const config = PRICE_EDIT[platform];
  const trace = createTrace(`${platform} price`);
  const results = [];

  if (!config) {
    return { success: false, successCount: 0, failCount: listings.length, results, error: `Unknown platform: ${platform}` };
  }

  trace.note(`Updating ${listings.length} ${platform} price(s)`);

  for (const listing of listings) {
    const listingId = listing.platformListingId;
    if (!listingId) {
      results.push({ id: listing.id, success: false, error: 'Missing listing id' });
      trace.note(`Skipped ${listing.id}: missing listing id`);
      continue;
    }

    if (platform === 'depop') {
      try {
        const apiResult = await applyDepopPriceViaApi(listing);
        if (apiResult?.success) {
          results.push({
            id: listing.id,
            listingId,
            success: true,
            price: listing.price,
            via: 'api',
          });
          trace.note(`Updated ${listingId} to $${listing.price} via Depop API`);
          continue;
        }
      } catch (error) {
        trace.note(`Depop API price update failed for ${listingId}: ${error.message}`);
      }
    }

    const urls = config.urls(listingId);
    let response;
    let tab;
    try {
      tab = await chrome.tabs.create({ url: urls[0], active: true });
      trace.note(`Opened edit page for ${listingId}`);
      response = await sendPriceUpdate(tab.id, platform, listing.price, config.files);
      if (!response?.success && urls[1]) {
        await chrome.tabs.update(tab.id, { url: urls[1], active: true });
        trace.note(`Retrying ${listingId} with fallback edit URL`);
        response = await sendPriceUpdate(tab.id, platform, listing.price, config.files);
      }
    } catch (error) {
      logError('applyMarketplacePrices', error, { platform, listingId });
      response = { success: false, error: error.message };
    }

    if (tab?.id) {
      await chrome.tabs.remove(tab.id).catch((closeError) => {
        logError('close price-edit tab', closeError, { tabId: tab.id });
      });
    }
    results.push({
      id: listing.id,
      listingId,
      success: Boolean(response?.success),
      error: response?.error,
      price: listing.price,
      url: response?.url,
    });
    trace.note(
      response?.success
        ? `Updated ${listingId} to $${listing.price}`
        : `Failed ${listingId}: ${response?.error || 'unknown error'}`
    );
  }

  const successCount = results.filter((r) => r.success).length;
  return attachLog(
    {
      success: successCount > 0,
      successCount,
      failCount: results.length - successCount,
      results,
    },
    trace.steps
  );
}

async function applyFacebookPrices(listings = []) {
  return applyMarketplacePrices('facebook', listings);
}

const CREATE_URLS = {
  ebay: 'https://www.ebay.com/sl/list',
  facebook: 'https://www.facebook.com/marketplace/create/item',
  depop: 'https://www.depop.com/products/create/',
  poshmark: 'https://poshmark.com/create-listing',
  etsy: 'https://www.etsy.com/your/shops/me/tools/listings/create',
};

function absoluteImageUrl(url, dashboardOrigin) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('data:') || /^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/') && dashboardOrigin) return `${String(dashboardOrigin).replace(/\/$/, '')}${value}`;
  return value;
}

async function fetchImageAsDataUrl(url, dashboardOrigin) {
  const abs = absoluteImageUrl(url, dashboardOrigin);
  if (!abs) return '';
  if (abs.startsWith('data:image/')) return abs;
  try {
    const response = await fetch(abs);
    if (!response.ok) return abs;
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const mime = blob.type || 'image/jpeg';
    return `data:${mime};base64,${btoa(binary)}`;
  } catch (error) {
    logError('fetch listing image', error, { url: abs });
    return abs;
  }
}

async function createMarketplaceListings(payload = {}) {
  const platforms = Array.isArray(payload.platforms) ? payload.platforms : [];
  const listing = payload.listing || payload.item || {};
  const dashboardOrigin = payload.dashboardOrigin || '';
  const trace = createTrace('create listing');
  const results = [];

  const images = [];
  for (const image of listing.images || []) {
    images.push(await fetchImageAsDataUrl(image, dashboardOrigin));
  }
  const prepared = { ...listing, images: images.filter(Boolean) };
  trace.note(`Listing "${prepared.title || prepared.id}" on ${platforms.join(', ') || 'no stores'}`);

  for (const platform of platforms) {
    const createUrl = CREATE_URLS[platform];
    if (!createUrl) {
      results.push({ platform, success: false, error: `Unknown store: ${platform}` });
      continue;
    }

    trace.note(`Opening ${platform} create page`);
    let tab;
    let response;
    try {
      tab = await chrome.tabs.create({ url: createUrl, active: true });
      await waitForTabLoad(tab.id);
      await sleep(2200);
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-create.js'] });
      } catch (error) {
        logError('inject create script', error, { platform });
      }
      await sleep(500);

      let lastError;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          response = await chrome.tabs.sendMessage(tab.id, {
            command: 'CREATE_MARKETPLACE_LISTING',
            payload: { platform, listing: prepared },
          });
          if (response) break;
        } catch (error) {
          lastError = error;
          await sleep(900 + attempt * 400);
          try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-create.js'] });
          } catch (injectError) {
            logError('retry inject create script', injectError, { platform });
          }
        }
      }
      if (!response) {
        response = {
          success: false,
          needsReview: true,
          url: createUrl,
          error: lastError?.message || 'Could not fill the listing form',
        };
      }
    } catch (error) {
      logError('createMarketplaceListings', error, { platform });
      response = { success: false, error: error.message, needsReview: true, url: createUrl };
    }

    const listed = Boolean(response?.published && response?.listingId);
    results.push({
      platform,
      status: listed ? 'active' : response?.success === false && !response?.needsReview ? 'error' : 'listing',
      listingId: response?.listingId || null,
      url: response?.url || createUrl,
      needsReview: Boolean(response?.needsReview || !listed),
      error: response?.error || null,
      filled: Boolean(response?.filled),
    });
    trace.note(
      listed
        ? `${platform} listed as ${response.listingId}`
        : `${platform} form ${response?.filled ? 'filled' : 'opened'} — review and publish`
    );

    if (listed && tab?.id) {
      await sleep(1200);
      await chrome.tabs.remove(tab.id).catch((closeError) => logError('close create tab', closeError, { platform }));
    }
  }

  return attachLog({ success: results.some((row) => row.status === 'active' || row.filled || row.needsReview), results }, trace.steps);
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

async function handleExtensionCommand(command, payload = {}) {
  switch (command) {
    case 'PING':
      return { ok: true, version: '0.5.0' };
    case 'SESSION_STATUS':
      return sessionStatus();
    case 'CONNECT_FACEBOOK':
    case 'IMPORT_FACEBOOK':
      return connectFacebook();
    case 'CONNECT_EBAY':
    case 'IMPORT_EBAY':
      return connectEbay();
    case 'CONNECT_DEPOP':
    case 'IMPORT_DEPOP':
      return connectDepop();
    case 'CONNECT_POSHMARK':
    case 'IMPORT_POSHMARK':
      return connectPoshmark();
    case 'CONNECT_ETSY':
    case 'IMPORT_ETSY':
      return connectEtsy();
    case 'APPLY_FACEBOOK_PRICES':
      return applyMarketplacePrices('facebook', payload.listings || []);
    case 'APPLY_EBAY_PRICES':
      return applyMarketplacePrices('ebay', payload.listings || []);
    case 'APPLY_DEPOP_PRICES':
      return applyMarketplacePrices('depop', payload.listings || []);
    case 'APPLY_POSHMARK_PRICES':
      return applyMarketplacePrices('poshmark', payload.listings || []);
    case 'APPLY_ETSY_PRICES':
      return applyMarketplacePrices('etsy', payload.listings || []);
    case 'CREATE_MARKETPLACE_LISTINGS':
      return createMarketplaceListings(payload);
    default:
      return { error: `Unknown command: ${command}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      sendResponse(await handleExtensionCommand(message.command, message.payload || {}));
    } catch (error) {
      logError('extension command', error, { command: message.command });
      sendResponse({ error: error.message, log: [{ at: new Date().toISOString(), message: error.message }] });
    }
  })();
  return true;
});

chrome.runtime.onConnectExternal.addListener((port) => {
  port.onMessage.addListener(async (message) => {
    try {
      const result = await handleExtensionCommand(message.command, message.payload || {});
      port.postMessage({ ...message, result });
    } catch (error) {
      logError('extension port command', error, { command: message.command });
      port.postMessage({ ...message, error: error.message });
    }
  });
});
