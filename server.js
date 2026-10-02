import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { v4 as uuidv4 } from 'uuid';
import open from 'open';
import convertHeic from 'heic-convert';
import * as userStore from './server/db.js';
import { platformFailureLabel, sanitizeListingFailure, slimListingResult } from './server/listing-failures.js';
import { initInventory, TITLE_STOPWORDS, TITLE_SIZE_WORDS, stripTitleJunk, collapseRepeatedTitle, cleanedListingTitle, normalizeTitle, titleTokens, titleSimilarity, titlesAreSameProduct, titlesLookRelated, decoratePlatformEntry, getPlatforms, listingHasPlatform, toUnifiedListing, findExistingListing, IMAGE_QUERY_DROP, normalizeImageUrl, isRealListingImage, realListingImages, extractOgImage, fetchHtml, ebayItemIdFromListing, fetchListingThumbnail, listingNeedsImageHydration, mapPool, applyListingImages, hydrateListingImages, hydrateMissingListingImages, listingImageList, listingImageKeys, listingsShareImage, listingPlatformKeys, platformsOverlap, summarizeMatchListing, findImageMatchInInventory, findImageMatchGroups, mergeInventoryListings, pickPrimaryListing, mergeObviousDuplicateListings, cleanStoredListingTitles, upsertImportedListing, seedDemoInventory, seedDemoEbayListings, seedDemoFacebookListings, buildMarketplaceCandidates, buildDepopMarketplaceCandidates, buildPoshmarkMarketplaceCandidates, buildEtsyMarketplaceCandidates, buildReverbMarketplaceCandidates, annotateImportCandidates, applyMoneyDivisor, parseListingPrice } from './server/inventory.js';
import * as autoList from './server/auto-distribute.js';

const app = express();
const PORT = process.env.PORT || 3000;
const requestContext = new AsyncLocalStorage();

if (process.env.VERCEL) {
  app.set('trust proxy', 1);
}

// Middleware
// Only this app's own origins may make credentialed cross-origin requests.
// Add more (comma-separated) with CORS_ORIGINS.
function allowedOrigins() {
  return new Set([
    BASE_URL,
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    ...String(process.env.CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim().replace(/\/$/, ''))
      .filter(Boolean),
  ]);
}

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header = same-origin navigation or a non-browser client.
      callback(null, !origin || allowedOrigins().has(origin));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

function currentListings() {
  return requestContext.getStore()?.listings || new Map();
}

const listings = new Proxy(new Map(), {
  get(_target, prop) {
    const map = currentListings();
    const value = map[prop];
    return typeof value === 'function' ? value.bind(map) : Reflect.get(map, prop);
  },
});
initInventory({ logError, getCurrentUser, listings });

function persistStore() {
  const user = requestContext.getStore()?.user;
  if (user) userStore.saveUser(user);
}

function getCurrentUser() {
  return requestContext.getStore()?.user || null;
}

function getDemoUser() {
  const user = getCurrentUser();
  if (!user) {
    const error = new Error('Sign in required');
    error.status = 401;
    throw error;
  }
  return user;
}

function isPublicApi(req) {
  const route = `${req.method} ${req.path}`;
  return (
    route === 'GET /api/health' ||
    route === 'GET /api/auth/me' ||
    route === 'POST /api/auth/signup' ||
    route === 'POST /api/auth/login' ||
    route === 'POST /api/auth/logout' ||
    (req.method === 'GET' &&
      /^\/api\/auth\/(ebay|facebook|depop|etsy|reverb|google)(\/live|\/callback)?$/.test(req.path))
  );
}

function requirePageLogin(req, res) {
  if (req.user) return true;
  res.redirect('/dashboard.html?auth=required');
  return false;
}

function beginOAuth(req, res, platform, extra = {}) {
  if (!requirePageLogin(req, res)) return null;
  return userStore.issueOAuthState(req.user.id, platform, extra);
}

function userFromOAuthState(state) {
  const oauth = userStore.consumeOAuthState(state);
  if (!oauth) return null;
  return { oauth, user: userStore.loadUser(oauth.userId) };
}

app.use((req, res, next) => {
  const cookies = userStore.parseCookies(req);
  const sid = cookies[userStore.SESSION_COOKIE];
  let session = userStore.getSession(sid);
  let user = session ? userStore.loadUser(session.user_id) : null;
  if (!user) {
    user = userStore.restoreUserFromIdentityCookie(cookies);
    if (user) {
      const sessionId = userStore.createSession(user.id);
      session = { id: sessionId, user_id: user.id };
      userStore.setSessionCookie(res, sessionId, user);
    }
  }
  req.user = user;
  req.sessionId = session?.id || null;
  const listingsMap = user ? userStore.listingMapFor(user.id) : new Map();
  requestContext.run({ user, listings: listingsMap }, next);
});

app.use((req, res, next) => {
  if (!req.path.startsWith('/api') || isPublicApi(req)) return next();
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
});

const QUIET_API = new Set([
  'GET /api/health',
  'GET /api/auth/me',
  'GET /api/auth/status',
]);

const SECRET_KEYS = /password|secret|token|authorization|cookie|code|refresh/i;

function redactValue(key, value, depth = 0) {
  if (value == null) return value;
  if (SECRET_KEYS.test(String(key || ''))) return '[redacted]';
  if (Array.isArray(value)) {
    return depth > 2 ? `[${value.length} items]` : value.slice(0, 8).map((item, i) => redactValue(i, item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth > 2) return '{…}';
    const out = {};
    for (const [nextKey, nextValue] of Object.entries(value).slice(0, 20)) {
      out[nextKey] = redactValue(nextKey, nextValue, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 180) return `${value.slice(0, 177)}…`;
  return value;
}

function recordActivity(type, message, detail, req = null) {
  const user = req?.user || getCurrentUser();
  if (!user?.id || !message) return;
  try {
    userStore.appendActivity(user.id, {
      type,
      source: detail?.source || 'server',
      message,
      detail,
    });
  } catch (error) {
    console.warn('Failed to record activity:', error.message);
  }
}

function isListingFailure(result) {
  if (result?.failure) return true;
  if (result?.needsReview) return false;
  const status = String(result?.status || '');
  if (status === 'active' || status === 'listing') return false;
  return Boolean(result?.error);
}

function recordListingFailure(raw, req) {
  const failure = sanitizeListingFailure(raw);
  if (!failure) return { dropped: typeof raw?.id === 'string' ? raw.id : null };
  const user = req?.user || getCurrentUser();
  if (!user?.id) return { dropped: failure.id };
  if (failure.id && userStore.hasListingFailure(user.id, failure.id)) return { id: failure.id };
  const label = failure.title ? `"${failure.title}"` : 'an item';
  const where = failure.step ? ` while ${failure.step}` : '';
  recordActivity(
    'error',
    `${platformFailureLabel(failure.platform)} listing failed for ${label}${where}: ${failure.error}`,
    {
      failureId: failure.id,
      listingId: failure.listingId,
      title: failure.title,
      platform: failure.platform,
      outcome: 'error',
      error: failure.error,
      step: failure.step,
      status: failure.status,
      marketplaceCode: failure.marketplaceCode,
      source: failure.source || 'extension',
      trace: failure.trace,
    },
    req
  );
  return { id: failure.id };
}

function serializeError(error) {
  if (error == null) return { message: 'Unknown error' };
  if (typeof error !== 'object') return { message: String(error) };
  return {
    message: error.message || String(error),
    status: error.status || error.response?.status || undefined,
    data: redactValue('data', error.response?.data),
    stack: error.stack,
  };
}

function logError(context, error, extra = {}) {
  const axiosData = error?.response?.data;
  const fallback = error?.message || (typeof error === 'string' ? error : 'Unknown error');
  const message = extra.message || `${context}: ${typeof axiosData === 'string' ? axiosData : fallback}`;
  const detail = {
    source: extra.source || 'server',
    context,
    error: serializeError(error),
    ...(extra.detail || {}),
  };
  console.error(message, axiosData || error);
  if (extra.req) extra.req.loggedError = true;
  recordActivity('error', message, detail, extra.req);
}

process.on('unhandledRejection', (error) => {
  logError('unhandledRejection', error);
});
process.on('uncaughtException', (error) => {
  logError('uncaughtException', error);
});

app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const route = `${req.method} ${req.path}`;
  if (QUIET_API.has(route)) return next();
  const started = Date.now();
  res.on('finish', () => {
    const user = req.user;
    if (!user) return;
    const status = res.statusCode;
    if (status === 304) return;
    if (req.method === 'GET' && req.path === '/api/listings/image-matches') return;
    if (status >= 400 && req.loggedError) return;
    const type = status >= 400 ? 'error' : req.method === 'GET' ? 'info' : 'success';
    const detail = {
      method: req.method,
      path: req.path,
      status,
      ms: Date.now() - started,
    };
    if (req.method !== 'GET' && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      detail.body = redactValue('body', req.body);
    }
    recordActivity(type, `${req.method} ${req.path} → ${status}`, detail, req);
  });
  next();
});

function isLocalhostUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return /localhost|127\.0\.0\.1/.test(String(value || ''));
  }
}

function withHttps(host) {
  const value = String(host || '').trim().replace(/\/$/, '');
  if (!value) return '';
  return value.startsWith('http') ? value : `https://${value}`;
}

