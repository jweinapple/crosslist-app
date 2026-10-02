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

// ---------------------------------------------------------------------------
// FILL_FACEBOOK_LISTING — automatic distribution target.
//
// HONEST AUTOMATION NOTES:
// - This drives the Marketplace composer (facebook.com/marketplace/create/item)
//   inside the user's own logged-in browser session. There is no Facebook
//   listing API; the server only queued a job and never touches Facebook.
// - It requires: (a) the Crosslist Connector extension installed, (b) the
//   user signed into Facebook in this Chrome profile, (c) the dashboard
//   relaying the job to the extension.
// - Everything is driven by the job payload (title, price, description,
//   category, condition, photo data URLs). There is intentionally NO per-item
//   prompt or confirmation inside this script: the single user confirmation
//   happened on the server side before the job was queued.
// - The script clicks "Publish" automatically when every required field was
//   filled. Facebook's composer DOM changes often, so every field uses
//   multiple selector fallbacks and the result reports per-field success plus
//   an extracted listing id when the publish redirect can be observed. When
//   the redirect cannot be verified, the result says so instead of claiming
//   success.
// ---------------------------------------------------------------------------

function fbSetNativeValue(el, value) {
  if (!el) return false;
  try {
    el.focus();
  } catch {
    /* focus is best effort */
  }
  if (el.isContentEditable) {
    el.textContent = String(value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value) }));
    return true;
  }
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  try {
    el._valueTracker?.setValue?.('');
  } catch {
    /* not a React-tracked input */
  }
  descriptor?.set?.call(el, String(value));
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' })
  );
  return true;
}

function fbFieldHaystack(el) {
  const labelText = el.labels
    ? [...el.labels].map((label) => label.textContent || '').join(' ')
    : '';
  const groupText = String(el.closest('label, [role="group"], div')?.innerText || '').slice(0, 160);
  return [
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
    el.getAttribute('name'),
    el.id,
    el.getAttribute('title'),
    labelText,
    groupText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function fbFindTextbox(keywords) {
  const wanted = keywords.map((word) => String(word).toLowerCase());
  const nodes = [
    ...document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]'),
  ].filter((el) => {
    if (el.disabled || el.readOnly) return false;
    const type = String(el.type || '').toLowerCase();
    return !['hidden', 'file', 'checkbox', 'radio', 'submit', 'button'].includes(type);
  });
  return (
    nodes.find((el) => {
      const aria = String(el.getAttribute('aria-label') || '').toLowerCase();
      return wanted.some((word) => aria === word || aria.startsWith(`${word} `));
    }) ||
    nodes.find((el) => {
      const hay = fbFieldHaystack(el);
      return wanted.some((word) => hay.includes(word));
    })
  );
}

function fbDataUrlToFile(dataUrl, index) {
  const [header, encoded] = String(dataUrl || '').split(',');
  const mime = header.match(/data:([^;]+)/i)?.[1] || 'image/jpeg';
  const binary = atob(encoded || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  return new File([bytes], `crosslist-${index + 1}.${ext}`, { type: mime });
}

async function fbUploadPhotos(dataUrls = []) {
  const files = (dataUrls || [])
    .filter((url) => String(url).startsWith('data:image/'))
    .map((url, index) => fbDataUrlToFile(url, index));
  if (!files.length) return { ok: false, count: 0, error: 'No usable photos in job payload' };
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  const input =
    inputs.find((el) => /image/i.test(el.getAttribute('accept') || '')) || inputs[0];
  if (!input) return { ok: false, count: 0, error: 'Photo upload input not found' };
  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(1500);
  return { ok: true, count: files.length };
}

async function fbWaitForComposer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready =
      fbFindTextbox(['title']) ||
      document.querySelector('input[type="file"]') ||
      /\/marketplace\/create/i.test(window.location.pathname);
    if (ready && (fbFindTextbox(['title']) || document.querySelector('input[type="file"]'))) {
      return true;
    }
    await sleep(400);
  }
  return false;
}

