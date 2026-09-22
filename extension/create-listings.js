function listingTitle(listing) {
  return String(listing?.title || '').replace(/\s+/g, ' ').trim();
}

function listingPrice(listing) {
  const price = Number(listing?.price);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function listingQuantity(listing) {
  const quantity = Number(listing?.quantity);
  return Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
}

function listingDetails(listing) {
  const details = listing?.details && typeof listing.details === 'object' ? listing.details : {};
  return details;
}

function dataUrlToBlob(dataUrl) {
  const [header, encoded] = String(dataUrl || '').split(',');
  if (!encoded) return null;
  const mime = header.match(/data:([^;]+)/i)?.[1] || 'image/jpeg';
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function dataUrlFilename(dataUrl, index) {
  const mime = String(dataUrl || '').match(/data:([^;]+)/i)?.[1] || 'image/jpeg';
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  return `crosslist-${index + 1}.${ext}`;
}

function listingPhotos(listing) {
  return (listing?.images || []).filter((url) => /^data:image\//i.test(url) || /^https:\/\//i.test(url));
}

function errorFromBody(body, fallback) {
  if (!body) return fallback;
  if (typeof body === 'string') {
    const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, 180) || fallback;
  }
  const message =
    body.message ||
    body.error ||
    body.errors?.[0]?.message ||
    body.errors?.[0]?.longMessage ||
    (typeof body.errors === 'string' ? body.errors : '');
  if (message) return String(message);
  if (body.errors && typeof body.errors === 'object' && !Array.isArray(body.errors)) {
    const first = Object.values(body.errors).flat()[0];
    if (first) return String(first);
  }
  return fallback;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return { ok: response.ok, status: response.status, body: null, url: response.url };
  try {
    return { ok: response.ok, status: response.status, body: JSON.parse(text), url: response.url };
  } catch {
    return { ok: response.ok, status: response.status, body: text, url: response.url };
  }
}

export function describeFetchFailure(error, { url = '', method = 'GET', step = '' } = {}) {
  const raw = error?.message || String(error || 'Unknown error');
  let host = '';
  let path = url;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    path = parsed.pathname;
  } catch {
    /* keep the raw url */
  }
  const failedToFetch = /failed to fetch|networkerror|load failed|network request failed/i.test(raw);
  const source = /ebay\./i.test(host)
    ? 'ebay'
    : /localhost|127\.0\.0\.1/i.test(host)
      ? 'crosslist'
      : 'fetch';
  const target = source === 'ebay' ? 'eBay' : source === 'crosslist' ? 'Crosslist' : host || 'the store';
  const message = failedToFetch
    ? `Could not reach ${target}${step ? ` while ${step}` : ''} (${method} ${path || url})`
    : raw;
  return {
    message,
    detail: {
      source,
      step: step || null,
      method,
      url,
      host,
      path,
      name: error?.name || 'Error',
      message: raw,
      cause: error?.cause?.message || (error?.cause ? String(error.cause) : undefined),
    },
  };
}

export async function requestJson(url, { method = 'GET', headers = {}, body, form, step = '' } = {}) {
  const options = {
    method,
    credentials: 'include',
    redirect: 'follow',
    headers: { ...headers },
  };
  if (form) {
    options.body = form;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
    options.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  try {
    const response = await fetch(url, options);
    return readJson(response);
  } catch (error) {
    const described = describeFetchFailure(error, { url, method, step });
    console.error('[crosslist fetch]', described.message, described.detail);
    const wrapped = new Error(described.message);
    wrapped.cause = error;
    wrapped.detail = described.detail;
    throw wrapped;
  }
}

function isLoginUrl(url) {
  return /signin|login|checkpoint|captcha/i.test(String(url || ''));
}

async function cookieValue(url, names) {
  const wanted = names.map((name) => name.toLowerCase());
  for (const name of names) {
    const cookie = await chrome.cookies.get({ url, name });
    if (cookie?.value) return cookie.value;
  }
  const domain = new URL(url).hostname.replace(/^www\./, '');
  const cookies = await chrome.cookies.getAll({ domain });
  const match = cookies.find((cookie) => wanted.some((name) => cookie.name.toLowerCase().includes(name)));
  if (!match?.value) return '';
  try {
    return decodeURIComponent(match.value);
  } catch {
    return match.value;
  }
}

function splitTitle(listing) {
  const details = listingDetails(listing);
  const title = listingTitle(listing);
  const words = title.split(' ').filter(Boolean);
  const make = String(details.brand || details.make || words[0] || 'Unknown').slice(0, 80);
  const model = String(details.model || words.slice(1).join(' ') || title).slice(0, 80);
  return { make, model, year: String(details.year || '') };
}

const REVERB_CONDITION = {
  new: '7c3f45de-2ae0-4c81-8400-fdb6b1d74890',
  brand_new: '7c3f45de-2ae0-4c81-8400-fdb6b1d74890',
  like_new: 'ac5b9c1e-dc78-466d-b0b3-7cf712967a48',
  mint: 'ac5b9c1e-dc78-466d-b0b3-7cf712967a48',
  used_excellent: 'df268ad1-c462-4ba6-b6db-e007e23922ea',
  excellent: 'df268ad1-c462-4ba6-b6db-e007e23922ea',
  used_good: 'f7a3f48c-972a-44c6-b01a-0cd27488d3f6',
  used_fair: '98777886-76d0-44c8-865e-bb40e669e934',
  fair: '98777886-76d0-44c8-865e-bb40e669e934',
  poor: '6a9dfcad-600b-46c8-9e08-ce6e5057921e',
};

function reverbConditionUuid(listing) {
  const key = String(listing?.condition || 'used_good').toLowerCase().replace(/\s+/g, '_');
  return REVERB_CONDITION[key] || REVERB_CONDITION.used_good;
}

async function reverbCsrf() {
  const fromCookie = await cookieValue('https://reverb.com/', ['csrf-token', 'XSRF-TOKEN', '_csrf_token']);
  if (fromCookie) return fromCookie.replace(/^"/, '').replace(/"$/, '');
  const page = await fetch('https://reverb.com/', { credentials: 'include' });
  const html = await page.text();
  return (
    html.match(/name="csrf-token"\s+content="([^"]+)"/i)?.[1] ||
    html.match(/csrf-token"\s+content="([^"]+)"/i)?.[1] ||
    ''
  );
}

function identityLooksSignedIn(result) {
  return Boolean(result?.ok && !isLoginUrl(result.url));
}

async function probeReverbIdentity(csrf) {
  return Promise.all(
    ['/api/my', '/api/my/account', '/api/user'].map(async (path) => {
      try {
        return await reverbApi(path, { csrf });
      } catch (error) {
        return {
          ok: false,
          status: 0,
          body: null,
          url: `https://reverb.com${path}`,
          error: error.message,
        };
      }
    })
  );
}

export async function probeReverbSession() {
  const cookies = await chrome.cookies.getAll({ domain: 'reverb.com' });
  if (!cookies.length) return { ok: false, csrf: '' };

  let csrf = '';
  try {
    csrf = await reverbCsrf();
  } catch (error) {
    return {
      ok: false,
      csrf: '',
      error: describeFetchFailure(error, {
        url: 'https://reverb.com/',
        step: 'checking the Reverb session',
      }).message,
    };
  }

  const identity = await probeReverbIdentity(csrf);
  if (identity.some(identityLooksSignedIn)) return { ok: true, csrf };
  return { ok: false, csrf };
}

export async function reverbSessionOk() {
  return (await probeReverbSession()).ok;
}

function reverbHeaders(csrf, extra = {}) {
  return {
    Accept: 'application/hal+json, application/json',
    'Accept-Version': '3.0',
    'X-Display-Currency': 'USD',
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };
}

async function reverbApi(path, options = {}) {
  const csrf = options.csrf;
  const url = path.startsWith('http') ? path : `https://reverb.com${path}`;
  return requestJson(url, {
    method: options.method || 'GET',
    headers: reverbHeaders(csrf, options.headers),
    body: options.body,
    form: options.form,
  });
}

async function suggestReverbCategory(title, csrf) {
  const query = encodeURIComponent(title.slice(0, 80));
  const searches = [
    `/api/listings?query=${query}&per_page=5`,
    `/api/categories?q=${query}`,
    `/api/taxonomy?q=${query}`,
  ];
  for (const path of searches) {
    const result = await reverbApi(path, { csrf });
    const listings = result.body?.listings || result.body?.results || [];
    for (const listing of listings) {
      const uuid = listing.categories?.[0]?.uuid || listing.category?.uuid || listing.uuid;
      if (uuid) return uuid;
    }
    const categories = result.body?.categories || result.body?._embedded?.categories || [];
    const uuid = categories[0]?.uuid || categories[0]?.id;
    if (uuid) return uuid;
  }
  return '';
}

async function reverbShippingProfileId(csrf) {
  const paths = ['/api/my/shipping/profiles', '/api/shipping_profiles', '/api/my/shipping_policies'];
  for (const path of paths) {
    const result = await reverbApi(path, { csrf });
    const profiles = result.body?.shipping_profiles || result.body?.profiles || result.body?.shipping_policies || [];
    const id = profiles[0]?.id || profiles[0]?.uuid;
    if (id) return id;
  }
  return '';
}

async function uploadReverbPhotos(listingId, listing, csrf) {
  const photos = listingPhotos(listing);
  let uploaded = 0;
  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    if (/^https:\/\//i.test(photo)) continue;
    const blob = dataUrlToBlob(photo);
    if (!blob) continue;
    const form = new FormData();
    form.append('photo', blob, dataUrlFilename(photo, i));
    form.append('file', blob, dataUrlFilename(photo, i));
    const result = await reverbApi(`/api/listings/${encodeURIComponent(listingId)}/photos`, {
      method: 'POST',
      csrf,
      form,
    });
    if (result.ok) uploaded += 1;
  }
  return uploaded;
}

function reverbListingPayload(listing, extra = {}) {
  const { make, model, year } = splitTitle(listing);
  const photos = listingPhotos(listing).filter((url) => /^https:\/\//i.test(url));
  const quantity = listingQuantity(listing);
  const payload = {
    title: listingTitle(listing).slice(0, 255),
    make,
    model,
    description: String(listing.description || listing.title || ''),
    price: {
      amount: listingPrice(listing).toFixed(2),
      currency: 'USD',
    },
    condition: { uuid: reverbConditionUuid(listing) },
    sku: listing.sku || undefined,
    upc_does_not_apply: true,
    has_inventory: true,
    inventory: quantity,
    shipping: { local: true },
    ...extra,
  };
  if (year) payload.year = year;
  if (photos.length) payload.photos = photos;
  return payload;
}

function reverbResultFromBody(body, fallbackUrl) {
  const created = body?.listing || body || {};
  const listingId = String(created.id || created.listing_id || '');
  const url = created._links?.web?.href || (listingId ? `https://reverb.com/item/${listingId}` : fallbackUrl);
  const slug = String(created.state?.slug || created.state || '').toLowerCase();
  const live = slug === 'live' || slug === 'published' || slug === 'active';
  return {
    success: Boolean(listingId),
    published: live || Boolean(listingId),
    listingId: listingId || null,
    url,
    needsReview: Boolean(listingId) && !live,
    filled: true,
  };
}

export async function listOnReverb(listing, trace) {
  const title = listingTitle(listing);
  if (!title) return { success: false, error: 'Title is required', needsReview: false };
  if (!listingPrice(listing)) return { success: false, error: 'Price is required', needsReview: false };

  const session = await probeReverbSession();
  if (!session.ok) {
    return {
      success: false,
      error: session.error || 'Reconnect Reverb from Marketplaces, then list again',
      needsReview: false,
    };
  }
  const csrf = session.csrf;
  trace?.note('Reverb session is ready');

  const categoryUuid = await suggestReverbCategory(title, csrf);
  const shippingProfileId = await reverbShippingProfileId(csrf);
  const extra = {};
  if (categoryUuid) extra.categories = [{ uuid: categoryUuid }];
  if (shippingProfileId) extra.shipping_profile_id = shippingProfileId;
  const payload = reverbListingPayload(listing, extra);
  trace?.note('Creating Reverb listing from Crosslist');

  const attempts = [
    { path: '/api/listings', body: payload },
    { path: '/api/listings', body: { listing: payload } },
    { path: '/api/my/listings', body: payload },
  ];
  let created = null;
  let lastError = 'Could not create the Reverb listing';
  for (const attempt of attempts) {
    const result = await reverbApi(attempt.path, { method: 'POST', csrf, body: attempt.body });
    if (result.ok) {
      created = reverbResultFromBody(result.body);
      if (created.listingId) break;
    }
    lastError = errorFromBody(result.body, lastError);
  }

  if (!created?.listingId) {
    return { success: false, error: lastError, needsReview: false };
  }

  await uploadReverbPhotos(created.listingId, listing, csrf);

  if (!created.published) {
    const publishBodies = [
      { state: { slug: 'live' } },
      { listing: { state: { slug: 'live' } } },
      { publish: true },
    ];
    for (const body of publishBodies) {
      const published = await reverbApi(`/api/listings/${encodeURIComponent(created.listingId)}`, {
        method: 'PUT',
        csrf,
        body,
      });
      if (published.ok) {
        const next = reverbResultFromBody(published.body, created.url);
        if (next.published) {
          created = { ...created, ...next, listingId: created.listingId };
          break;
        }
      }
    }
  }

  trace?.note(created.published ? `Reverb listed as ${created.listingId}` : `Reverb saved listing ${created.listingId}`);
  return {
    success: true,
    published: Boolean(created.published || created.listingId),
    listingId: created.listingId,
    url: created.url,
    needsReview: false,
    filled: true,
  };
}

const EBAY_PRELIST_URL = 'https://www.ebay.com/sl/prelist/suggest';

export async function ebaySessionOk() {
  const cookies = [
    ...(await chrome.cookies.getAll({ domain: 'ebay.com' })),
    ...(await chrome.cookies.getAll({ domain: 'ebay.co.uk' })),
  ];
  return cookies.some((cookie) => cookie.name === 's' && cookie.value);
}

async function ebayApi(path, options = {}) {
  const url = path.startsWith('http') ? path : `https://www.ebay.com${path}`;
  const method = options.method || 'GET';
  try {
    const result = await requestJson(url, {
      method,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        ...(options.headers || {}),
      },
      body: options.body,
      form: options.form,
      step: options.step || '',
    });
    if (!result.ok) {
      console.warn('[crosslist ebay api]', method, path, result.status, errorFromBody(result.body, 'request failed'));
    }
    return result;
  } catch (error) {
    const described = error.detail
      ? { message: error.message, detail: error.detail }
      : describeFetchFailure(error, { url, method, step: options.step || '' });
    console.error('[crosslist ebay api]', described.message, described.detail);
    return {
      ok: false,
      status: 0,
      body: null,
      url,
      error: described.message,
      detail: described.detail,
    };
  }
}

function ebaySuggestedCategoryId(body) {
  return String(
    body?.modules?.KEYWORDMETADATA?.categoryId ||
      body?.modules?.keywordMetadata?.categoryId ||
      body?.categoryId ||
      ''
  );
}

export function ebayListingFormUrl(title, categoryId) {
  const params = new URLSearchParams();
  params.set('mode', 'AddItem');
  params.set('title', String(title || '').slice(0, 80));
  if (categoryId) params.set('categoryId', String(categoryId));
  params.set('sr', 'sug');
  return `https://www.ebay.com/sl/list?${params.toString()}`;
}

export async function resolveEbayListingPage(listing, trace) {
  const title = listingTitle(listing);
  if (!title) return { error: 'Title is required' };
  if (!listingPrice(listing)) return { error: 'Price is required' };
  if (!(await ebaySessionOk())) {
    return { error: 'Reconnect eBay from Marketplaces, then list again' };
  }

  const home = await ebayApi('/sh/lst/active?sort=-timeRemaining', { step: 'checking the eBay session' });
  if (home.status === 0) {
    trace?.note(home.error || 'Could not reach eBay while checking the session', home.detail);
    return {
      error: home.error || 'Could not reach eBay while checking the session',
      detail: home.detail,
    };
  }
  if (isLoginUrl(home.url) || home.status === 401) {
    return { error: 'Reconnect eBay from Marketplaces, then list again' };
  }
  trace?.note('eBay session is ready');

  const suggest = await ebayApi(`/sl/prelist/api/suggest?keyword=${encodeURIComponent(title.slice(0, 80))}`, {
    step: 'finding an eBay category',
  });
  const categoryId = ebaySuggestedCategoryId(suggest.body);
  if (suggest.ok && categoryId) {
    const url = ebayListingFormUrl(title, categoryId);
    trace?.note(`Opening the eBay listing form in category ${categoryId}`);
    return { url, categoryId };
  }

  trace?.note('Opening eBay list-an-item so you can finish the listing');
  return { url: EBAY_PRELIST_URL };
}