function resolveBaseUrl() {
  const explicit = String(process.env.BASE_URL || '').trim().replace(/\/$/, '');
  if (explicit && !isLocalhostUrl(explicit)) return explicit;
  const production = withHttps(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  if (production) return production;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (explicit) return explicit;
  return `http://localhost:${PORT}`;
}

function requestOrigin(req) {
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim();
  if (host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
    const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
    return `${proto}://${host}`.replace(/\/$/, '');
  }
  return BASE_URL;
}

const BASE_URL = resolveBaseUrl();

const UPLOADS_DIR = path.join(userStore.DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function isPlaceholder(value) {
  if (!value) return true;
  const v = String(value).toLowerCase();
  return v.includes('your_') || v.includes('_here') || v === 'changeme';
}

// eBay OAuth redirect_uri must be the RuName from Sign-in Settings, not a URL.
function isEbayRuName(value) {
  if (isPlaceholder(value)) return false;
  const v = String(value).trim();
  return Boolean(v) && !/^https?:\/\//i.test(v) && !v.includes('/');
}

const ebayLiveMode =
  !isPlaceholder(process.env.EBAY_CLIENT_ID) &&
  !isPlaceholder(process.env.EBAY_CLIENT_SECRET) &&
  isEbayRuName(process.env.EBAY_REDIRECT_URI);

const depopLiveMode =
  !isPlaceholder(process.env.DEPOP_CLIENT_ID) &&
  !isPlaceholder(process.env.DEPOP_CLIENT_SECRET);

function getEtsyApiKey() {
  return process.env.ETSY_API_KEY || process.env.ETSY_CLIENT_ID || '';
}

const etsyLiveMode = !isPlaceholder(getEtsyApiKey());

const reverbLiveMode = true;

const googleLiveMode =
  !isPlaceholder(process.env.GOOGLE_CLIENT_ID) &&
  !isPlaceholder(process.env.GOOGLE_CLIENT_SECRET);

function googleRedirectUri(req) {
  const explicit = String(process.env.GOOGLE_REDIRECT_URI || '').trim().replace(/\/$/, '');
  if (explicit && !isLocalhostUrl(explicit)) return explicit;
  const origin = BASE_URL && !isLocalhostUrl(BASE_URL) ? BASE_URL : requestOrigin(req);
  return `${origin}/api/auth/google/callback`;
}

function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function ebayUsesProduction() {
  if (process.env.EBAY_USE_PRODUCTION === 'false') return false;
  if (process.env.EBAY_USE_PRODUCTION === 'true') return true;
  const auth = process.env.EBAY_AUTH_BASE_URL || '';
  const api = process.env.EBAY_BASE_URL || '';
  if (auth.includes('sandbox') || api.includes('sandbox')) return false;
  // Production lets sellers use Google SSO on eBay's official OAuth page.
  return true;
}

function getEbayAuthBase() {
  return ebayUsesProduction() ? 'https://auth.ebay.com' : 'https://auth.sandbox.ebay.com';
}

function getEbayApiBase() {
  return ebayUsesProduction() ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
}

// Listing normalization / import / merge / image hydration / marketplace
// candidates live in server/inventory.js (extracted verbatim 2026-10-02).
// Shared state is injected via initInventory() below.

function ebayAuthHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// eBay user tokens expire after ~2h. Refresh transparently when expiring
// within 5 minutes; falls back to the stored token when refresh is impossible.
async function ensureFreshEbayToken(user) {
  if (!user) return null;
  const expires = Number(user.ebayTokenExpires || 0);
  if (user.ebayToken && (!expires || expires - Date.now() > 5 * 60 * 1000)) {
    return user.ebayToken;
  }
  if (!user.ebayRefreshToken) return user.ebayToken || null;
  try {
    const tokenResponse = await axios.post(
      `${getEbayApiBase()}/identity/v1/oauth2/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: user.ebayRefreshToken,
      }),
      {
        auth: {
          username: process.env.EBAY_CLIENT_ID,
          password: process.env.EBAY_CLIENT_SECRET,
        },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );
    const { access_token, refresh_token, expires_in } = tokenResponse.data || {};
    if (access_token) {
      user.ebayToken = access_token;
      if (refresh_token) user.ebayRefreshToken = refresh_token;
      if (expires_in) user.ebayTokenExpires = Date.now() + Number(expires_in) * 1000;
      try {
        userStore.saveUser(user);
      } catch (persistError) {
        logError('eBay token refresh persist', persistError);
      }
    }
    return user.ebayToken || null;
  } catch (error) {
    logError('eBay token refresh', error);
    return user.ebayToken || null;
  }
}

function mapEbayInventoryItem(item, offer = {}) {
  const listingId = offer.listing?.listingId || offer.offerId || item.sku || uuidv4();
  return {
    title: item.product?.title || 'Untitled Item',
    description: item.product?.description || '',
    price: parseListingPrice(
      offer.pricingSummary?.price ||
        offer.pricingSummary?.auctionStartPrice ||
        item.price
    ),
    quantity:
      offer.availableQuantity ??
      item.availability?.shipToLocationAvailability?.quantity ??
      item.quantity ??
      1,
    images: item.product?.imageUrls || [],
    platform: 'ebay',
    platformListingId: String(listingId),
    status:
      offer.status === 'PUBLISHED' || offer.listing?.listingStatus === 'ACTIVE' || item.availability
        ? 'active'
        : 'inactive',
    url: offer.listing?.listingId ? `https://www.ebay.com/itm/${offer.listing.listingId}` : undefined,
  };
}

async function fetchLiveEbayCandidates(user) {
  let items = [];
  let offers = [];
  try {
    const response = await axios.get(`${getEbayApiBase()}/sell/inventory/v1/inventory_item`, {
      headers: ebayAuthHeaders(user.ebayToken),
      params: { limit: 200 },
    });
    items = response.data.inventoryItems || [];
  } catch (error) {
    logError('eBay inventory fetch', error);
  }

  try {
    const response = await axios.get(`${getEbayApiBase()}/sell/inventory/v1/offer`, {
      headers: ebayAuthHeaders(user.ebayToken),
      params: { limit: 200 },
    });
    offers = response.data.offers || response.data.offerResponses || [];
  } catch (error) {
    logError('eBay offer fetch', error);
  }

  const itemsBySku = new Map();
  for (const item of items) {
    if (item.sku) itemsBySku.set(item.sku, item);
  }

  if (offers.length) {
    return offers.map((offer) => mapEbayInventoryItem(itemsBySku.get(offer.sku) || {}, offer));
  }
  return items.map((item) => mapEbayInventoryItem(item));
}

function mapFacebookCatalogProduct(product) {
  return {
    title: product.title || 'Untitled Item',
    description: product.description || '',
    price: parseListingPrice(product.price) || parseListingPrice(product.sale_price),
    quantity: product.quantity || 1,
    images: product.image_url ? [product.image_url] : [],
    platform: 'facebook',
    platformListingId: product.id,
    status: product.availability === 'in_stock' ? 'active' : 'inactive',
  };
}

async function fetchLiveFacebookCandidates(user) {
  const pagesResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
    params: { access_token: user.facebookToken },
  });
  if (!pagesResponse.data.data?.length) return [];

  const pageAccessToken = pagesResponse.data.data[0].access_token;
  const catalogResponse = await axios.get('https://graph.facebook.com/v18.0/me/product_catalogs', {
    params: { access_token: pageAccessToken },
  });
  if (!catalogResponse.data.data?.length) return [];

  const catalogId = catalogResponse.data.data[0].id;
  const productsResponse = await axios.get(`https://graph.facebook.com/v18.0/${catalogId}/products`, {
    params: {
      access_token: pageAccessToken,
      fields: 'id,title,description,price,image_url,availability,quantity',
    },
  });
  return (productsResponse.data.data || []).map(mapFacebookCatalogProduct);
}

function connectDemoEbay() {
  const user = getDemoUser();
  user.ebayToken = 'demo';
  user.ebayDemo = true;
  seedDemoEbayListings();
  return user;
}

function connectDemoFacebook() {
  const user = getDemoUser();
  user.facebookToken = 'demo';
  user.facebookDemo = true;
  seedDemoFacebookListings();
  return user;
}

// Serve static files from public directory
app.use(express.static('public'));
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/', (_req, res) => {
  res.redirect('/dashboard.html');
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ authenticated: false });
  return res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name || '',
    },
  });
});

// In-memory fixed-window limiter. Fine for one process; use a shared store if you scale out.
const rateBuckets = new Map();

function rateLimitHit(key, max, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return 0;
  }
  bucket.count += 1;
  return bucket.count > max ? Math.ceil((bucket.resetAt - now) / 1000) : 0;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
}, 60 * 1000).unref();

function rejectIfLimited(res, retryAfter) {
  if (!retryAfter) return false;
  res.set('Retry-After', String(retryAfter));
  res.status(429).json({ error: 'Too many attempts. Try again later.' });
  return true;
}

