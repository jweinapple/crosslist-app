// server/inventory.js
//
// Listing normalization, import/merge, image hydration, and marketplace
// candidate builders — extracted verbatim from server.js (2026-10-02) to keep
// the main server file focused on routing + marketplace integrations.
// Bodies are unchanged; only module wiring was added.
//
// Shared server state (logError, getCurrentUser, listings) is injected once
// via initInventory() because this module cannot import server.js (cycle).

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import * as userStore from './db.js';

let logError = (...args) => {};
let getCurrentUser = () => null;
let listings = new Map();

export function initInventory(deps = {}) {
  if (typeof deps.logError === 'function') logError = deps.logError;
  if (typeof deps.getCurrentUser === 'function') getCurrentUser = deps.getCurrentUser;
  if (deps.listings) listings = deps.listings;
}

const TITLE_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'with',
  'from',
  'this',
  'that',
  'very',
  'gently',
  'official',
  'officially',
  'licensed',
  'merch',
  'show',
  'used',
  'new',
  'nwt',
  'nwot',
  'size',
  'sz',
  'mens',
  'men',
  'womens',
  'women',
  'man',
  'woman',
  'unisex',
  'in',
  'on',
  'of',
  'to',
  'by',
  'at',
  'as',
  'is',
  'it',
  'its',
  'into',
  'condition',
  'good',
  'great',
  'excellent',
  'perfect',
  'like',
  'please',
  'read',
  'description',
  'shipping',
  'free',
  'album',
  'panel',
  'mint',
  'heavily',
  'worn',
]);
const TITLE_SIZE_WORDS = new Set([
  'xs',
  's',
  'm',
  'l',
  'xl',
  'xxl',
  'xxxl',
  '2xl',
  '3xl',
  'small',
  'medium',
  'large',
]);