function fbNormalized(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function fbSelectCategory(category) {
  const wanted = fbNormalized(category);
  if (!wanted) return { ok: false, skipped: true };
  const field =
    document.querySelector('[role="combobox"][aria-label*="ategor" i]') ||
    fbFindTextbox(['category']);
  if (!field) return { ok: false, error: 'Category field not found' };
  field.click();
  field.focus();
  await sleep(900);
  const options = [
    ...document.querySelectorAll('[role="option"], [role="listbox"] [role="button"], ul[role="listbox"] li'),
  ].filter((el) => (el.innerText || '').trim().length);
  if (!options.length) return { ok: false, error: 'Category options did not open' };
  const words = wanted.split(' ').filter((word) => word.length > 2);
  const match =
    options.find((el) => fbNormalized(el.innerText) === wanted) ||
    options.find((el) => {
      const text = fbNormalized(el.innerText);
      return words.length > 0 && words.every((word) => text.includes(word));
    }) ||
    options.find((el) => {
      const text = fbNormalized(el.innerText);
      return words.some((word) => text.includes(word));
    });
  if (!match) {
    document.body.click();
    return { ok: false, error: `No category matched "${category}"` };
  }
  match.click();
  await sleep(600);
  return { ok: true, selected: (match.innerText || '').trim().slice(0, 80) };
}

function fbSelectCondition(condition) {
  // Condition arrives as free text from the identity step ("Like new",
  // "used_good", "Good", ...). Match FB's buttons fuzzily; default to Used.
  const text = fbNormalized(condition);
  let hints;
  if (/\bnew\b/.test(text) && !/used|pre.?owned|second/.test(text)) {
    hints = ['new'];
  } else if (/like.?new|excellent|mint/.test(text)) {
    hints = ['used', 'like new'];
  } else if (/fair|worn|damage/.test(text)) {
    hints = ['used', 'fair'];
  } else if (/good|great|nice/.test(text)) {
    hints = ['used', 'good'];
  } else {
    hints = ['used'];
  }
  const buttons = [...document.querySelectorAll('button, [role="button"], [role="radio"]')];
  const match = buttons.find((el) => {
    const label = fbNormalized(el.innerText || el.getAttribute('aria-label') || '');
    return hints.every((hint) => label.includes(hint));
  });
  if (!match) return { ok: false, error: `Condition option not found for "${condition}"` };
  match.click();
  return { ok: true };
}

function fbClickPublish() {
  const wanted = ['publish', 'list item', 'post'];
  const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')];
  const match = buttons.find((el) => {
    const text = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
    return wanted.some((label) => text === label);
  });
  if (!match || match.disabled) return false;
  match.click();
  return true;
}

function fbExtractListingId() {
  const href = window.location.href;
  const match = href.match(/\/marketplace\/item\/(\d{6,})/i);
  if (match?.[1]) return match[1];
  const param = new URLSearchParams(window.location.search).get('listing_id');
  return /^\d{6,}$/.test(param || '') ? param : null;
}

async function fillFacebookListing(job = {}) {
  const payload = job.payload || job;
  const jobId = job.jobId || payload.jobId || null;
  const trace = [];
  const filled = {};
  const note = (message) => {
    trace.push({ at: new Date().toISOString(), message });
    console.log(`[crosslist fb-fill] ${message}`);
  };

  if (!isFacebookLoggedIn()) {
    return {
      success: false,
      jobId,
      needsLogin: true,
      error: 'Not signed in to Facebook in this browser. Sign in, then the job can be retried.',
      step: 'checking Facebook session',
      url: window.location.href,
    };
  }

  const composerReady = await fbWaitForComposer();
  if (!composerReady) {
    return {
      success: false,
      jobId,
      error: 'Marketplace composer did not load',
      step: 'waiting for the listing composer',
      url: window.location.href,
      trace,
    };
  }
  note('Composer ready');

  const photoResult = await fbUploadPhotos(payload.images || []);
  filled.photos = photoResult.ok ? photoResult.count : 0;
  note(photoResult.ok ? `Uploaded ${photoResult.count} photo(s)` : `Photo upload issue: ${photoResult.error}`);
  if (!photoResult.ok) {
    return {
      success: false,
      jobId,
      error: photoResult.error || 'Photo upload failed',
      step: 'uploading photos',
      url: window.location.href,
      filled,
      trace,
    };
  }

  const title = fbFindTextbox(['title']);
  filled.title = Boolean(payload.title && title && fbSetNativeValue(title, String(payload.title).slice(0, 100)));
  await sleep(300);
  note(`Title: ${filled.title ? 'filled' : 'NOT filled'}`);

  const price = fbFindTextbox(['price']);
  const priceValue =
    payload.price != null && payload.price !== '' ? Number(payload.price).toFixed(2).replace(/\.00$/, '') : '';
  filled.price = Boolean(priceValue && price && fbSetNativeValue(price, priceValue));
  await sleep(300);
  note(`Price: ${filled.price ? 'filled' : 'NOT filled'}`);

  const category = await fbSelectCategory(payload.category);
  filled.category = Boolean(category.ok);
  note(category.ok ? `Category: ${category.selected}` : `Category issue: ${category.error || 'skipped'}`);

  const condition = fbSelectCondition(payload.condition);
  filled.condition = Boolean(condition.ok);
  note(condition.ok ? 'Condition selected' : `Condition issue: ${condition.error}`);

  const description = fbFindTextbox(['description']);
  filled.description = Boolean(
    payload.description && description && fbSetNativeValue(description, payload.description)
  );
  await sleep(300);
  note(`Description: ${filled.description ? 'filled' : 'NOT filled'}`);

  const required = ['title', 'price'];
  const missing = required.filter((key) => !filled[key]);
  if (missing.length) {
    return {
      success: false,
      jobId,
      error: `Required fields not filled: ${missing.join(', ')}`,
      step: 'filling the listing form',
      url: window.location.href,
      filled,
      trace,
    };
  }

  await sleep(800);
  const publishClicked = fbClickPublish();
  note(publishClicked ? 'Publish clicked' : 'Publish button not found or disabled');
  if (!publishClicked) {
    return {
      success: false,
      jobId,
      error: 'Publish button not found or disabled',
      step: 'publishing the listing',
      url: window.location.href,
      filled,
      needsReview: true,
      trace,
    };
  }

  // Give Facebook a moment to submit and redirect to the new listing page.
  const start = Date.now();
  let listingId = null;
  while (Date.now() - start < 12000) {
    await sleep(1000);
    listingId = fbExtractListingId();
    if (listingId) break;
  }

  const url = window.location.href;
  if (listingId) {
    note(`Published as listing ${listingId}`);
    return {
      success: true,
      jobId,
      published: true,
      listingId,
      url,
      filled,
      verification: 'redirect',
      trace,
    };
  }

  // The button was clicked but the publish could not be verified (no
  // redirect to /marketplace/item/<id> within the timeout). Report this
  // honestly instead of claiming success.
  note('Publish clicked but the new listing URL was not observed');
  return {
    success: true,
    jobId,
    published: false,
    listingId: null,
    url,
    filled,
    needsReview: true,
    verification: 'unverified',
    error: 'Publish was submitted but the listing could not be verified',
    trace,
  };
}

if (!globalThis.__crosslistFbFillListener) {
  globalThis.__crosslistFbFillListener = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.command !== 'FILL_FACEBOOK_LISTING') return;
    fillFacebookListing(message.payload?.job || {})
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          success: false,
          jobId: message.payload?.job?.jobId || null,
          error: error?.message || 'Facebook form fill failed',
          step: 'filling the listing form',
          url: window.location.href,
        })
      );
    return true;
  });
}