app.post('/api/auth/signup', async (req, res) => {
  if (rejectIfLimited(res, rateLimitHit(`signup:${req.ip}`, 10, 60 * 60 * 1000))) return;
  try {
    const user = await userStore.createUser({
      email: req.body?.email,
      password: req.body?.password,
      name: req.body?.name,
    });
    const sessionId = userStore.createSession(user.id);
    userStore.setSessionCookie(res, sessionId, user);
    return res.status(201).json({
      authenticated: true,
      user: { id: user.id, email: user.email, name: user.name || '' },
    });
  } catch (error) {
    logError('Signup', error, { req });
    return res.status(error.status || 500).json({ error: error.message || 'Could not create account' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const emailKey = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
  const windowMs = 15 * 60 * 1000;
  if (
    rejectIfLimited(res, rateLimitHit(`login-ip:${req.ip}`, 30, windowMs)) ||
    rejectIfLimited(res, rateLimitHit(`login-email:${emailKey}`, 10, windowMs))
  ) {
    return;
  }
  try {
    const user = await userStore.authenticateUser(req.body?.email, req.body?.password);
    rateBuckets.delete(`login-email:${emailKey}`);
    const sessionId = userStore.createSession(user.id);
    userStore.setSessionCookie(res, sessionId, user);
    return res.json({
      authenticated: true,
      user: { id: user.id, email: user.email, name: user.name || '' },
    });
  } catch (error) {
    logError('Login', error, { req });
    return res.status(error.status || 500).json({ error: error.message || 'Could not sign in' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  userStore.deleteSession(req.sessionId);
  userStore.clearSessionCookie(res);
  return res.json({ authenticated: false });
});

const GOOGLE_STATE_COOKIE = 'crosslist_google_state';

app.get('/api/auth/google', (req, res) => {
  if (!googleLiveMode) {
    return res.redirect('/dashboard.html?authError=google-config');
  }
  const state = userStore.issueOAuthState('', 'google');
  // Bind the flow to this browser so a callback URL can't be replayed in someone else's.
  res.append('Set-Cookie', `${GOOGLE_STATE_COOKIE}=${state}; ${userStore.cookieSecurity()}; Max-Age=600`);
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: googleRedirectUri(req),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
  return res.redirect(authUrl);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) {
    return res.redirect('/dashboard.html?authError=google');
  }
  const stateCookie = userStore.parseCookies(req)[GOOGLE_STATE_COOKIE];
  res.append('Set-Cookie', `${GOOGLE_STATE_COOKIE}=; ${userStore.cookieSecurity()}; Max-Age=0`);
  const oauth = userStore.consumeOAuthState(String(state || ''));
  if (!oauth || oauth.platform !== 'google' || !stateCookie || stateCookie !== String(state)) {
    return res.redirect('/dashboard.html?authError=google');
  }

  try {
    const tokenResponse = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code: String(code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenResponse.data?.access_token;
    if (!accessToken) {
      return res.redirect('/dashboard.html?authError=google');
    }

    const profileResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profile = profileResponse.data || {};
    const emailVerified = profile.email_verified === true || profile.email_verified === 'true';
    if (!profile.sub || !profile.email || !emailVerified) {
      return res.redirect('/dashboard.html?authError=google');
    }

    const { user, created } = userStore.findOrCreateGoogleUser({
      googleId: profile.sub,
      email: profile.email,
      name: profile.name || profile.given_name || '',
    });
    const sessionId = userStore.createSession(user.id);
    userStore.setSessionCookie(res, sessionId, user);
    return res.redirect(created ? '/dashboard.html?googleSignup=1' : '/dashboard.html');
  } catch (oauthError) {
    logError('Google OAuth', oauthError, { req });
    return res.redirect('/dashboard.html?authError=google');
  }
});

function isExtensionToken(token) {
  return token === 'extension';
}

const IMPORT_PLATFORMS = ['ebay', 'facebook', 'depop', 'poshmark', 'etsy', 'reverb', 'grailed'];
const DISABLED_PLATFORMS = new Set();

function isStoreEnabled(platform) {
  return IMPORT_PLATFORMS.includes(platform) && !DISABLED_PLATFORMS.has(platform);
}

function disabledStoreMessage(platform) {
  if (platform === 'facebook') return 'Facebook Marketplace is not available right now';
  return 'That store is not available right now';
}

function getConnectionMode(user, platform) {
  if (DISABLED_PLATFORMS.has(platform)) return 'none';
  if (platform === 'ebay') {
    if (user.ebayExtension || isExtensionToken(user.ebayToken)) return 'extension';
    if (user.ebayDemo) return 'demo';
    if (user.ebayToken) return 'live';
    return 'none';
  }
  if (platform === 'facebook') {
    if (user.facebookExtension || isExtensionToken(user.facebookToken)) return 'extension';
    if (user.facebookDemo) return 'demo';
    if (user.facebookToken) return 'live';
    return 'none';
  }
  if (platform === 'depop') {
    if (user.depopExtension || isExtensionToken(user.depopToken)) return 'extension';
    if (user.depopDemo) return 'demo';
    if (user.depopToken) return 'live';
    return 'none';
  }
  if (platform === 'poshmark') {
    if (user.poshmarkExtension || isExtensionToken(user.poshmarkToken)) return 'extension';
    if (user.poshmarkDemo) return 'demo';
    if (user.poshmarkToken) return user.poshmarkPasswordLogin ? 'password' : 'live';
    return 'none';
  }
  if (platform === 'etsy') {
    if (user.etsyExtension || isExtensionToken(user.etsyToken)) return 'extension';
    if (user.etsyDemo) return 'demo';
    if (user.etsyToken) return 'live';
    return 'none';
  }
  if (platform === 'reverb') {
    if (user.reverbExtension || isExtensionToken(user.reverbToken)) return 'extension';
    if (user.reverbDemo) return 'demo';
    if (user.reverbToken) return 'live';
    return 'none';
  }
  if (platform === 'grailed') {
    if (user.grailedExtension || isExtensionToken(user.grailedToken)) return 'extension';
    if (user.grailedDemo) return 'demo';
    if (user.grailedToken) return 'live';
    return 'none';
  }
  return 'none';
}

function isRealConnectionMode(mode) {
  return mode === 'live' || mode === 'password' || mode === 'extension';
}

const CREATE_URLS = {
  ebay: 'https://www.ebay.com/sl/prelist/suggest',
  depop: 'https://www.depop.com/products/create/',
  poshmark: 'https://poshmark.com/create-listing',
  etsy: 'https://www.etsy.com/your/shops/me/tools/listings/create',
  grailed: 'https://www.grailed.com/sell/new',
};

const SESSION_LIST_PLATFORMS = new Set(['reverb']);
const FORM_FILL_PLATFORMS = new Set(['ebay', 'depop', 'poshmark', 'etsy', 'grailed']);

function safeUserId(userId) {
  return String(userId || '').replace(/[^a-zA-Z0-9._-]/g, '');
}

function extFromMime(mime, filename = '') {
  const fromName = String(filename).toLowerCase().match(/\.(jpe?g|png|webp|gif)$/);
  if (fromName) return fromName[1] === 'jpeg' ? 'jpg' : fromName[1];
  const type = String(mime || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
}

function isHeicImage(buffer, mime = '', filename = '') {
  const type = String(mime || '').toLowerCase();
  if (type.includes('heic') || type.includes('heif')) return true;
  if (/\.(heic|heif|hiec)$/i.test(String(filename || ''))) return true;
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brands = buffer.toString('ascii', 8, Math.min(buffer.length, 32)).toLowerCase();
  if (brands.includes('avif') || brands.includes('avis')) return false;
  return /heic|heif|heix|mif1|msf1/.test(brands);
}

async function toStoredImage(buffer, mime = '', filename = '') {
  if (!isHeicImage(buffer, mime, filename)) {
    return { buffer, ext: extFromMime(mime, filename) };
  }
  const jpeg = await convertHeic({
    buffer,
    format: 'JPEG',
    quality: 0.9,
  });
  return { buffer: Buffer.from(jpeg), ext: 'jpg' };
}

async function persistListingImage(userId, image) {
  const raw = String(image || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/uploads/')) return raw;
  if (/^https?:\/\//i.test(raw) && isRealListingImage(raw)) return raw;
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
  if (!match) return '';
  let buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) return '';
  try {
    const stored = await toStoredImage(buffer, match[1]);
    buffer = stored.buffer;
    const owner = safeUserId(userId);
    const dir = path.join(UPLOADS_DIR, owner);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${uuidv4()}.${stored.ext}`;
    fs.writeFileSync(path.join(dir, name), buffer);
    return `/uploads/${owner}/${name}`;
  } catch {
    return '';
  }
}

async function persistListingImages(userId, images = []) {
  const saved = [];
  for (const image of images || []) {
    const url = await persistListingImage(userId, image);
    if (url && !saved.includes(url)) saved.push(url);
    if (saved.length >= 8) break;
  }
  return saved;
}

function connectedStores(user) {
  return IMPORT_PLATFORMS.filter(isStoreEnabled).map((id) => ({ id, mode: getConnectionMode(user, id) })).filter(
    (store) => store.mode && store.mode !== 'none'
  );
}

function requestedPushPlatforms(user, requested) {
  const connected = connectedStores(user);
  const wanted = Array.isArray(requested) && requested.length
    ? requested.map((value) => String(value).toLowerCase()).filter((id) => isStoreEnabled(id))
    : connected.map((store) => store.id);
  return wanted.map((id) => ({
    id,
    mode: getConnectionMode(user, id),
  }));
}

function mapEbayCondition(value) {
  const key = String(value || 'used_good').toLowerCase().replace(/\s+/g, '_');
  if (key === 'new') return 'NEW';
  if (key === 'like_new' || key === 'used_excellent') return 'USED_EXCELLENT';
  if (key === 'used_fair' || key === 'fair') return 'USED_ACCEPTABLE';
  return 'USED_GOOD';
}

function mapReverbConditionUuid(value) {
  const key = String(value || 'used_good').toLowerCase().replace(/\s+/g, '_');
  if (key === 'new' || key === 'brand_new') return '7c3f45de-2ae0-4c81-8400-fdb6b1d74890';
  if (key === 'like_new' || key === 'mint') return 'ac5b9c1e-dc78-466d-b0b3-7cf712967a48';
  if (key === 'used_excellent' || key === 'excellent') return 'df268ad1-c462-4ba6-b6db-e007e23922ea';
  if (key === 'used_fair' || key === 'fair') return '98777886-76d0-44c8-865e-bb40e669e934';
  if (key === 'poor') return '6a9dfcad-600b-46c8-9e08-ce6e5057921e';
  return 'f7a3f48c-972a-44c6-b01a-0cd27488d3f6';
}

function pendingPlatformEntry(listing, platform, extra = {}) {
  return {
    listingId: extra.listingId || null,
    url: extra.url || null,
    status: extra.status || 'pending',
    price: parseListingPrice(listing.price),
    images: listing.images || [],
    error: extra.error || null,
    needsReview: Boolean(extra.needsReview),
  };
}

function applyPlatformResult(listing, platform, result = {}) {
  const platforms = getPlatforms(listing);
  const status = result.status || (result.listingId ? 'active' : result.error ? 'error' : 'listing');
  platforms[platform] = {
    ...pendingPlatformEntry(listing, platform),
    ...platforms[platform],
    listingId: result.listingId || platforms[platform]?.listingId || null,
    url: result.url || platforms[platform]?.url || null,
    status,
    price: parseListingPrice(listing.price),
    images: listing.images || [],
    error: result.error || null,
    needsReview: Boolean(result.needsReview),
  };
  const listed = Object.values(platforms).some((entry) => {
    const value = String(entry?.status || '').toLowerCase();
    return entry?.listingId && value !== 'pending' && value !== 'draft' && value !== 'listing' && value !== 'error';
  });
  return toUnifiedListing({
    ...listing,
    platforms,
    status: listed ? 'active' : listing.status || 'draft',
    lastUpdated: new Date().toISOString(),
  });
}

function extensionTaskFor(platform, listing) {
  return {
    platform,
    createUrl: CREATE_URLS[platform] || null,
    item: {
      id: listing.id,
      title: listing.title,
      description: listing.description || '',
      price: listing.price,
      quantity: listing.quantity || 1,
      images: listing.images || [],
      condition: listing.condition || 'used_good',
      sku: listing.sku || '',
      category: listing.category || 'other',
      details: listing.details || {},
    },
  };
}

function ebayCategoryHint(listing) {
  const category = String(listing?.category || listing?.ebayCategoryId || 'other').toLowerCase();
  const map = {
    clothing: '11450',
    furniture: '11700',
    home: '11700',
    tech: '293',
    tickets: '1305',
    music: '619',
  };
  if (/^\d+$/.test(String(listing?.ebayCategoryId || ''))) return String(listing.ebayCategoryId);
  return map[category] || '1';
}

async function fetchEbayAccountPolicies(user) {
  const headers = {
    ...ebayAuthHeaders(user.ebayToken),
    'Content-Language': 'en-US',
    'Accept-Language': 'en-US',
  };
  const load = async (path, listKey, idKey) => {
    try {
      const response = await axios.get(`${getEbayApiBase()}/sell/account/v1/${path}`, {
        headers,
        params: { marketplace_id: 'EBAY_US' },
        timeout: 15000,
      });
      const list = response.data?.[listKey] || [];
      return list[0]?.[idKey] || null;
    } catch (error) {
      logError(`eBay ${path} fetch`, error);
      return null;
    }
  };
  const [fulfillmentPolicyId, paymentPolicyId, returnPolicyId] = await Promise.all([
    load('fulfillment_policy', 'fulfillmentPolicies', 'fulfillmentPolicyId'),
    load('payment_policy', 'paymentPolicies', 'paymentPolicyId'),
    load('return_policy', 'returnPolicies', 'returnPolicyId'),
  ]);
  return { fulfillmentPolicyId, paymentPolicyId, returnPolicyId };
}

async function fetchEbayInventoryLocation(user) {
  try {
    const response = await axios.get(`${getEbayApiBase()}/sell/inventory/v1/location`, {
      headers: ebayAuthHeaders(user.ebayToken),
      timeout: 15000,
    });
    const locations = response.data?.locations || [];
    const enabled = locations.find((location) => location.merchantLocationStatus === 'ENABLED') || locations[0];
    return enabled?.merchantLocationKey || null;
  } catch (error) {
    logError('eBay inventory location fetch', error);
    return null;
  }
}

async function ebaySellCall(step, request) {
  try {
    return await request();
  } catch (error) {
    logError(`eBay listing ${step}`, error, {
      detail: {
        source: 'ebay-api',
        step,
        url: error.config?.url,
        method: String(error.config?.method || '').toUpperCase() || undefined,
        code: error.code,
        status: error.response?.status,
      },
    });
    error.ebayStep = step;
    throw error;
  }
}

async function createEbayListingViaApi(user, listing) {
  const sku = `xl_${String(listing.id).replace(/[^a-zA-Z0-9]/g, '').slice(-12)}_${Date.now().toString(36)}`;
  const imageUrls = (listing.images || []).filter((url) => /^https:\/\//i.test(url));
  await ebaySellCall('create inventory item', () =>
    axios.put(
    `${getEbayApiBase()}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    {
      availability: {
        shipToLocationAvailability: {
          quantity: listing.quantity || 1,
        },
      },
      condition: mapEbayCondition(listing.condition),
      product: {
        title: String(listing.title || '').slice(0, 80),
        description: listing.description || listing.title || '',
        imageUrls: imageUrls.length ? imageUrls : undefined,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${user.ebayToken}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-US',
      },
      timeout: 20000,
    }
    )
  );

  const policies = await fetchEbayAccountPolicies(user);
  const merchantLocationKey = await fetchEbayInventoryLocation(user);
  if (!policies.fulfillmentPolicyId || !policies.paymentPolicyId || !policies.returnPolicyId) {
    const error = new Error(
      'eBay needs shipping, return, and payment policies in Seller Hub before you can list'
    );
    error.code = 'ebay_policies_required';
    throw error;
  }
  if (!merchantLocationKey) {
    const error = new Error('eBay needs a business location in Seller Hub before you can list');
    error.code = 'ebay_location_required';
    throw error;
  }

  const offerResponse = await ebaySellCall('create offer', () =>
    axios.post(
    `${getEbayApiBase()}/sell/inventory/v1/offer`,
    {
      sku,
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      availableQuantity: listing.quantity || 1,
      categoryId: ebayCategoryHint(listing),
      merchantLocationKey,
      listingPolicies: {
        fulfillmentPolicyId: policies.fulfillmentPolicyId,
        paymentPolicyId: policies.paymentPolicyId,
        returnPolicyId: policies.returnPolicyId,
      },
      pricingSummary: {
        price: {
          value: Number(listing.price || 0).toFixed(2),
          currency: 'USD',
        },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${user.ebayToken}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-US',
      },
      timeout: 20000,
    }
    )
  );

  const offerId = offerResponse.data?.offerId;
  let listingId = sku;
  let url = `https://www.ebay.com/itm/${sku}`;
  if (offerId) {
    try {
      const published = await ebaySellCall('publish offer', () =>
        axios.post(
          `${getEbayApiBase()}/sell/inventory/v1/offer/${offerId}/publish`,
          {},
          {
            headers: {
              Authorization: `Bearer ${user.ebayToken}`,
              'Content-Type': 'application/json',
            },
            timeout: 20000,
          }
        )
      );
      listingId = published.data?.listingId || sku;
      url = `https://www.ebay.com/itm/${listingId}`;
    } catch (error) {
      return {
        status: 'error',
        listingId: sku,
        url,
        needsReview: false,
        error: error.response?.data?.errors?.[0]?.message || error.message,
      };
    }
  }
  return { status: 'active', listingId, url };
}

async function createReverbListingViaApi(user, listing) {
  const details = listing.details && typeof listing.details === 'object' ? listing.details : {};
  const title = String(listing.title || '').slice(0, 255);
  const words = title.split(/\s+/).filter(Boolean);
  const make = String(details.brand || details.make || words[0] || 'Unknown').slice(0, 80);
  const model = String(details.model || words.slice(1).join(' ') || title).slice(0, 80);
  const photos = (listing.images || []).filter((url) => /^https:\/\//i.test(url));
  const quantity = Math.max(1, Number(listing.quantity) || 1);
  
  let categoryUuid = null;
  try {
    const categorySearch = await axios.get(
      `https://api.reverb.com/api/categories?q=${encodeURIComponent(title.slice(0, 50))}`,
      { 
        headers: reverbApiHeaders(user.reverbToken), 
        timeout: 5000 
      }
    );
    const categories = categorySearch.data?.categories || [];
    categoryUuid = categories[0]?.uuid || null;
  } catch (error) {
    logError('Reverb category lookup', error);
  }

  const payload = {
    title,
    make,
    model,
    description: listing.description || listing.title || '',
    price: {
      amount: Number(listing.price || 0).toFixed(2),
      currency: 'USD',
    },
    condition: { uuid: mapReverbConditionUuid(listing.condition) },
    photos,
    sku: listing.sku || undefined,
    upc_does_not_apply: true,
    has_inventory: true,
    inventory: quantity,
    shipping: { local: true },
    publish: true,
  };
  
  if (details.year) payload.year = String(details.year);
  if (categoryUuid) {
    payload.categories = [{ uuid: categoryUuid }];
  }

  try {
    const response = await axios.post(
      'https://api.reverb.com/api/listings',
      payload,
      { headers: reverbApiHeaders(user.reverbToken), timeout: 20000 }
    );
    
    const created = response.data || {};
    const listingId = String(created.id || created.listing_id || '');
    const url = created._links?.web?.href || (listingId ? `https://reverb.com/item/${listingId}` : null);
    const slug = String(created.state?.slug || created.state || '').toLowerCase();
    const isLive = slug === 'live' || slug === 'published' || slug === 'active';
    
    if (!listingId) {
      return {
        status: 'error',
        listingId: null,
        url: null,
        needsReview: false,
        error: 'Reverb did not return a listing ID',
      };
    }

    if (!isLive) {
      try {
        await axios.put(
          `https://api.reverb.com/api/listings/${encodeURIComponent(listingId)}`,
          { state: { slug: 'live' } },
          { headers: reverbApiHeaders(user.reverbToken), timeout: 15000 }
        );
      } catch (publishError) {
        logError('Reverb publish after create', publishError);
        return {
          status: 'draft',
          listingId,
          url,
          needsReview: true,
          error: 'Listing created but could not be published automatically',
        };
      }
    }

    return {
      status: 'active',
      listingId,
      url,
      needsReview: false,
    };
  } catch (error) {
    const message =
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.response?.data?.errors?.[0] ||
      error.message ||
      'Reverb listing failed';
    
    if (error.response?.status === 401 || error.response?.status === 403) {
      throw new Error('Invalid or expired Reverb token. Reconnect Reverb from Marketplaces.');
    }
    
    throw new Error(String(message));
  }
}

async function createDepopListingViaApi(user, listing) {
  const imageUrls = (listing.images || []).filter((url) => /^https:\/\//i.test(url));
  const payload = {
    name: String(listing.title || '').slice(0, 200),
    description: String(listing.description || listing.title || ''),
    price_amount: Math.round(Number(listing.price || 0) * 100),
    currency: 'USD',
    category_id: 1,
    condition: mapDepopCondition(listing.condition),
    quantity: listing.quantity || 1,
  };

  if (imageUrls.length > 0) {
    payload.pictures = imageUrls.slice(0, 4).map((url) => ({ url }));
  }

  try {
    const response = await axios.post(
      'https://partnerapi.depop.com/api/v1/products/',
      payload,
      {
        headers: {
          Authorization: `Bearer ${user.depopToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const created = response.data || {};
    const listingId = String(created.id || created.slug || '');
    const url = created.slug ? `https://www.depop.com/products/${created.slug}` : null;

    if (!listingId) {
      return {
        status: 'error',
        listingId: null,
        url: null,
        needsReview: false,
        error: 'Depop did not create the listing',
      };
    }

    return {
      status: 'active',
      listingId,
      url,
      needsReview: false,
    };
  } catch (error) {
    const message =
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.response?.data?.errors?.[0]?.message ||
      error.message ||
      'Depop listing failed';
    throw new Error(message);
  }
}

function mapDepopCondition(condition) {
  const key = String(condition || 'used_good').toLowerCase().replace(/\s+/g, '_');
  const conditionMap = {
    new: 'new_with_tags',
    brand_new: 'new_with_tags',
    like_new: 'new_without_tags',
    mint: 'new_without_tags',
    used_excellent: 'used_excellent',
    excellent: 'used_excellent',
    used_good: 'used_good',
    used_fair: 'used_fair',
    fair: 'used_fair',
    poor: 'used_fair',
  };
  return conditionMap[key] || 'used_good';
}

async function createEtsyListingViaApi(user, listing) {
  let shopId = user.etsyShopId;
  if (!shopId) {
    const me = await axios.get('https://api.etsy.com/v3/application/users/me', {
      headers: etsyApiHeaders(user.etsyToken),
    });
    const userId = me.data.user_id || me.data.userId;
    const shops = await axios.get(`https://api.etsy.com/v3/application/users/${userId}/shops`, {
      headers: etsyApiHeaders(user.etsyToken),
    });
    const shop = shops.data?.shop_id ? shops.data : shops.data?.results?.[0] || shops.data?.shops?.[0];
    shopId = shop?.shop_id || shop?.shopId;
    if (shopId) {
      user.etsyShopId = shopId;
      persistStore();
    }
  }

  if (!shopId) {
    const error = new Error('Etsy shop ID not found. Connect your Etsy shop from Marketplaces.');
    error.code = 'etsy_shop_required';
    throw error;
  }

  const quantity = listing.quantity || 1;
  const price = Number(listing.price || 0).toFixed(2);
  const payload = {
    title: String(listing.title || '').slice(0, 140),
    description: String(listing.description || listing.title || ''),
    price,
    quantity,
    who_made: 'i_did',
    when_made: '2020_2026',
    taxonomy_id: 1,
    is_supply: false,
    should_auto_renew: false,
    type: 'physical',
  };

  const imageUrls = (listing.images || []).filter((url) => /^https:\/\//i.test(url));

  try {
    const response = await axios.post(
      `https://openapi.etsy.com/v3/application/shops/${shopId}/listings`,
      payload,
      {
        headers: etsyApiHeaders(user.etsyToken),
        timeout: 20000,
      }
    );

    const created = response.data || {};
    const listingId = String(created.listing_id || created.id || '');
    const url = `https://www.etsy.com/listing/${listingId}`;

    if (!listingId) {
      return {
        status: 'error',
        listingId: null,
        url: null,
        needsReview: false,
        error: 'Etsy did not create the listing',
      };
    }

    if (imageUrls.length > 0) {
      try {
        for (const imageUrl of imageUrls.slice(0, 10)) {
          await axios.post(
            `https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${listingId}/images`,
            { image_url: imageUrl },
            {
              headers: etsyApiHeaders(user.etsyToken),
              timeout: 20000,
            }
          );
        }
      } catch (imageError) {
        logError('Etsy image upload', imageError);
      }
    }

    return {
      status: 'active',
      listingId,
      url,
      needsReview: false,
    };
  } catch (error) {
    const message =
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.response?.data?.errors?.[0]?.message ||
      error.message ||
      'Etsy listing failed';
    throw new Error(message);
  }
}

async function pushListingToStores(listing, user, platforms) {
  const results = [];
  const extensionTasks = [];
  let next = toUnifiedListing(listing);

  for (const store of platforms) {
    const { id: platform, mode } = store;
    if (!mode || mode === 'none') {
      const result = {
        platform,
        status: 'error',
        error: `Connect ${platform} before listing`,
      };
      next = applyPlatformResult(next, platform, result);
      results.push(result);
      continue;
    }

    if (mode === 'demo') {
      const result = {
        platform,
        status: 'active',
        listingId: `demo_${platform}_${next.id}`,
        url: null,
      };
      next = applyPlatformResult(next, platform, result);
      results.push({ ...result, mode });
      continue;
    }

    if (platform === 'ebay' && mode === 'live') {
      try {
        const result = await createEbayListingViaApi(user, next);
        next = applyPlatformResult(next, platform, result);
        results.push({ ...result, platform, mode });
      } catch (error) {
        const message =
          error.response?.data?.errors?.[0]?.message ||
          error.response?.data?.error ||
          error.message ||
          'eBay listing failed';
        if (!error.ebayStep) logError('Create eBay listing via API', error);
        const result = {
          platform,
          status: 'error',
          error: error.ebayStep ? `${message} (${error.ebayStep})` : message,
          needsReview: false,
          needsPolicies: error.code === 'ebay_policies_required',
        };
        next = applyPlatformResult(next, platform, result);
        results.push({ ...result, mode });
      }
      continue;
    }

    if (platform === 'reverb' && mode === 'live') {
      try {
        const result = await createReverbListingViaApi(user, next);
        next = applyPlatformResult(next, platform, result);
        results.push({ ...result, platform, mode });
      } catch (error) {
        const message =
          error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          'Reverb listing failed';
        const result = { platform, status: 'error', error: message, needsReview: false };
        next = applyPlatformResult(next, platform, result);
        results.push({ ...result, mode });
      }
      continue;
    }

    if (platform === 'depop' && mode === 'live') {
      try {
        const result = await createDepopListingViaApi(user, next);
        next = applyPlatformResult(next, platform, result);
        results.push({ ...result, platform, mode });
      } catch (error) {
        const message =
          error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          'Depop listing failed';
        const result = { platform, status: 'error', error: message, needsReview: false };
        next = applyPlatformResult(next, platform, result);
        results.push({ ...result, mode });
      }
      continue;
    }

    if (platform === 'etsy' && mode === 'live') {
      try {
        const result = await createEtsyListingViaApi(user, next);
        next = applyPlatformResult(next, platform, result);
        results.push({ ...result, platform, mode });
      } catch (error) {
        const message =
          error.response?.data?.error ||
          error.response?.data?.message ||
          error.message ||
          'Etsy listing failed';
        const result = {
          platform,
          status: 'error',
          error: message,
          needsReview: false,
          needsShop: error.code === 'etsy_shop_required',
        };
        next = applyPlatformResult(next, platform, result);
        results.push({ ...result, mode });
      }
      continue;
    }

    if (SESSION_LIST_PLATFORMS.has(platform) || FORM_FILL_PLATFORMS.has(platform)) {
      const result = {
        platform,
        status: 'listing',
        needsReview: FORM_FILL_PLATFORMS.has(platform),
      };
      next = applyPlatformResult(next, platform, result);
      results.push({ ...result, mode });
      extensionTasks.push(extensionTaskFor(platform, next));
      continue;
    }

    const result = { platform, status: 'error', error: `Could not list on ${platform}` };
    next = applyPlatformResult(next, platform, result);
    results.push({ ...result, mode });
  }

  listings.set(next.id, next);
  return { listing: next, results, extensionTasks };
}

function isPlaceholderImportListing(listing) {
  const id = String(listing?.platformListingId || listing?.id || '');
  const image = String(listing?.images?.[0] || '');
  return /^demo[_-]/i.test(id) || /placehold\.co/i.test(image);
}

function ensureConnectedForImport(platform, { mode, account } = {}) {
  const user = getDemoUser();
  const current = getConnectionMode(user, platform);
  if (isRealConnectionMode(current)) return current;

  if (mode === 'extension') {
    if (platform === 'ebay') {
      user.ebayToken = 'extension';
      user.ebayExtension = true;
      user.ebayDemo = false;
      user.ebayAccount = account || 'ebay-browser-session';
    } else if (platform === 'facebook') {
      user.facebookToken = 'extension';
      user.facebookExtension = true;
      user.facebookDemo = false;
      user.facebookAccount = account || 'facebook-browser-session';
    } else if (platform === 'depop') {
      user.depopToken = 'extension';
      user.depopExtension = true;
      user.depopAccount = account || 'depop-browser-session';
    } else if (platform === 'poshmark') {
      user.poshmarkToken = 'extension';
      user.poshmarkExtension = true;
      user.poshmarkDemo = false;
      user.poshmarkPasswordLogin = false;
      user.poshmarkAccount = account || 'poshmark-browser-session';
    } else if (platform === 'etsy') {
      user.etsyToken = 'extension';
      user.etsyExtension = true;
      user.etsyDemo = false;
      user.etsyAccount = account || 'etsy-browser-session';
    } else if (platform === 'reverb') {
      user.reverbToken = 'extension';
      user.reverbExtension = true;
      user.reverbDemo = false;
      user.reverbAccount = account || 'reverb-browser-session';
    }
    persistStore();
    return 'extension';
  }

  const error = new Error(`Connect ${platform} to import listings`);
  error.status = 400;
  throw error;
}

app.get('/api/auth/status', (_req, res) => {
  const user = getDemoUser();
  res.json({
    ebay: {
      connected: Boolean(user.ebayToken),
      mode: getConnectionMode(user, 'ebay'),
      account: user.ebayAccount || null,
    },
    facebook: {
      connected: false,
      mode: 'none',
      account: null,
    },
    depop: {
      connected: Boolean(user.depopToken),
      mode: getConnectionMode(user, 'depop'),
      account: user.depopAccount || null,
    },
    poshmark: {
      connected: Boolean(user.poshmarkToken),
      mode: getConnectionMode(user, 'poshmark'),
      account: user.poshmarkAccount || null,
    },
    etsy: {
      connected: Boolean(user.etsyToken),
      mode: getConnectionMode(user, 'etsy'),
      account: user.etsyAccount || null,
    },
    reverb: {
      connected: Boolean(user.reverbToken),
      mode: getConnectionMode(user, 'reverb'),
      account: user.reverbAccount || null,
    },
    credentials: {
      ebayLiveMode,
      facebookLiveMode: false,
      facebookRequiresExtension: true,
      depopLiveMode,
      etsyLiveMode,
      reverbLiveMode,
      googleLiveMode,
    },
    user: {
      id: user.id,
      email: user.email,
      name: user.name || '',
    },
    requiresExtension: false,
  });
});

app.post('/api/auth/connect/extension', (req, res) => {
  const { platform, listings: incoming = [], account } = req.body || {};
  if (!isStoreEnabled(platform)) {
    return res.status(400).json({ error: DISABLED_PLATFORMS.has(platform) ? disabledStoreMessage(platform) : 'Invalid platform' });
  }

  const user = getDemoUser();
  if (platform === 'ebay') {
    user.ebayToken = 'extension';
    user.ebayExtension = true;
    user.ebayDemo = false;
    user.ebayAccount = account || 'ebay-browser-session';
  } else if (platform === 'facebook') {
    user.facebookToken = 'extension';
    user.facebookExtension = true;
    user.facebookDemo = false;
    user.facebookAccount = account || 'facebook-browser-session';
  } else if (platform === 'depop') {
    user.depopToken = 'extension';
    user.depopExtension = true;
    user.depopAccount = account || 'depop-browser-session';
  } else if (platform === 'poshmark') {
    user.poshmarkToken = 'extension';
    user.poshmarkExtension = true;
    user.poshmarkDemo = false;
    user.poshmarkPasswordLogin = false;
    user.poshmarkAccount = account || 'poshmark-browser-session';
  } else if (platform === 'etsy') {
    user.etsyToken = 'extension';
    user.etsyExtension = true;
    user.etsyDemo = false;
    user.etsyAccount = account || 'etsy-browser-session';
  } else if (platform === 'reverb') {
    user.reverbToken = 'extension';
    user.reverbExtension = true;
    user.reverbDemo = false;
    user.reverbAccount = account || 'reverb-browser-session';
  }

  persistStore();

  incoming.forEach((listing) => {
    if (!listing?.title && !listing?.id) return;
    upsertImportedListing(listing);
  });

  return res.json({
    connected: true,
    mode: 'extension',
    imported: incoming.length,
  });
});

function oauthConnectResponse(platform, liveMode, redirect) {
  if (liveMode) {
    return { connected: false, mode: 'live', redirect };
  }
  return {
    connected: false,
    useExtension: true,
    message: `Connect ${platform} with the Chrome helper.`,
  };
}

function redirectToExtensionConnect(res, platform) {
  return res.redirect(`/dashboard.html?connect=${platform}-extension#marketplaces`);
}

app.post('/api/auth/connect/ebay', (_req, res) => {
  return res.json(oauthConnectResponse('eBay', ebayLiveMode, '/api/auth/ebay/live'));
});

app.post('/api/auth/connect/facebook', (_req, res) => {
  // Facebook Marketplace has no public listing API — connection happens through
  // the Crosslist Connector Chrome extension using the user's Facebook login.
  return res.json({
    connected: false,
    needsExtension: true,
    message: 'Connect Facebook Marketplace with the Crosslist Connector Chrome extension (it uses your Facebook login in Chrome).',
  });
});

app.post('/api/auth/connect/depop', (_req, res) => {
  return res.json(oauthConnectResponse('Depop', depopLiveMode, '/api/auth/depop/live'));
});

app.post('/api/auth/connect/etsy', (_req, res) => {
  return res.json(oauthConnectResponse('Etsy', etsyLiveMode, '/api/auth/etsy/live'));
});

app.post('/api/auth/connect/reverb', (_req, res) => {
  return res.json(oauthConnectResponse('Reverb', reverbLiveMode, '/api/auth/reverb/live'));
});

app.post('/api/auth/connect/poshmark', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const session = await loginToPoshmark(email, password);
    const user = getDemoUser();
    user.poshmarkToken = session.token;
    user.poshmarkRefreshToken = session.refreshToken || null;
    user.poshmarkDemo = false;
    user.poshmarkExtension = false;
    user.poshmarkPasswordLogin = true;
    user.poshmarkAccount = session.username || email;
    persistStore();
    return res.json({
      connected: true,
      mode: 'password',
      account: user.poshmarkAccount,
    });
  } catch (error) {
    logError('Poshmark sign-in', error, { req });
    const status = error.status === 401 ? 401 : 502;
    return res.status(status).json({
      error: error.message || 'Poshmark sign-in failed',
      canUseExtension: true,
    });
  }
});

app.post('/api/auth/connect/demo', (req, res) => {
  const { platform } = req.body || {};
  if (platform === 'ebay') {
    connectDemoEbay();
    return res.json({ connected: true, mode: 'demo' });
  }
  if (platform === 'facebook') {
    return res.status(400).json({ error: disabledStoreMessage('facebook') });
  }
  return res.status(400).json({ error: 'platform required' });
});

app.post('/api/auth/disconnect', (req, res) => {
  const { platform } = req.body || {};
  if (!IMPORT_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }

  const user = getDemoUser();
  if (platform === 'ebay') {
    delete user.ebayToken;
    delete user.ebayRefreshToken;
    delete user.ebayTokenExpires;
    delete user.ebayDemo;
    delete user.ebayExtension;
    delete user.ebayAccount;
  } else if (platform === 'facebook') {
    delete user.facebookToken;
    delete user.facebookTokenExpires;
    delete user.facebookPages;
    delete user.facebookDemo;
    delete user.facebookExtension;
    delete user.facebookAccount;
  } else if (platform === 'depop') {
    delete user.depopToken;
    delete user.depopDemo;
    delete user.depopExtension;
    delete user.depopAccount;
    delete user.depopRefreshToken;
    delete user.depopTokenExpires;
  } else if (platform === 'poshmark') {
    delete user.poshmarkToken;
    delete user.poshmarkRefreshToken;
    delete user.poshmarkDemo;
    delete user.poshmarkExtension;
    delete user.poshmarkPasswordLogin;
    delete user.poshmarkAccount;
  } else if (platform === 'etsy') {
    delete user.etsyToken;
    delete user.etsyRefreshToken;
    delete user.etsyTokenExpires;
    delete user.etsyDemo;
    delete user.etsyExtension;
    delete user.etsyAccount;
    delete user.etsyUserId;
    delete user.etsyShopId;
  } else if (platform === 'reverb') {
    delete user.reverbToken;
    delete user.reverbRefreshToken;
    delete user.reverbTokenExpires;
    delete user.reverbDemo;
    delete user.reverbExtension;
    delete user.reverbAccount;
    delete user.reverbUserId;
    delete user.reverbShopId;
  }

  persistStore();
  return res.json({ connected: false, platform, mode: 'none' });
});

// ======================
// EBAY AUTHENTICATION
// ======================

// Initiate eBay OAuth flow (browser navigation)
app.get('/api/auth/ebay', (req, res) => {
  if (!ebayLiveMode) {
    if (!requirePageLogin(req, res)) return;
    return redirectToExtensionConnect(res, 'ebay');
  }
  if (!requirePageLogin(req, res)) return;
  return res.redirect('/api/auth/ebay/live');
});

app.get('/api/auth/ebay/live', (req, res) => {
  const state = beginOAuth(req, res, 'ebay');
  if (!state) return;
  const authUrl = `${getEbayAuthBase()}/oauth2/authorize?` +
    new URLSearchParams({
      client_id: process.env.EBAY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: process.env.EBAY_REDIRECT_URI,
      scope: process.env.EBAY_SCOPES || 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account',
      state: state
    });
  // Do not set prompt=login. Production eBay sign-in includes Continue with Google.
  
  res.redirect(authUrl);
});

// Handle eBay OAuth callback
app.get('/api/auth/ebay/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (!code) {
    return res.status(400).send('Authorization code not provided');
  }

  const oauthResult = userFromOAuthState(String(state || ''));
  if (!oauthResult?.user) {
    return res.redirect('/dashboard.html?oauthError=ebay#marketplaces');
  }
  
  try {
    // Exchange authorization code for access token
    const tokenResponse = await axios.post(`${getEbayApiBase()}/identity/v1/oauth2/token`, 
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.EBAY_REDIRECT_URI
      }), {
        auth: {
          username: process.env.EBAY_CLIENT_ID,
          password: process.env.EBAY_CLIENT_SECRET
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
    
    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const userData = oauthResult.user;
    Object.assign(userData, {
      ebayToken: access_token,
      ebayRefreshToken: refresh_token,
      ebayTokenExpires: Date.now() + (expires_in * 1000),
      ebayDemo: false,
      ebayExtension: false,
      ebayAccount: 'ebay-oauth',
    });
    userStore.saveUser(userData);
    
    res.redirect('/dashboard.html?connected=ebay#marketplaces');
  } catch (error) {
    logError('eBay OAuth', error, { req });
    res.status(500).send('Authentication failed');
  }
});

// ======================
// FACEBOOK MARKETPLACE
// Facebook Marketplace has no public listing OAuth API.
// Connect happens through the Chrome extension.
// ======================

app.get(['/api/auth/facebook', '/api/auth/facebook/live', '/api/auth/facebook/callback'], (req, res) => {
  if (!requirePageLogin(req, res)) return;
  return res.redirect('/dashboard.html#marketplaces');
});

// ======================
// DEPOP AUTHENTICATION
// ======================

function getDepopAuthUrl() {
  return String(process.env.DEPOP_AUTH_URL || 'https://www.depop.com/settings/oauth/apps/').replace(/\/?$/, '/');
}

function getDepopTokenUrl() {
  return process.env.DEPOP_TOKEN_URL || 'https://partnerapi.depop.com/api/v1/oauth2/access-token/';
}

function getDepopRedirectUri() {
  return process.env.DEPOP_REDIRECT_URI || `${BASE_URL}/api/auth/depop/callback`;
}

function getDepopScopes() {
  const raw = process.env.DEPOP_SCOPES || 'products_read products_write shop_read orders_read';
  return raw.trim().split(/[\s+]+/).filter(Boolean).join('+');
}

app.get('/api/auth/depop', (req, res) => {
  if (!depopLiveMode) {
    if (!requirePageLogin(req, res)) return;
    return redirectToExtensionConnect(res, 'depop');
  }
  if (!requirePageLogin(req, res)) return;
  return res.redirect('/api/auth/depop/live');
});

app.get('/api/auth/depop/live', (req, res) => {
  const pkce = createPkce();
  const state = beginOAuth(req, res, 'depop', { verifier: pkce.verifier });
  if (!state) return;
  const authUrl = `${getDepopAuthUrl()}?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: process.env.DEPOP_CLIENT_ID,
      redirect_uri: getDepopRedirectUri(),
      scope: getDepopScopes(),
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
  res.redirect(authUrl);
});

app.get('/api/auth/depop/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) {
    return res.redirect('/dashboard.html?oauthError=depop#marketplaces');
  }

  const oauthResult = userFromOAuthState(String(state || ''));
  if (!oauthResult?.user) {
    return res.redirect('/dashboard.html?oauthError=depop#marketplaces');
  }
  const pkce = oauthResult.oauth.extra;
  if (!pkce?.verifier) {
    return res.redirect('/dashboard.html?oauthError=depop#marketplaces');
  }

  try {
    const tokenResponse = await axios.post(
      getDepopTokenUrl(),
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: process.env.DEPOP_CLIENT_ID,
        client_secret: process.env.DEPOP_CLIENT_SECRET,
        redirect_uri: getDepopRedirectUri(),
        code_verifier: pkce.verifier,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const userData = oauthResult.user;
    Object.assign(userData, {
      depopToken: access_token,
      depopRefreshToken: refresh_token,
      depopTokenExpires: expires_in ? Date.now() + (expires_in * 1000) : null,
      depopDemo: false,
      depopExtension: false,
      depopAccount: 'depop-oauth',
    });
    userStore.saveUser(userData);

    res.redirect('/dashboard.html?connected=depop#marketplaces');
  } catch (depopError) {
    logError('Depop OAuth', depopError, { req });
    res.redirect('/dashboard.html?oauthError=depop#marketplaces');
  }
});

// ======================
// POSHMARK PASSWORD LOGIN
// ======================

function poshmarkError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function loginToPoshmark(email, password) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://poshmark.com',
    Referer: 'https://poshmark.com/login',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  };
  const endpoints = [
    'https://poshmark.com/vm-rest/auth/users/access_token',
    'https://poshmark.com/auth/users/access_token',
  ];

  let lastNetworkError = null;
  for (const url of endpoints) {
    try {
      const response = await axios.post(
        url,
        { username: email, password },
        { headers, timeout: 15000, validateStatus: () => true }
      );
      const data = response.data || {};
      const token = data.token || data.access_token || data.jwt || data.id_token;
      if (response.status >= 200 && response.status < 300 && token) {
        return {
          token,
          refreshToken: data.refresh_token || null,
          username: data.username || data.user?.username || data.user?.email || email,
        };
      }
      if (response.status === 400 || response.status === 401) {
        const message =
          data.errorMessage ||
          data.error_message ||
          data.message ||
          data.error ||
          'Invalid Poshmark email or password';
        throw poshmarkError(typeof message === 'string' ? message : 'Invalid Poshmark email or password', 401);
      }
    } catch (error) {
      if (error.status === 401) throw error;
      logError('Poshmark login endpoint', error, { detail: { url } });
      lastNetworkError = error;
    }
  }

  throw poshmarkError(
    lastNetworkError?.message
      ? `Poshmark sign-in failed (${lastNetworkError.message}). Try the Chrome extension.`
      : 'Poshmark sign-in failed. Check your email and password, or connect with the Chrome extension.',
    502
  );
}

// ======================
// ETSY OAUTH
// ======================

function getEtsyRedirectUri() {
  return process.env.ETSY_REDIRECT_URI || `${BASE_URL}/api/auth/etsy/callback`;
}

function getEtsyScopes() {
  return process.env.ETSY_SCOPES || 'listings_r listings_w shops_r shops_w transactions_r';
}

function etsyApiHeaders(accessToken) {
  return {
    'x-api-key': getEtsyApiKey(),
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
}

app.get('/api/auth/etsy', (req, res) => {
  if (!etsyLiveMode) {
    if (!requirePageLogin(req, res)) return;
    return redirectToExtensionConnect(res, 'etsy');
  }
  if (!requirePageLogin(req, res)) return;
  return res.redirect('/api/auth/etsy/live');
});

app.get('/api/auth/etsy/live', (req, res) => {
  if (!etsyLiveMode) {
    return res.redirect('/dashboard.html?oauthError=etsy#marketplaces');
  }
  const pkce = createPkce();
  const state = beginOAuth(req, res, 'etsy', { verifier: pkce.verifier });
  if (!state) return;
  const authUrl =
    'https://www.etsy.com/oauth/connect?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: getEtsyApiKey(),
      redirect_uri: getEtsyRedirectUri(),
      scope: getEtsyScopes(),
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
  res.redirect(authUrl);
});

app.get('/api/auth/etsy/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) {
    return res.redirect('/dashboard.html?oauthError=etsy#marketplaces');
  }

  const oauthResult = userFromOAuthState(String(state || ''));
  if (!oauthResult?.user) {
    return res.redirect('/dashboard.html?oauthError=etsy#marketplaces');
  }
  const pkce = oauthResult.oauth.extra;
  if (!pkce?.verifier) {
    return res.redirect('/dashboard.html?oauthError=etsy#marketplaces');
  }

  try {
    const tokenResponse = await axios.post(
      'https://api.etsy.com/v3/public/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: getEtsyApiKey(),
        redirect_uri: getEtsyRedirectUri(),
        code: String(code),
        code_verifier: pkce.verifier,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    let account = 'etsy-oauth';
    let userId = null;
    let shopId = null;
    try {
      const me = await axios.get('https://api.etsy.com/v3/application/users/me', {
        headers: etsyApiHeaders(access_token),
      });
      userId = me.data.user_id || me.data.userId || null;
      account = me.data.login_name || me.data.primary_email || account;
      if (userId) {
        const shops = await axios.get(`https://api.etsy.com/v3/application/users/${userId}/shops`, {
          headers: etsyApiHeaders(access_token),
        });
        const shop = shops.data?.shop_id
          ? shops.data
          : shops.data?.results?.[0] || shops.data?.shops?.[0];
        shopId = shop?.shop_id || shop?.shopId || null;
        account = shop?.shop_name || account;
      }
    } catch (profileError) {
      logError('Etsy profile lookup', profileError, { req });
    }

    const userData = oauthResult.user;
    Object.assign(userData, {
      etsyToken: access_token,
      etsyRefreshToken: refresh_token,
      etsyTokenExpires: expires_in ? Date.now() + expires_in * 1000 : null,
      etsyDemo: false,
      etsyExtension: false,
      etsyAccount: account,
      etsyUserId: userId,
      etsyShopId: shopId,
    });
    userStore.saveUser(userData);

    res.redirect('/dashboard.html?connected=etsy#marketplaces');
  } catch (oauthError) {
    logError('Etsy OAuth', oauthError, { req });
    res.redirect('/dashboard.html?oauthError=etsy#marketplaces');
  }
});

function mapEtsyListing(listing) {
  const images = [];
  if (listing.images?.[0]?.url_570xN) images.push(listing.images[0].url_570xN);
  else if (listing.MainImage?.url_570xN) images.push(listing.MainImage.url_570xN);
  else if (listing.image_urls?.[0]) images.push(listing.image_urls[0]);
  const price = parseListingPrice(listing.price);
  return {
    title: listing.title || 'Untitled Item',
    description: listing.description || '',
    price,
    quantity: listing.quantity || 1,
    images,
    platform: 'etsy',
    platformListingId: String(listing.listing_id || listing.listingId || listing.id),
    status: listing.state === 'active' ? 'active' : listing.state || 'active',
    url: listing.url || `https://www.etsy.com/listing/${listing.listing_id}`,
  };
}

async function fetchLiveEtsyCandidates(user) {
  if (!user.etsyToken || user.etsyDemo || user.etsyExtension) return [];
  let shopId = user.etsyShopId;
  if (!shopId) {
    const me = await axios.get('https://api.etsy.com/v3/application/users/me', {
      headers: etsyApiHeaders(user.etsyToken),
    });
    const userId = me.data.user_id || me.data.userId;
    const shops = await axios.get(`https://api.etsy.com/v3/application/users/${userId}/shops`, {
      headers: etsyApiHeaders(user.etsyToken),
    });
    const shop = shops.data?.shop_id ? shops.data : shops.data?.results?.[0] || shops.data?.shops?.[0];
    shopId = shop?.shop_id || shop?.shopId;
    if (shopId) {
      user.etsyShopId = shopId;
      persistStore();
    }
  }
  if (!shopId) return [];

  const response = await axios.get(
    `https://api.etsy.com/v3/application/shops/${shopId}/listings/active`,
    {
      headers: etsyApiHeaders(user.etsyToken),
      params: { limit: 50, includes: 'Images' },
    }
  );
  const results = response.data.results || response.data.listings || [];
  return results.map(mapEtsyListing);
}

// ======================
// REVERB PERSONAL TOKEN
// ======================
// Note: Reverb OAuth is no longer available (as of Sep 2026).
// Users authenticate with personal access tokens from https://reverb.com/my/api_settings

function reverbApiHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/hal+json',
    'Accept-Version': '3.0',
    'Content-Type': 'application/hal+json',
    'User-Agent': `Crosslist/1.0 (+${BASE_URL})`,
  };
}

async function validateReverbToken(token) {
  try {
    const response = await axios.get('https://api.reverb.com/api/my/account', {
      headers: reverbApiHeaders(token),
      timeout: 10000,
    });
    
    const data = response.data || {};
    return {
      valid: true,
      userId: data.id || data.user_id || null,
      account: data.shop?.name || data.username || data.email || 'reverb-user',
      shopId: data.shop?.id || null,
    };
  } catch (error) {
    if (error.response?.status === 401 || error.response?.status === 403) {
      return { valid: false, error: 'Invalid or expired Reverb token' };
    }
    logError('Reverb token validation', error);
    return { 
      valid: false, 
      error: error.message || 'Could not validate Reverb token' 
    };
  }
}

app.get('/api/auth/reverb', (req, res) => {
  if (!requirePageLogin(req, res)) return;
  return res.json({
    method: 'token',
    message: 'Connect Reverb with a personal access token',
    tokenUrl: 'https://reverb.com/my/api_settings',
  });
});

app.post('/api/auth/reverb/connect', async (req, res) => {
  try {
    const user = getDemoUser();
    const token = String(req.body?.token || '').trim();
    
    if (!token) {
      return res.status(400).json({ 
        error: 'Personal access token is required' 
      });
    }
    
    if (token.length < 20 || token.length > 200) {
      return res.status(400).json({ 
        error: 'Token format appears invalid' 
      });
    }

    const validation = await validateReverbToken(token);
    
    if (!validation.valid) {
      return res.status(401).json({ 
        error: validation.error || 'Invalid Reverb token' 
      });
    }

    Object.assign(user, {
      reverbToken: token,
      reverbDemo: false,
      reverbExtension: false,
      reverbAccount: validation.account,
      reverbUserId: validation.userId,
      reverbShopId: validation.shopId,
      reverbTokenExpires: null,
      reverbRefreshToken: null,
    });
    userStore.saveUser(user);

    recordActivity('success', `Connected Reverb account: ${validation.account}`, {
      source: 'server',
      platform: 'reverb',
    });

    return res.json({
      connected: true,
      mode: 'live',
      account: validation.account,
    });
  } catch (error) {
    logError('Reverb connect', error, { req });
    return res.status(500).json({ 
      error: 'Failed to connect Reverb account' 
    });
  }
});

function reverbPhotoUrl(photo) {
  return (
    photo?._links?.large_crop?.href ||
    photo?._links?.full?.href ||
    photo?._links?.large?.href ||
    photo?.url ||
    ''
  );
}

function mapReverbListing(listing) {
  const listingId = listing.id || listing.listing_id;
  const images = (listing.photos || []).map(reverbPhotoUrl).filter(Boolean);
  const slug = String(listing.state?.slug || listing.state || '').toLowerCase();
  const status = slug === 'live' || slug === 'published' || slug === 'active' ? 'active' : slug || 'active';
  return {
    title: listing.title || 'Untitled Item',
    description: listing.description || '',
    price: parseListingPrice(listing.price),
    quantity: listing.inventory || listing.quantity || 1,
    images,
    platform: 'reverb',
    platformListingId: String(listingId || ''),
    status,
    url: listing._links?.web?.href || listing.url || `https://reverb.com/item/${listingId}`,
  };
}

async function fetchLiveReverbCandidates(user) {
  if (!user.reverbToken || user.reverbDemo || user.reverbExtension) return [];
  const listings = [];
  let url = 'https://api.reverb.com/api/my/listings';
  let params = { per_page: 50, state: 'all' };
  for (let page = 0; page < 5 && url; page += 1) {
    const response = await axios.get(url, {
      headers: reverbApiHeaders(user.reverbToken),
      params,
    });
    const batch = response.data.listings || response.data.results || [];
    listings.push(...batch.map(mapReverbListing).filter((item) => item.platformListingId));
    url = response.data._links?.next?.href || '';
    params = undefined;
  }
  return listings;
}

// ======================
// LISTING ENDPOINTS
// ======================

// Get user's listings from eBay
app.get('/api/listings/ebay', async (req, res) => {
  try {
    const userData = getDemoUser();
    
    if (!userData || !userData.ebayToken) {
      return res.status(401).json({ error: 'Not authenticated with eBay' });
    }

    if (userData.ebayDemo) {
      const demoListings = seedDemoEbayListings();
      return res.json(demoListings);
    }

    if (userData.ebayExtension) {
      const extensionListings = Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'ebay'));
      return res.json(extensionListings);
    }
    
    // Fetch active listings from eBay Inventory + Offer APIs
    const ebayListings = (await fetchLiveEbayCandidates(userData)).map((item) =>
      upsertImportedListing(item)
    );

    res.json(ebayListings);
  } catch (error) {
    logError('eBay listings fetch', error, { req });
    res.status(500).json({ error: 'Failed to fetch eBay listings' });
  }
});

// Get user's listings from Facebook Marketplace
app.get('/api/listings/facebook', (_req, res) => {
  return res.status(400).json({ error: disabledStoreMessage('facebook') });
});

app.get('/api/listings/depop', (_req, res) => {
  const userData = getDemoUser();
  if (!userData.depopToken) {
    return res.status(401).json({ error: 'Not authenticated with Depop' });
  }
  const depopListings = Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'depop'));
  return res.json(depopListings);
});