function stripTitleJunk(title) {
  return String(title || '')
    .replace(/\boffer expired\b/gi, ' ')
    .replace(/\bnew notification\b/gi, ' ')
    .replace(/notification.*$/gi, ' ')
    .replace(/\breach more buyers\b/gi, ' ')
    .replace(/\bbuy it now\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collapseRepeatedTitle(title) {
  const text = stripTitleJunk(String(title || '').replace(/\s+/g, ' '));
  if (text.length < 24) return text;
  const lower = text.toLowerCase();
  const start = lower.slice(0, Math.min(24, Math.floor(text.length / 2)));
  let idx = lower.indexOf(start, 12);
  while (idx !== -1) {
    const left = text.slice(0, idx).replace(/[\s\-|:–—]+$/g, '');
    const right = text.slice(idx);
    const leftN = left.toLowerCase();
    const rightN = right.toLowerCase();
    let same = 0;
    const check = Math.min(leftN.length, rightN.length);
    while (same < check && leftN[same] === rightN[same]) same += 1;
    if (left.length >= 16 && same >= Math.min(16, Math.floor(leftN.length * 0.6))) {
      return left.trim();
    }
    idx = lower.indexOf(start, idx + 1);
  }
  return text;
}

function cleanedListingTitle(title) {
  return collapseRepeatedTitle(title);
}

function normalizeTitle(title) {
  return collapseRepeatedTitle(title)
    .toLowerCase()
    .replace(/&/g, '')
    .replace(/\bgrey\b/g, 'gray')
    .replace(/\bcolour\b/g, 'color')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(title) {
  const tokens = new Set();
  for (const token of normalizeTitle(title).split(' ')) {
    if (!token || token.length < 2) continue;
    if (TITLE_STOPWORDS.has(token) || TITLE_SIZE_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function titleSimilarity(a, b) {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (!left.size || !right.size) return { shared: 0, jaccard: 0, containment: 0 };
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return {
    shared,
    jaccard: shared / (left.size + right.size - shared),
    containment: shared / Math.min(left.size, right.size),
  };
}

function titlesAreSameProduct(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (left && left === right) return true;
  const { shared, jaccard, containment } = titleSimilarity(a, b);
  if (shared >= 5 && containment >= 0.7) return true;
  if (shared >= 4 && containment >= 0.7 && jaccard >= 0.45) return true;
  if (shared >= 6 && containment >= 0.5) return true;
  return false;
}

function titlesLookRelated(a, b) {
  if (titlesAreSameProduct(a, b)) return true;
  const { shared, jaccard, containment } = titleSimilarity(a, b);
  return shared >= 3 && (containment >= 0.42 || jaccard >= 0.24);
}

function decoratePlatformEntry(entry, listing) {
  const source = entry && typeof entry === 'object' ? entry : {};
  return {
    listingId: source.listingId || listing?.platformListingId || listing?.id || null,
    url: source.url || listing?.url || null,
    status: source.status || listing?.status || 'active',
    price: parseListingPrice(source.price) || parseListingPrice(listing?.price) || 0,
    images: realListingImages(
      Array.isArray(source.images) && source.images.length ? source.images : listing?.images || []
    ),
  };
}

function getPlatforms(listing) {
  if (listing?.platforms && typeof listing.platforms === 'object' && !Array.isArray(listing.platforms)) {
    const platforms = {};
    for (const [platform, entry] of Object.entries(listing.platforms)) {
      if (!entry) continue;
      platforms[platform] = decoratePlatformEntry(entry, listing);
    }
    return platforms;
  }
  const platforms = {};
  if (listing?.platform) {
    platforms[listing.platform] = decoratePlatformEntry(
      {
        listingId: listing.platformListingId || listing.id,
        url: listing.url || null,
        status: listing.status || 'active',
      },
      listing
    );
  }
  return platforms;
}

function listingHasPlatform(listing, platform) {
  return Boolean(getPlatforms(listing)[platform]);
}

function toUnifiedListing(listing) {
  const { platform, platformListingId, url, ...rest } = listing;
  return {
    ...rest,
    platforms: getPlatforms(listing),
    lastUpdated: listing.lastUpdated || new Date().toISOString(),
  };
}

function findExistingListing(incoming) {
  if (incoming?.id && listings.has(incoming.id)) {
    return listings.get(incoming.id);
  }

  const platform = incoming?.platform;
  const platformListingId = incoming?.platformListingId;
  if (platform && platformListingId) {
    for (const listing of listings.values()) {
      const entry = getPlatforms(listing)[platform];
      if (entry?.listingId && String(entry.listingId) === String(platformListingId)) {
        return listing;
      }
    }
  }

  const titleKey = normalizeTitle(incoming?.title);
  if (titleKey) {
    for (const listing of listings.values()) {
      if (normalizeTitle(listing.title) === titleKey) return listing;
    }
  }

  let best = null;
  let bestScore = 0;
  for (const listing of listings.values()) {
    if (platform && listingHasPlatform(listing, platform)) continue;
    if (!titlesAreSameProduct(incoming?.title, listing.title)) continue;
    const { shared, jaccard, containment } = titleSimilarity(incoming?.title, listing.title);
    const score = shared * 2 + containment + jaccard;
    if (score > bestScore) {
      best = listing;
      bestScore = score;
    }
  }
  return best;
}

const IMAGE_QUERY_DROP = new Set([
  'w',
  'h',
  'width',
  'height',
  'fit',
  'crop',
  'q',
  'quality',
  'size',
  'format',
  'fm',
  'auto',
  'dpr',
  'usm',
  'cs',
  'v',
  'cache',
  't',
  'timestamp',
  '_',
]);

function normalizeImageUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    parsed.pathname = parsed.pathname
      .replace(/\/s-l\d+\.(jpe?g|png|webp|gif)$/i, '/s-l.$1')
      .replace(/[_-](\d+x\d+|large|medium|small|thumb)\b/gi, '');
    const kept = [];
    parsed.searchParams.forEach((value, key) => {
      if (!IMAGE_QUERY_DROP.has(key.toLowerCase())) kept.push([key, value]);
    });
    kept.sort(([a], [b]) => a.localeCompare(b));
    parsed.search = '';
    for (const [key, value] of kept) parsed.searchParams.append(key, value);
    return parsed.toString();
  } catch {
    return raw.split('#')[0].toLowerCase();
  }
}

function isRealListingImage(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  if (value.startsWith('/uploads/')) return true;
  if (value.startsWith('data:image/')) return true;
  if (!/^https?:\/\//i.test(value)) return false;
  return !/placehold\.co|via\.placeholder|placeholder\.com|dummyimage/i.test(value);
}

function realListingImages(list) {
  return [...new Set((list || []).map((image) => String(image || '').trim()).filter(isRealListingImage))];
}

function extractOgImage(html) {
  const text = String(html || '');
  const patterns = [
    /property=["']og:image["'][^>]*content=["']([^"']+)/i,
    /content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
    /["']og:image["']\s*content=["']([^"']+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && isRealListingImage(match[1])) return match[1];
  }
  return '';
}

async function fetchHtml(url) {
  const cookieJar = [];
  let current = url;
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await axios.get(current, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: cookieJar.join('; '),
      },
      timeout: 10000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      responseType: 'text',
    });
    for (const cookie of response.headers['set-cookie'] || []) {
      const pair = String(cookie).split(';')[0];
      if (pair) cookieJar.push(pair);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      current = new URL(response.headers.location, current).toString();
      continue;
    }
    return String(response.data || '');
  }
  return '';
}

function ebayItemIdFromListing(listing) {
  const entry = getPlatforms(listing).ebay;
  const id = String(entry?.listingId || '');
  return /^\d{9,13}$/.test(id) ? id : '';
}

async function fetchListingThumbnail(listing) {
  const ebayId = ebayItemIdFromListing(listing);
  if (ebayId) {
    const image = extractOgImage(await fetchHtml(`https://m.ebay.com/itm/${ebayId}`));
    if (image) return image;
  }
  for (const platform of ['depop', 'poshmark', 'etsy', 'reverb', 'facebook']) {
    const url = getPlatforms(listing)[platform]?.url;
    if (!url) continue;
    try {
      const image = extractOgImage(await fetchHtml(url));
      if (image) return image;
    } catch (error) {
      logError('Listing thumbnail fetch', error, { detail: { url, listingId: listing?.id } });
    }
  }
  return '';
}

function listingNeedsImageHydration(listing) {
  if (realListingImages(listing?.images).length) return false;
  const attempted = Date.parse(listing?.imageHydrationAttemptedAt || '') || 0;
  return Date.now() - attempted > 6 * 60 * 60 * 1000;
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

function applyListingImages(listing, images) {
  const nextImages = realListingImages(images);
  if (!nextImages.length) return listing;
  const platforms = getPlatforms(listing);
  for (const [platform, entry] of Object.entries(platforms)) {
    const existing = realListingImages(entry.images);
    if (!existing.length) {
      platforms[platform] = { ...entry, images: nextImages };
      continue;
    }
    const used = new Set();
    const ordered = [];
    for (const image of nextImages) {
      const imageKey = normalizeImageUrl(image) || image;
      const match = existing.find((url) => {
        if (used.has(url)) return false;
        return url === image || (normalizeImageUrl(url) || url) === imageKey;
      });
      if (match) {
        ordered.push(match);
        used.add(match);
      }
    }
    for (const url of existing) {
      if (!used.has(url)) ordered.push(url);
    }
    platforms[platform] = { ...entry, images: ordered };
  }
  return {
    ...toUnifiedListing(listing),
    images: nextImages,
    platforms,
    lastUpdated: new Date().toISOString(),
  };
}

async function hydrateListingImages(listing) {
  if (!listingNeedsImageHydration(listing)) return listing;
  let image = '';
  try {
    image = await fetchListingThumbnail(listing);
  } catch (error) {
    logError('Listing image hydration', error, { detail: { listingId: listing?.id, title: listing?.title } });
  }
  const updated = {
    ...(image ? applyListingImages(listing, [image, ...(listing.images || [])]) : toUnifiedListing(listing)),
    imageHydrationAttemptedAt: new Date().toISOString(),
  };
  listings.set(updated.id, updated);
  return updated;
}

async function hydrateMissingListingImages(targets) {
  const pending = (targets || Array.from(listings.values())).filter(listingNeedsImageHydration);
  if (!pending.length) return [];
  return mapPool(pending, 4, hydrateListingImages);
}

function listingImageList(listing) {
  const images = [...(listing?.images || [])];
  for (const entry of Object.values(getPlatforms(listing))) {
    if (Array.isArray(entry?.images)) images.push(...entry.images);
  }
  return images;
}

function listingImageKeys(listing) {
  const keys = new Set();
  for (const image of listingImageList(listing)) {
    const url = String(image || '').trim();
    if (!url) continue;
    const normalized = normalizeImageUrl(url);
    if (normalized) keys.add(normalized);
    try {
      const parsed = new URL(url);
      const ebayId = parsed.pathname.match(/\/g\/([^/]+)\//i);
      if (ebayId?.[1]) keys.add(`ebayimg:${ebayId[1]}`);
    } catch {
      // Ignore malformed image URLs.
    }
  }
  keys.delete('');
  return keys;
}

function listingsShareImage(a, b) {
  const otherKeys = listingImageKeys(b);
  if (!otherKeys.size) return false;
  for (const key of listingImageKeys(a)) {
    if (otherKeys.has(key)) return true;
  }
  return false;
}

function listingPlatformKeys(listing) {
  return Object.keys(getPlatforms(listing)).filter(Boolean);
}

function platformsOverlap(a, b) {
  const other = new Set(listingPlatformKeys(b));
  return listingPlatformKeys(a).some((platform) => other.has(platform));
}

function summarizeMatchListing(listing) {
  const unified = toUnifiedListing(listing);
  const platforms = getPlatforms(unified);
  return {
    id: unified.id,
    title: unified.title,
    price: parseListingPrice(unified.price),
    images: unified.images || [],
    platforms,
    lastUpdated: unified.lastUpdated,
  };
}

function findImageMatchInInventory(incoming, platform) {
  const incomingKeys = listingImageKeys(incoming);
  let best = null;
  let bestScore = 0;
  for (const listing of listings.values()) {
    if (platform && listingHasPlatform(listing, platform)) continue;
    if (titlesAreSameProduct(incoming?.title, listing.title)) continue;
    const related = titlesLookRelated(incoming?.title, listing.title);
    const sharedImage = incomingKeys.size ? listingsShareImage(incoming, listing) : false;
    if (!related && !sharedImage) continue;
    const { shared, jaccard, containment } = titleSimilarity(incoming?.title, listing.title);
    const score = (sharedImage ? 4 : 0) + shared + containment + jaccard;
    if (score > bestScore) {
      best = listing;
      bestScore = score;
    }
  }
  return best;
}

async function findImageMatchGroups() {
  const items = Array.from(listings.values()).map((listing) => toUnifiedListing(listing));
  const dismissed = new Set(await userStore.listImageMatchDismissals(getCurrentUser()?.id));
  const parent = new Map(items.map((item) => [item.id, item.id]));

  function find(id) {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const left = items[i];
      const right = items[j];
      if (dismissed.has(userStore.imageMatchPairKey(left.id, right.id))) continue;
      if (platformsOverlap(left, right)) continue;
      if (!listingsShareImage(left, right) && !titlesLookRelated(left.title, right.title)) continue;
      union(left.id, right.id);
    }
  }

  const grouped = new Map();
  for (const item of items) {
    const root = find(item.id);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(item);
  }

  return [...grouped.values()]
    .map((members) => {
      if (members.length < 2) return null;
      const platformSet = new Set(members.flatMap(listingPlatformKeys));
      if (platformSet.size < 2) return null;
      members.sort((a, b) => String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || '')));
      return {
        id: members.map((item) => item.id).sort().join('::'),
        items: members.map(summarizeMatchListing),
      };
    })
    .filter(Boolean);
}

function mergeInventoryListings(primaryId, matchIds) {
  const primary = listings.get(primaryId);
  if (!primary) {
    const error = new Error('Listing not found');
    error.status = 404;
    throw error;
  }

  const platforms = {};
  for (const [platform, entry] of Object.entries(getPlatforms(primary))) {
    platforms[platform] = decoratePlatformEntry(entry, primary);
  }
  const images = [...listingImageList(primary)];
  const seenImages = new Set(images.map((image) => normalizeImageUrl(image)).filter(Boolean));
  const mergedIds = [];

  for (const id of matchIds || []) {
    if (!id || id === primaryId) continue;
    const other = listings.get(id);
    if (!other) continue;
    if (listingPlatformKeys(other).some((platform) => platforms[platform])) continue;
    const otherPlatforms = getPlatforms(other);
    for (const [platform, entry] of Object.entries(otherPlatforms)) {
      if (!platforms[platform]) platforms[platform] = decoratePlatformEntry(entry, other);
    }
    for (const image of listingImageList(other)) {
      const key = normalizeImageUrl(image);
      if (!image || (key && seenImages.has(key))) continue;
      if (key) seenImages.add(key);
      images.push(image);
    }
    listings.delete(id);
    mergedIds.push(id);
  }

  const updated = {
    ...toUnifiedListing(primary),
    title: cleanedListingTitle(primary.title) || primary.title,
    description: primary.description || '',
    platforms,
    images,
    lastUpdated: new Date().toISOString(),
  };
  listings.set(primary.id, updated);
  return { listing: updated, mergedIds };
}

function pickPrimaryListing(members) {
  return [...members].sort((a, b) => {
    const platformDiff = listingPlatformKeys(b).length - listingPlatformKeys(a).length;
    if (platformDiff) return platformDiff;
    const imageDiff = listingImageList(b).length - listingImageList(a).length;
    if (imageDiff) return imageDiff;
    const titleA = cleanedListingTitle(a.title);
    const titleB = cleanedListingTitle(b.title);
    if (titleA.length !== titleB.length) return titleA.length - titleB.length;
    return String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || ''));
  })[0];
}

function mergeObviousDuplicateListings() {
  const items = Array.from(listings.values()).map((listing) => toUnifiedListing(listing));
  const parent = new Map(items.map((item) => [item.id, item.id]));

  function find(id) {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const left = items[i];
      const right = items[j];
      if (platformsOverlap(left, right)) continue;
      if (!titlesAreSameProduct(left.title, right.title)) continue;
      union(left.id, right.id);
    }
  }

  const grouped = new Map();
  for (const item of items) {
    const root = find(item.id);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(item);
  }

  let mergedCount = 0;
  for (const members of grouped.values()) {
    if (members.length < 2) continue;
    const primary = pickPrimaryListing(members);
    const matchIds = members.map((item) => item.id).filter((id) => id !== primary.id);
    const result = mergeInventoryListings(primary.id, matchIds);
    mergedCount += result.mergedIds.length;
  }
  return mergedCount;
}

function cleanStoredListingTitles() {
  for (const listing of listings.values()) {
    const cleaned = cleanedListingTitle(listing.title);
    if (!cleaned || cleaned === listing.title) continue;
    listings.set(listing.id, {
      ...toUnifiedListing(listing),
      title: cleaned,
    });
  }
}

function upsertImportedListing(incoming) {
  if (!incoming) return null;
  const match = findExistingListing(incoming);

  if (match) {
    const platforms = getPlatforms(match);
    if (incoming.platform) {
      platforms[incoming.platform] = decoratePlatformEntry(
        {
          listingId: incoming.platformListingId || incoming.id,
          url: incoming.url || platforms[incoming.platform]?.url || null,
          status: incoming.status || 'active',
        },
        incoming
      );
    }
    const incomingTitle = cleanedListingTitle(incoming.title) || incoming.title;
    const matchTitle = cleanedListingTitle(match.title) || match.title;
    const preferredTitle =
      incomingTitle && matchTitle
        ? incomingTitle.length <= matchTitle.length
          ? incomingTitle
          : matchTitle
        : incomingTitle || matchTitle;
    const updated = {
      ...toUnifiedListing(match),
      title: preferredTitle,
      description: incoming.description || match.description || '',
      price: parseListingPrice(match.price) || parseListingPrice(incoming.price) || 0,
      quantity: incoming.quantity ?? match.quantity ?? 1,
      images: realListingImages([...(match.images || []), ...(incoming.images || [])]),
      platforms,
      lastUpdated: new Date().toISOString(),
    };
    listings.set(match.id, updated);
    return updated;
  }

  const created = {
    id: `item_${uuidv4()}`,
    title: cleanedListingTitle(incoming.title) || incoming.title || 'Untitled Item',
    description: incoming.description || '',
    price: parseListingPrice(incoming.price),
    quantity: incoming.quantity ?? 1,
    images: realListingImages(incoming.images),
    status: incoming.status || 'active',
    platforms: getPlatforms(incoming),
    lastUpdated: new Date().toISOString(),
  };
  listings.set(created.id, created);
  return created;
}

function seedDemoInventory() {
  const now = new Date().toISOString();
  const samples = [
    {
      id: 'item_demo_1',
      title: 'Vintage Nike Windbreaker (M)',
      description: 'Light wear, no stains.',
      price: 48,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Item+1'],
      status: 'active',
      sku: 'nike-windbreaker-m',
      platforms: {
        ebay: { listingId: 'demo_ebay_1', status: 'active', price: 48 },
        facebook: { listingId: 'demo_fb_1', status: 'active', price: 42 },
        depop: { listingId: 'demo_depop_1', status: 'active', price: 48 },
        poshmark: { listingId: 'demo_posh_1', status: 'active', price: 55 },
        etsy: { listingId: 'demo_etsy_1', status: 'active', price: 48 },
        reverb: { listingId: 'demo_reverb_1', status: 'active', price: 48 },
      },
      lastUpdated: now,
    },
    {
      id: 'item_demo_2',
      title: 'Carhartt Double Knee Pants 32x30',
      description: 'Great condition work pants.',
      price: 62.5,
      quantity: 2,
      images: ['https://placehold.co/300x200/png?text=Item+2'],
      status: 'active',
      sku: 'carhartt-dk-32x30',
      platforms: {
        ebay: { listingId: 'demo_ebay_2', status: 'active', price: 62.5 },
        facebook: { listingId: 'demo_fb_2', status: 'active', price: 62.5 },
        depop: { listingId: 'demo_depop_2', status: 'active', price: 62.5 },
      },
      lastUpdated: now,
    },
    {
      id: 'item_demo_3',
      title: 'Mid-Century Table Lamp',
      description: 'Works perfectly, local pickup preferred.',
      price: 35,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Item+3'],
      status: 'active',
      sku: 'mcm-table-lamp',
      platforms: {
        ebay: { listingId: 'demo_ebay_3', status: 'active', price: 35 },
        facebook: { listingId: 'demo_fb_3', status: 'active', price: 35 },
      },
      lastUpdated: now,
    },
  ];
  samples.forEach((listing) => {
    if (!listings.has(listing.id)) {
      listings.set(listing.id, listing);
    }
  });
  return samples.map((sample) => listings.get(sample.id));
}

function seedDemoEbayListings() {
  return seedDemoInventory();
}

function seedDemoFacebookListings() {
  return seedDemoInventory();
}

function buildMarketplaceCandidates(platform) {
  const now = new Date().toISOString();
  if (platform === 'depop') return buildDepopMarketplaceCandidates(now);
  if (platform === 'poshmark') return buildPoshmarkMarketplaceCandidates(now);
  if (platform === 'etsy') return buildEtsyMarketplaceCandidates(now);
  if (platform === 'reverb') return buildReverbMarketplaceCandidates(now);
  if (platform === 'ebay') {
    return [
      {
        title: 'Vintage Nike Windbreaker (M)',
        description: 'Light wear, no stains.',
        price: 48,
        quantity: 1,
        images: ['https://placehold.co/300x200/png?text=eBay+1'],
        platform: 'ebay',
        platformListingId: 'demo_ebay_1',
        status: 'active',
        url: 'https://www.ebay.com/itm/demo_ebay_1',
        lastUpdated: now,
      },
      {
        title: 'Carhartt Double Knee Pants 32x30',
        description: 'Great condition work pants.',
        price: 62.5,
        quantity: 2,
        images: ['https://placehold.co/300x200/png?text=eBay+2'],
        platform: 'ebay',
        platformListingId: 'demo_ebay_2',
        status: 'active',
        url: 'https://www.ebay.com/itm/demo_ebay_2',
        lastUpdated: now,
      },
      {
        title: 'Patagonia Better Sweater Fleece (L)',
        description: 'Soft fleece, no pilling.',
        price: 54,
        quantity: 1,
        images: ['https://placehold.co/300x200/png?text=eBay+3'],
        platform: 'ebay',
        platformListingId: 'demo_ebay_patagonia',
        status: 'active',
        url: 'https://www.ebay.com/itm/demo_ebay_patagonia',
        lastUpdated: now,
      },
      {
        title: "Levi's 501 Jeans 32x32",
        description: 'Classic fit, lightly worn.',
        price: 38,
        quantity: 1,
        images: ['https://placehold.co/300x200/png?text=eBay+4'],
        platform: 'ebay',
        platformListingId: 'demo_ebay_levis',
        status: 'active',
        url: 'https://www.ebay.com/itm/demo_ebay_levis',
        lastUpdated: now,
      },
      {
        title: 'Nike Bleach Dye Acid Wash Blue Swoosh Tee Size L',
        description: 'Blue Nike tee with an all-over bleach / acid wash pattern. Size L.',
        price: 26.99,
        quantity: 1,
        images: ['https://placehold.co/600x600/3d7ea6/ffffff/png?text=Nike+Bleach+Tee'],
        platform: 'ebay',
        platformListingId: 'demo_ebay_nike_bleach',
        status: 'active',
        url: 'https://www.ebay.com/itm/demo_ebay_nike_bleach',
        lastUpdated: now,
      },
    ];
  }

  return [
    {
      title: 'Mid-Century Table Lamp',
      description: 'Works perfectly, local pickup preferred.',
      price: 35,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=FB+1'],
      platform: 'facebook',
      platformListingId: 'demo_fb_3',
      status: 'active',
      url: 'https://www.facebook.com/marketplace/item/demo_fb_3',
      lastUpdated: now,
    },
    {
      title: 'IKEA Kallax Shelf (White)',
      description: 'Minor scuffs on one corner.',
      price: 55,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=FB+2'],
      platform: 'facebook',
      platformListingId: 'demo_fb_kallax',
      status: 'active',
      url: 'https://www.facebook.com/marketplace/item/demo_fb_kallax',
      lastUpdated: now,
    },
    {
      title: 'Vintage Persian Rug 5x8',
      description: 'Wool blend, recently cleaned.',
      price: 120,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=FB+3'],
      platform: 'facebook',
      platformListingId: 'demo_fb_rug',
      status: 'active',
      url: 'https://www.facebook.com/marketplace/item/demo_fb_rug',
      lastUpdated: now,
    },
    {
      title: 'Herman Miller Aeron Chair',
      description: 'Size B, fully loaded, light wear.',
      price: 425,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=FB+4'],
      platform: 'facebook',
      platformListingId: 'demo_fb_aeron',
      status: 'active',
      url: 'https://www.facebook.com/marketplace/item/demo_fb_aeron',
      lastUpdated: now,
    },
    {
      title: 'H&M grey skinny jeans. Size 33 waist. Slim/skinny fit versatile grey wash',
      description: 'Charcoal grey skinny jeans, size 33.',
      price: 28,
      quantity: 1,
      images: ['https://placehold.co/600x600/5c5c5c/ffffff/png?text=HM+Grey+Jeans'],
      platform: 'facebook',
      platformListingId: 'demo_fb_hm_jeans',
      status: 'active',
      url: 'https://www.facebook.com/marketplace/item/demo_fb_hm_jeans',
      lastUpdated: now,
    },
  ];
}

function buildDepopMarketplaceCandidates(now) {
  return [
    {
      title: 'Vintage Band Tee (L)',
      description: 'Soft cotton, no holes.',
      price: 28,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Depop+1'],
      platform: 'depop',
      platformListingId: 'demo_depop_tee',
      status: 'active',
      url: 'https://www.depop.com/products/demo_depop_tee',
      lastUpdated: now,
    },
    {
      title: 'Chunky Knit Sweater',
      description: 'Oversized, barely worn.',
      price: 42,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Depop+2'],
      platform: 'depop',
      platformListingId: 'demo_depop_sweater',
      status: 'active',
      url: 'https://www.depop.com/products/demo_depop_sweater',
      lastUpdated: now,
    },
    {
      title: 'Nike Dunk Low Panda',
      description: 'Size 10, clean uppers.',
      price: 145,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Depop+3'],
      platform: 'depop',
      platformListingId: 'demo_depop_dunks',
      status: 'active',
      url: 'https://www.depop.com/products/demo_depop_dunks',
      lastUpdated: now,
    },
    {
      title: 'Nike short sleeve tee in blue with an all-over bleach dye / acid wash pattern',
      description: 'Blue Nike tee, bleach dye / acid wash. Size L.',
      price: 23,
      quantity: 1,
      images: ['https://placehold.co/600x600/3d7ea6/ffffff/png?text=Nike+Bleach+Tee'],
      platform: 'depop',
      platformListingId: 'demo_depop_nike_bleach',
      status: 'active',
      url: 'https://www.depop.com/products/demo_depop_nike_bleach',
      lastUpdated: now,
    },
  ];
}

function buildPoshmarkMarketplaceCandidates(now) {
  return [
    {
      title: 'Lululemon Align Leggings (6)',
      description: 'Black, excellent condition.',
      price: 54,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Poshmark+1'],
      platform: 'poshmark',
      platformListingId: 'demo_posh_align',
      status: 'active',
      url: 'https://poshmark.com/listing/demo_posh_align',
      lastUpdated: now,
    },
    {
      title: 'Coach Shoulder Bag',
      description: 'Leather, light wear on corners.',
      price: 89,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Poshmark+2'],
      platform: 'poshmark',
      platformListingId: 'demo_posh_coach',
      status: 'active',
      url: 'https://poshmark.com/listing/demo_posh_coach',
      lastUpdated: now,
    },
    {
      title: 'Nike Air Max 90 (9.5)',
      description: 'Clean uppers, original box.',
      price: 72,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Poshmark+3'],
      platform: 'poshmark',
      platformListingId: 'demo_posh_airmax',
      status: 'active',
      url: 'https://poshmark.com/listing/demo_posh_airmax',
      lastUpdated: now,
    },
    {
      title: "H&M Skinny Fit Jeans Men's Size 33 Charcoal Gray Stretch Denim 5-Pocket",
      description: 'Charcoal grey skinny jeans, size 33.',
      price: 32,
      quantity: 1,
      images: ['https://placehold.co/600x600/5c5c5c/ffffff/png?text=HM+Grey+Jeans'],
      platform: 'poshmark',
      platformListingId: 'demo_posh_hm_jeans',
      status: 'active',
      url: 'https://poshmark.com/listing/demo_posh_hm_jeans',
      lastUpdated: now,
    },
  ];
}

function buildEtsyMarketplaceCandidates(now) {
  return [
    {
      title: 'Handmade Ceramic Mug',
      description: 'Speckled glaze, dishwasher safe.',
      price: 24,
      quantity: 3,
      images: ['https://placehold.co/300x200/png?text=Etsy+1'],
      platform: 'etsy',
      platformListingId: 'demo_etsy_mug',
      status: 'active',
      url: 'https://www.etsy.com/listing/demo_etsy_mug',
      lastUpdated: now,
    },
    {
      title: 'Custom Name Necklace',
      description: '14k gold fill, 16 inch chain.',
      price: 38,
      quantity: 5,
      images: ['https://placehold.co/300x200/png?text=Etsy+2'],
      platform: 'etsy',
      platformListingId: 'demo_etsy_necklace',
      status: 'active',
      url: 'https://www.etsy.com/listing/demo_etsy_necklace',
      lastUpdated: now,
    },
    {
      title: 'Printable Wall Art Set',
      description: 'Three digital prints, instant download.',
      price: 12,
      quantity: 99,
      images: ['https://placehold.co/300x200/png?text=Etsy+3'],
      platform: 'etsy',
      platformListingId: 'demo_etsy_prints',
      status: 'active',
      url: 'https://www.etsy.com/listing/demo_etsy_prints',
      lastUpdated: now,
    },
  ];
}

function buildReverbMarketplaceCandidates(now) {
  return [
    {
      title: 'Fender Player Stratocaster',
      description: 'Sunburst, maple neck, lightly played.',
      price: 649,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Reverb+1'],
      platform: 'reverb',
      platformListingId: 'demo_reverb_strat',
      status: 'active',
      url: 'https://reverb.com/item/demo_reverb_strat',
      lastUpdated: now,
    },
    {
      title: 'Boss DS-1 Distortion',
      description: 'Classic pedal, works perfectly.',
      price: 49,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Reverb+2'],
      platform: 'reverb',
      platformListingId: 'demo_reverb_ds1',
      status: 'active',
      url: 'https://reverb.com/item/demo_reverb_ds1',
      lastUpdated: now,
    },
    {
      title: 'Shure SM57 Dynamic Microphone',
      description: 'Includes clip, no case.',
      price: 89,
      quantity: 1,
      images: ['https://placehold.co/300x200/png?text=Reverb+3'],
      platform: 'reverb',
      platformListingId: 'demo_reverb_sm57',
      status: 'active',
      url: 'https://reverb.com/item/demo_reverb_sm57',
      lastUpdated: now,
    },
  ];
}

function annotateImportCandidates(candidates, platform) {
  return candidates.map((listing) => {
    const incoming = { ...listing, platform: listing.platform || platform };
    const match = findExistingListing(incoming);
    const imageMatch = match ? null : findImageMatchInInventory(incoming, platform);
    const alreadyImported = Boolean(match && listingHasPlatform(match, platform));
    return {
      ...incoming,
      alreadyImported,
      alreadyInInventory: Boolean(match),
      matchedItemId: match?.id || null,
      possibleImageMatch: Boolean(imageMatch),
      possibleImageMatchId: imageMatch?.id || null,
      possibleImageMatchTitle: imageMatch?.title || null,
    };
  });
}

function applyMoneyDivisor(divisor) {
  const value = Number(divisor);
  if (!Number.isFinite(value) || value <= 0) return 100;
  if (value >= 10) return value;
  return Math.pow(10, value);
}

function parseListingPrice(value, depth = 0) {
  if (value == null || value === '' || depth > 6) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parseListingPrice(entry, depth + 1);
      if (parsed) return parsed;
    }
    return 0;
  }
  if (typeof value === 'object') {
    if (value.divisor != null && value.amount != null && typeof value.amount !== 'object') {
      const amount = Number(value.amount);
      if (Number.isFinite(amount) && amount > 0) {
        return amount / applyMoneyDivisor(value.divisor);
      }
    }
    const keys = [
      'priceAmount',
      'price_amount',
      'salePrice',
      'sale_price',
      'originalPrice',
      'original_price',
      'amount',
      'value',
      'price',
    ];
    for (const key of keys) {
      if (value[key] == null) continue;
      let parsed = parseListingPrice(value[key], depth + 1);
      if (!parsed) continue;
      if (value.divisor != null) {
        parsed /= applyMoneyDivisor(value.divisor);
      }
      return parsed;
    }
    return 0;
  }

  const text = String(value).replace(/\s+/g, ' ').trim();
  const match =
    text.match(
      /(?:USD|CAD|GBP|EUR|AUD|US\$|CA\$|A\$|C\$|£|€|\$)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:USD|CAD|GBP|EUR|AUD)/i
    ) || text.match(/([\d,]+\.\d{2})/);
  if (match) {
    const amount = parseFloat(String(match[1] || match[2]).replace(/,/g, ''));
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  }
  const amount = parseFloat(text.replace(/[^0-9.]/g, ''));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}