app.get('/api/listings/poshmark', (_req, res) => {
  const userData = getDemoUser();
  if (!userData.poshmarkToken) {
    return res.status(401).json({ error: 'Not authenticated with Poshmark' });
  }
  return res.json(Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'poshmark')));
});

app.get('/api/listings/etsy', async (_req, res) => {
  const userData = getDemoUser();
  if (!userData.etsyToken) {
    return res.status(401).json({ error: 'Not authenticated with Etsy' });
  }
  if (userData.etsyDemo) {
    return res.json(buildEtsyMarketplaceCandidates(new Date().toISOString()));
  }
  if (userData.etsyExtension) {
    return res.json(Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'etsy')));
  }
  try {
    const candidates = await fetchLiveEtsyCandidates(userData);
    return res.json(candidates);
  } catch (error) {
    logError('Etsy listings fetch', error, { req });
    return res.json(Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'etsy')));
  }
});

app.get('/api/listings/reverb', async (_req, res) => {
  const userData = getDemoUser();
  if (!userData.reverbToken) {
    return res.status(401).json({ error: 'Not authenticated with Reverb' });
  }
  if (userData.reverbDemo) {
    return res.json(buildReverbMarketplaceCandidates(new Date().toISOString()));
  }
  if (userData.reverbExtension) {
    return res.json(Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'reverb')));
  }
  try {
    const candidates = await fetchLiveReverbCandidates(userData);
    return res.json(candidates);
  } catch (error) {
    logError('Reverb listings fetch', error, { req });
    return res.json(Array.from(listings.values()).filter((l) => listingHasPlatform(l, 'reverb')));
  }
});

app.get('/api/listings/import/candidates', async (req, res) => {
  const platform = String(req.query.platform || '');
  if (!isStoreEnabled(platform)) {
    return res.status(400).json({ error: DISABLED_PLATFORMS.has(platform) ? disabledStoreMessage(platform) : 'Invalid platform' });
  }

  const user = getDemoUser();
  const mode = getConnectionMode(user, platform);

  if (!isRealConnectionMode(mode)) {
    return res.json({
      platform,
      connected: false,
      mode: 'none',
      candidates: [],
    });
  }

  let candidates = [];
  let source = mode;

  if (mode === 'live' && platform === 'ebay' && user.ebayToken) {
    try {
      candidates = await fetchLiveEbayCandidates(user);
      source = 'live';
    } catch (error) {
      logError('eBay import preview', error, { req });
      return res.status(500).json({ error: 'Failed to fetch eBay listings' });
    }
  } else if (mode === 'live' && platform === 'facebook' && user.facebookToken) {
    try {
      candidates = await fetchLiveFacebookCandidates(user);
      source = 'live';
    } catch (error) {
      logError('Facebook import preview', error, { req });
      return res.status(500).json({ error: 'Failed to fetch Facebook listings' });
    }
  } else if (mode === 'live' && platform === 'etsy' && user.etsyToken) {
    try {
      candidates = await fetchLiveEtsyCandidates(user);
      source = 'live';
    } catch (error) {
      logError('Etsy import preview', error, { req });
      return res.status(500).json({ error: 'Failed to fetch Etsy listings' });
    }
  } else if (mode === 'live' && platform === 'reverb' && user.reverbToken) {
    try {
      candidates = await fetchLiveReverbCandidates(user);
      source = 'live';
    } catch (error) {
      logError('Reverb import preview', error, { req });
      return res.status(500).json({ error: 'Failed to fetch Reverb listings' });
    }
  }

  return res.json({
    platform,
    connected: true,
    mode: source,
    candidates: annotateImportCandidates(candidates, platform),
  });
});