export {
  TITLE_STOPWORDS,
  TITLE_SIZE_WORDS,
  stripTitleJunk,
  collapseRepeatedTitle,
  cleanedListingTitle,
  normalizeTitle,
  titleTokens,
  titleSimilarity,
  titlesAreSameProduct,
  titlesLookRelated,
  decoratePlatformEntry,
  getPlatforms,
  listingHasPlatform,
  toUnifiedListing,
  findExistingListing,
  IMAGE_QUERY_DROP,
  normalizeImageUrl,
  isRealListingImage,
  realListingImages,
  extractOgImage,
  fetchHtml,
  ebayItemIdFromListing,
  fetchListingThumbnail,
  listingNeedsImageHydration,
  mapPool,
  applyListingImages,
  hydrateListingImages,
  hydrateMissingListingImages,
  listingImageList,
  listingImageKeys,
  listingsShareImage,
  listingPlatformKeys,
  platformsOverlap,
  summarizeMatchListing,
  findImageMatchInInventory,
  findImageMatchGroups,
  mergeInventoryListings,
  pickPrimaryListing,
  mergeObviousDuplicateListings,
  cleanStoredListingTitles,
  upsertImportedListing,
  seedDemoInventory,
  seedDemoEbayListings,
  seedDemoFacebookListings,
  buildMarketplaceCandidates,
  buildDepopMarketplaceCandidates,
  buildPoshmarkMarketplaceCandidates,
  buildEtsyMarketplaceCandidates,
  buildReverbMarketplaceCandidates,
  annotateImportCandidates,
  applyMoneyDivisor,
  parseListingPrice,
};