app.post('/api/listings/import', async (req, res) => {
  const { platform, listings: incoming = [], mode, account } = req.body || {};
  if (!isStoreEnabled(platform)) {
    return res.status(400).json({ error: DISABLED_PLATFORMS.has(platform) ? disabledStoreMessage(platform) : 'Invalid platform' });
  }
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return res.status(400).json({ error: 'Select at least one listing to import' });
  }

  let connectionMode;
  try {
    connectionMode = ensureConnectedForImport(platform, { mode, account });
  } catch (error) {
    logError('Import connection check', error, { req });
    return res.status(error.status || 400).json({ error: error.message });
  }
  const created = [];
  const merged = [];
  const skipped = [];

  incoming.forEach((raw) => {
    const listing = { ...raw, platform: raw.platform || platform };
    if (isPlaceholderImportListing(listing)) {
      skipped.push({
        title: listing.title,
        reason: 'placeholder listing',
      });
      return;
    }
    const existing = findExistingListing(listing);
    const incomingPrice = parseListingPrice(listing.price);
    const shouldRefresh =
      existing &&
      listingHasPlatform(existing, platform) &&
      ((incomingPrice > 0 && incomingPrice !== parseListingPrice(existing.price)) ||
        (realListingImages(listing.images).length && !realListingImages(existing.images).length) ||
        (listing.description && !existing.description) ||
        (listing.title && listing.title !== existing.title && incomingPrice > 0));
    if (existing && listingHasPlatform(existing, platform) && !shouldRefresh) {
      skipped.push({
        id: existing.id,
        title: existing.title,
        reason: 'already imported',
      });
      return;
    }
    const result = upsertImportedListing(listing);
    if (existing) merged.push(result);
    else created.push(result);
  });

  const saved = [...created, ...merged];
  mergeObviousDuplicateListings();
  cleanStoredListingTitles();
  await hydrateMissingListingImages(saved.map((listing) => listings.get(listing.id) || listing));

  return res.json({
    platform,
    mode: connectionMode,
    imported: created.length + merged.length,
    created: created.length,
    merged: merged.length,
    skipped: skipped.length,
    listings: saved.map((listing) => toUnifiedListing(listings.get(listing.id) || listing)),
    skippedListings: skipped,
    imageMatches: findImageMatchGroups(),
  });
});

// Get all listings (combined)
app.get('/api/listings', async (_req, res) => {
  try {
    const userData = getDemoUser();
    if (userData.ebayToken) {
      if (userData.ebayDemo && listings.size === 0) seedDemoEbayListings();
      else if (userData.ebayExtension) {
        // Listings already imported from extension scrape.
      } else {
        try {
          (await fetchLiveEbayCandidates(userData)).forEach((item) => {
            upsertImportedListing(item);
          });
        } catch (error) {
          logError('Live eBay sync', error, { req });
        }
      }
    }
    if (userData.facebookToken) {
      if (userData.facebookDemo && listings.size === 0) seedDemoFacebookListings();
      else if (userData.facebookExtension) {
        // Listings already imported from extension scrape.
      }
    }
    mergeObviousDuplicateListings();
    cleanStoredListingTitles();
    await hydrateMissingListingImages();
    res.json(Array.from(listings.values()).map(toUnifiedListing));
  } catch (error) {
    logError('Combined listings fetch', error, { req });
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

app.get('/api/listings/image-matches', (req, res) => {
  getDemoUser();
  mergeObviousDuplicateListings();
  cleanStoredListingTitles();
  return res.json({
    groups: findImageMatchGroups(),
    dismissedPairKeys: userStore.listImageMatchDismissals(getCurrentUser()?.id),
  });
});

app.post('/api/listings/image-matches/resolve', (req, res) => {
  try {
    const user = getDemoUser();
    const { primaryId, matchIds = [], decision } = req.body || {};
    if (decision !== 'merge' && decision !== 'dismiss') {
      return res.status(400).json({ error: 'Decision must be merge or dismiss' });
    }

    const groupIds = [primaryId, ...matchIds].filter(Boolean);
    if (groupIds.length < 2) {
      return res.status(400).json({ error: 'Select at least two listings' });
    }

    if (decision === 'dismiss') {
      const pairKeys = [];
      for (let i = 0; i < groupIds.length; i += 1) {
        for (let j = i + 1; j < groupIds.length; j += 1) {
          pairKeys.push(userStore.imageMatchPairKey(groupIds[i], groupIds[j]));
        }
      }
      userStore.dismissImageMatchPairs(user.id, pairKeys);
      return res.json({
        decision: 'dismiss',
        groups: findImageMatchGroups(),
      });
    }

    const primary = listings.get(primaryId);
    if (!primary) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const result = mergeInventoryListings(primaryId, matchIds);
    return res.json({
      decision: 'merge',
      listing: toUnifiedListing(result.listing),
      mergedIds: result.mergedIds,
      groups: findImageMatchGroups(),
    });
  } catch (error) {
    logError('Image match resolve', error, { req });
    return res.status(error.status || 500).json({ error: error.message || 'Failed to save match decision' });
  }
});

async function applyListingUpdates(listing, updates, userData) {
  const { platforms: platformUpdates, images: imageUpdates, ...safeUpdates } = updates || {};
  if ('category' in safeUpdates) safeUpdates.category = cleanCategory(safeUpdates.category);
  if ('details' in safeUpdates) safeUpdates.details = cleanDetails(safeUpdates.details);
  let nextPlatforms = platformUpdates
    ? { ...getPlatforms(listing), ...platformUpdates }
    : getPlatforms(listing);
  if (safeUpdates.price !== undefined) {
    const nextPrice = parseListingPrice(safeUpdates.price);
    nextPlatforms = Object.fromEntries(
      Object.entries(nextPlatforms).map(([platform, entry]) => [
        platform,
        { ...entry, price: nextPrice },
      ])
    );
  }
  let updatedListing = toUnifiedListing({
    ...listing,
    ...safeUpdates,
    platforms: nextPlatforms,
    lastUpdated: new Date().toISOString(),
  });
  if (imageUpdates !== undefined) {
    const imageList = await persistListingImages(userData.id, imageUpdates);
    updatedListing = applyListingImages(updatedListing, imageList);
  }
  listings.set(listing.id, updatedListing);

  const platforms = getPlatforms(updatedListing);
  if (safeUpdates.price !== undefined) {
    await pushLiveMarketplacePrice(updatedListing, platforms, userData);
  }

  return updatedListing;
}

function isLiveMarketplaceId(id) {
  const value = String(id || '');
  return Boolean(value) && !/^(demo_|local_|item_)/i.test(value);
}

async function pushLiveMarketplacePrice(listing, platforms, userData) {
  const ebayId = platforms.ebay?.listingId;
  if (
    isLiveMarketplaceId(ebayId) &&
    userData.ebayToken &&
    !userData.ebayDemo &&
    !userData.ebayExtension
  ) {
    try {
      await updateEbayListing(ebayId, listing, userData.ebayToken);
    } catch (error) {
      logError('eBay price push', error);
    }
  }

  const etsyId = platforms.etsy?.listingId;
  if (
    isLiveMarketplaceId(etsyId) &&
    userData.etsyToken &&
    !userData.etsyDemo &&
    !userData.etsyExtension
  ) {
    try {
      await updateEtsyListingPrice(etsyId, listing.price, userData);
    } catch (error) {
      logError('Etsy price push', error);
    }
  }
}

app.post(
  '/api/uploads',
  express.raw({ type: () => true, limit: '10mb' }),
  async (req, res) => {
    const user = getDemoUser();
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) {
      return res.status(400).json({ error: 'Image file is required' });
    }
    if (body.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image must be 10MB or smaller' });
    }
    const mime = String(req.headers['content-type'] || 'application/octet-stream');
    if (mime.startsWith('application/json')) {
      return res.status(400).json({ error: 'Send the image as a file, not JSON' });
    }
    let filename = 'photo.jpg';
    try {
      filename = decodeURIComponent(String(req.headers['x-filename'] || 'photo.jpg'));
    } catch {
      filename = 'photo.jpg';
    }
    try {
      const stored = await toStoredImage(body, mime, filename);
      const owner = safeUserId(user.id);
      const dir = path.join(UPLOADS_DIR, owner);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${uuidv4()}.${stored.ext}`;
      fs.writeFileSync(path.join(dir, name), stored.buffer);
      const url = `/uploads/${owner}/${name}`;
      return res.status(201).json({ url, filename: name });
    } catch {
      return res.status(400).json({ error: "Couldn't read that photo. Export it as JPEG and try again." });
    }
  }
);

// Photos-only auto-list pipeline: upload photos -> identify + market price ->
// ONE confirmation screen -> auto-distribute to eBay / Facebook / Grailed.
app.post('/api/auto-list/start', async (req, res) => {
  try {
    const user = getDemoUser();
    const photos = Array.isArray(req.body?.photos) ? req.body.photos : [];
    const result = await autoList.startAutoList(photos, { user, baseUrl: requestOrigin(req) });
    return res.status(201).json(result);
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not start auto-list' });
  }
});

app.post('/api/auto-list/:jobId/confirm', async (req, res) => {
  try {
    const user = getDemoUser();
    // eBay distributor auth: refreshed user token, injected per the ebay-auto contract.
    const ebayAuth = {
      getToken: () => ensureFreshEbayToken(user),
      apiBase: getEbayApiBase(),
    };
    const result = await autoList.confirmAutoList(req.params.jobId, req.body || {}, {
      user,
      baseUrl: requestOrigin(req),
      ebayAuth,
    });
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not list everywhere' });
  }
});

app.get('/api/auto-list/:jobId/status', async (req, res) => {
  try {
    const user = getDemoUser();
    const result = autoList.getAutoListStatus(req.params.jobId, { user, baseUrl: requestOrigin(req) });
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Could not load auto-list status' });
  }
});

const LISTING_CATEGORIES = new Set(['clothing', 'furniture', 'home', 'tech', 'tickets', 'music', 'other']);

function cleanCategory(value) {
  const category = String(value || '').toLowerCase();
  return LISTING_CATEGORIES.has(category) ? category : 'other';
}

// Free-form "details" (brand, model, seats, ...): a few short text values, nothing nested.
function cleanDetails(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value).slice(0, 12)) {
    if (!/^[a-z][a-z0-9_]{0,29}$/i.test(key)) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const text = String(raw).trim().slice(0, 200);
    if (text) out[key] = text;
  }
  return out;
}

app.post('/api/listings', async (req, res) => {
  const { title, description, price, quantity, images, platforms: requestedPlatforms, sku, condition, category, details } = req.body || {};
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const userData = getDemoUser();
  const parsedPrice = parseListingPrice(price);
  const imageList = await persistListingImages(userData.id, images || []);
  const stores = requestedPushPlatforms(userData, requestedPlatforms);
  const targetStores = stores.length ? stores : IMPORT_PLATFORMS.filter(isStoreEnabled).map((id) => ({ id, mode: 'none' }));
  const platforms = {};
  for (const store of targetStores) {
    platforms[store.id] = pendingPlatformEntry(
      { price: parsedPrice, images: imageList },
      store.id,
      { status: 'pending' }
    );
  }

  const item = toUnifiedListing({
    id: `item_${uuidv4()}`,
    title: String(title).trim(),
    description: description || '',
    price: parsedPrice,
    quantity: quantity === undefined || quantity === '' ? 1 : parseInt(quantity, 10) || 0,
    images: imageList,
    sku: sku ? String(sku).trim() : '',
    condition: condition || 'used_good',
    category: cleanCategory(category),
    details: cleanDetails(details),
    status: 'draft',
    platforms,
    lastUpdated: new Date().toISOString(),
  });
  listings.set(item.id, item);
  return res.status(201).json(item);
});

app.post('/api/listings/:id/push', async (req, res) => {
  try {
    const user = getDemoUser();
    const listing = listings.get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const platforms = requestedPushPlatforms(user, req.body?.platforms);
    if (!platforms.length) {
      return res.status(400).json({
        error: 'Connect at least one marketplace before listing this item',
      });
    }

    const pushed = await pushListingToStores(listing, user, platforms);
    recordActivity('success', `Pushed "${listing.title}" to ${platforms.map((store) => store.id).join(', ')}`, {
      source: 'server',
      listingId: listing.id,
      results: pushed.results,
    });
    return res.json({
      listing: pushed.listing,
      results: pushed.results,
      extensionTasks: pushed.extensionTasks,
    });
  } catch (error) {
    logError('Push listing', error, { req });
    return res.status(error.status || 500).json({ error: error.message || 'Failed to list item' });
  }
});

app.post('/api/listings/:id/listed', (req, res) => {
  const listing = listings.get(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });

  const source = req.body?.source || 'extension';
  const incoming = Array.isArray(req.body?.results) ? req.body.results : [req.body];
  req.body = { source, results: incoming.map(slimListingResult) };
  let next = toUnifiedListing(listing);
  for (const result of incoming) {
    const platform = String(result?.platform || '').toLowerCase();
    if (!IMPORT_PLATFORMS.includes(platform)) continue;
    next = applyPlatformResult(next, platform, result);
    if (!isListingFailure(result)) continue;
    const failure = result.failure && typeof result.failure === 'object' ? result.failure : {};
    recordListingFailure({
      ...failure,
      listingId: failure.listingId || next.id,
      title: failure.title || next.title,
      platform,
      error: failure.error || result.error,
      step: failure.step || result.detail?.step || null,
      status: failure.status ?? result.detail?.status,
      source: failure.source || result.detail?.source || source,
    }, req);
  }
  listings.set(next.id, next);
  recordActivity('info', `Listing results saved for "${next.title}"`, {
    source,
    listingId: next.id,
    results: req.body.results,
  });
  return res.json({ listing: next });
});

app.post('/api/listing-failures', (req, res) => {
  const incoming = Array.isArray(req.body?.failures) ? req.body.failures.slice(0, 20) : [];
  req.body = { count: incoming.length };
  const saved = [];
  const dropped = [];
  for (const raw of incoming) {
    const outcome = recordListingFailure(raw, req);
    if (outcome.id) saved.push(outcome.id);
    else if (outcome.dropped) dropped.push(outcome.dropped);
  }
  return res.json({ saved, dropped });
});

app.patch('/api/listings/bulk', async (req, res) => {
  try {
    const { ids, updates } = req.body;
    const userData = getDemoUser();
    const results = [];

    for (const id of ids || []) {
      try {
        const listing = listings.get(id);
        if (!listing) {
          results.push({ id, success: false, error: 'Listing not found' });
          continue;
        }
        const updatedListing = await applyListingUpdates(listing, updates, userData);
        results.push({ id, success: true, listing: updatedListing });
      } catch (error) {
        logError('Bulk listing update', error, { req, detail: { listingId: id } });
        results.push({ id, success: false, error: error.message });
      }
    }

    res.json({
      results,
    });
  } catch (error) {
    logError('Bulk update', error, { req });
    res.status(500).json({ error: 'Failed to perform bulk update' });
  }
});

app.post('/api/listings/adjust-prices', async (req, res) => {
  const percent = Number(req.body?.percent ?? -10);
  if (Number.isNaN(percent) || percent <= -100) {
    return res.status(400).json({ error: 'Invalid percent value' });
  }

  const requestedIds = Array.isArray(req.body?.ids) ? req.body.ids : null;
  const multiplier = 1 + percent / 100;
  const updated = [];
  const userData = getDemoUser();

  for (const listing of listings.values()) {
    if (requestedIds && !requestedIds.includes(listing.id)) continue;

    const oldPrice = Number(listing.price) || 0;
    const newPrice = Math.max(0.01, Math.round(oldPrice * multiplier * 100) / 100);
    const updatedListing = await applyListingUpdates(
      listing,
      { price: newPrice, previousPrice: oldPrice },
      userData
    );
    updated.push(updatedListing);
  }

  return res.json({
    percent,
    count: updated.length,
    listings: updated,
  });
});

app.patch('/api/listings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const userData = getDemoUser();

    const listing = listings.get(id);
    if (!listing) {
      return res.status(404).send('Listing not found');
    }

    const updatedListing = await applyListingUpdates(listing, updates, userData);
    res.json(updatedListing);
  } catch (error) {
    logError('Listing update', error, { req });
    res.status(500).json({ error: 'Failed to update listing' });
  }
});

// Helper function to update eBay listing
async function updateEbayListing(listingId, listingData, accessToken) {
  const ebayId = String(listingId || '').replace(/^ebay_/, '');
  if (!/^\d{9,13}$/.test(ebayId)) {
    throw new Error('Missing eBay item id');
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <InventoryStatus>
    <ItemID>${ebayId}</ItemID>
    <StartPrice>${Number(listingData.price).toFixed(2)}</StartPrice>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`;

  const response = await axios.post(`${getEbayApiBase()}/ws/api.dll`, xml, {
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-CALL-NAME': 'ReviseInventoryStatus',
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-IAF-TOKEN': accessToken,
    },
  });
  const text = typeof response.data === 'string' ? response.data : String(response.data || '');
  if (/<Ack>Failure<\/Ack>|<Ack>PartialFailure<\/Ack>/i.test(text)) {
    const msg = text.match(/<ShortMessage>([^<]+)<\/ShortMessage>/)?.[1] || 'eBay price revise failed';
    throw new Error(msg);
  }
}

async function updateEtsyListingPrice(listingId, price, userData) {
  const headers = etsyApiHeaders(userData.etsyToken);
  const inventory = await axios.get(
    `https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`,
    { headers }
  );
  const products = (inventory.data.products || []).map((product) => ({
    sku: product.sku,
    property_values: product.property_values || [],
    offerings: (product.offerings || []).map((offering) => ({
      price: Number(price),
      quantity: offering.quantity,
      is_enabled: offering.is_enabled !== false,
    })),
  }));
  await axios.put(
    `https://openapi.etsy.com/v3/application/listings/${listingId}/inventory`,
    {
      products,
      price_on_property: inventory.data.price_on_property || [],
      quantity_on_property: inventory.data.quantity_on_property || [],
      sku_on_property: inventory.data.sku_on_property || [],
    },
    { headers }
  );
}

// Helper function to update Facebook listing
async function updateFacebookListing(listingId, listingData, accessToken) {
  // Extract the actual Facebook ID from our ID format
  const fbId = listingId.replace('fb_', '');
  
  // Get user's pages to get page access token
  const pagesResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
    params: {
      access_token: accessToken
    }
  });
  
  if (!pagesResponse.data.data.length) {
    throw new Error('No Facebook pages found');
  }
  
  const pageAccessToken = pagesResponse.data.data[0].access_token;
  
  // Update the product (assuming it's in a product catalog)
  // Note: This requires the item to be in a Facebook product catalog
  // For a real implementation, you'd need to create/add to a catalog first
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${fbId}`, 
      {
        title: listingData.title || '',
        description: listingData.description || '',
        price: listingData.price || 0,
        quantity: listingData.quantity || 0,
        // Note: Image updates would require uploading new images first
        image_url: listingData.images?.[0] || '',
        availability: listingData.quantity > 0 ? 'in_stock' : 'out_of_stock',
        condition: 'NEW'
      },
      {
        params: {
          access_token: pageAccessToken
        }
      }
    );
  } catch (error) {
    // If direct product update fails (likely due to not being in a catalog),
    // we'll note that but not fail the entire operation
    logError('Facebook product update', error);
    // In a real app, you might need to handle this differently
  }
}

// Create a new listing on eBay
app.post('/api/listings/ebay', async (req, res) => {
  try {
    const { title, description, price, quantity, images } = req.body;
    const userData = getDemoUser();
    
    if (!userData || !userData.ebayToken) {
      return res.status(401).send('Not authenticated with eBay');
    }
    
    // Create inventory item
    const sku = `crosslist_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const inventoryResponse = await axios.post(`${getEbayApiBase()}/sell/inventory/v1/inventory_item/${sku}`,
      {
        availability: {
          shipToLocationAvailability: {
            quantity: quantity || 0
          }
        },
        product: {
          title: title || '',
          description: description || '',
          imageUrls: images || []
        }
      },
      {
        headers: {
          Authorization: `Bearer ${userData.ebayToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Create offer
    const offerResponse = await axios.post(`${getEbayApiBase()}/sell/inventory/v1/offer`,
      {
        sku: sku,
        marketplaceId: 'EBAY_US',
        format: 'FIXED_PRICE',
        availableQuantity: quantity || 0,
        pricingSummary: {
          price: {
            value: price?.toString() || '0',
            currency: 'USD'
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${userData.ebayToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const listingId = `ebay_${sku}`;
    const newListing = {
      id: listingId,
      title,
      description,
      price: parseFloat(price || 0),
      quantity: quantity || 0,
      images: images || [],
      platform: 'ebay',
      platformListingId: sku,
      status: 'active',
      lastUpdated: new Date().toISOString()
    };
    
    listings.set(listingId, newListing);
    
    res.status(201).json(newListing);
  } catch (error) {
    logError('Create eBay listing', error, { req });
    res.status(500).json({ error: 'Failed to create eBay listing' });
  }
});

// Create a new listing on Facebook (simplified - creates a product in catalog)
app.post('/api/listings/facebook', (_req, res) => {
  return res.status(400).json({ error: disabledStoreMessage('facebook') });
});

async function endReverbListing(token, listingId) {
  const id = String(listingId).replace(/^reverb_/, '');
  try {
    await axios.put(
      `https://api.reverb.com/api/listings/${encodeURIComponent(id)}`,
      { state: { slug: 'ended' } },
      {
        headers: reverbApiHeaders(token),
        timeout: 15000,
      }
    );
  } catch (error) {
    if (error.response?.status === 404) {
      return;
    }
    throw error;
  }
}

async function endEbayListing(token, listingId) {
  const id = String(listingId).replace(/^ebay_/, '');
  try {
    await axios.post(
      `${getEbayApiBase()}/sell/inventory/v1/offer/${encodeURIComponent(id)}/withdraw`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
  } catch (error) {
    if (error.response?.status === 404) {
      return;
    }
    logError('eBay end listing API', error);
  }
}

// Delete a listing
app.delete('/api/listings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = getDemoUser();
    const listing = listings.get(id);
    
    if (!listing) {
      return res.status(404).send('Listing not found');
    }
    
    const platforms = getPlatforms(listing);
    const deletionResults = [];

    // End/delete from connected platforms
    if (platforms.reverb?.listingId && user.reverbToken) {
      try {
        await endReverbListing(user.reverbToken, platforms.reverb.listingId);
        deletionResults.push({ platform: 'reverb', success: true });
      } catch (error) {
        logError('End Reverb listing', error);
        deletionResults.push({ 
          platform: 'reverb', 
          success: false, 
          error: error.message 
        });
      }
    }

    if (platforms.ebay?.listingId && user.ebayToken) {
      try {
        await endEbayListing(user.ebayToken, platforms.ebay.listingId);
        deletionResults.push({ platform: 'ebay', success: true });
      } catch (error) {
        logError('End eBay listing', error);
        deletionResults.push({ 
          platform: 'ebay', 
          success: false, 
          error: error.message 
        });
      }
    }
    
    // Remove from our storage
    listings.delete(id);
    
    recordActivity('info', `Deleted listing: ${listing.title}`, {
      source: 'server',
      listingId: id,
      platformDeletions: deletionResults,
    });
    
    res.json({ 
      success: true, 
      message: 'Listing removed',
      platformDeletions: deletionResults,
    });
  } catch (error) {
    logError('Delete listing', error, { req });
    res.status(500).json({ error: 'Failed to delete listing' });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.status === 401) {
    return res.status(401).json({ error: error.message || 'Sign in required' });
  }
  logError('Unhandled request error', error, { req });
  return res.status(500).json({ error: 'Unexpected server error' });
});

export default app;

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
      open(`http://localhost:${PORT}/dashboard.html`).catch((error) => {
        logError('Open browser', error);
      });
    }
  });

  process.on('SIGINT', () => {
    console.log('Shutting down server...');
    try {
      persistStore();
      userStore.db.close();
    } catch (error) {
      logError('Persist session on shutdown', error);
    }
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}