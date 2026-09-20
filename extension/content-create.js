function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setNativeValue(el, value) {
  if (!el) return false;
  el.focus();
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
  descriptor?.set?.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value) }));
  return true;
}

function haystackFor(el) {
  const labelText = el.labels ? [...el.labels].map((label) => label.textContent || '').join(' ') : '';
  return [
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
    el.getAttribute('name'),
    el.id,
    el.getAttribute('title'),
    labelText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function findField(keywords) {
  const wanted = keywords.map((word) => String(word).toLowerCase());
  const nodes = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')];
  const usable = nodes.filter((el) => {
    if (el.disabled || el.readOnly) return false;
    const type = String(el.type || '').toLowerCase();
    return !['hidden', 'file', 'checkbox', 'radio', 'submit', 'button'].includes(type);
  });
  return (
    usable.find((el) => {
      const aria = String(el.getAttribute('aria-label') || '').toLowerCase();
      return wanted.some((word) => aria === word || aria.startsWith(`${word} `));
    }) ||
    usable.find((el) => {
      const hay = haystackFor(el);
      return wanted.some((word) => hay.includes(word));
    })
  );
}

function dataUrlToFile(dataUrl, index) {
  const [header, encoded] = String(dataUrl || '').split(',');
  const mime = header.match(/data:([^;]+)/i)?.[1] || 'image/jpeg';
  const binary = atob(encoded || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  return new File([bytes], `crosslist-${index + 1}.${ext}`, { type: mime });
}

function setFiles(input, files) {
  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function uploadPhotos(images = []) {
  const dataUrls = (images || []).filter((url) => String(url).startsWith('data:image/'));
  if (!dataUrls.length) return false;
  const input =
    document.querySelector('input[type="file"][accept*="image"]') ||
    document.querySelector('input[type="file"]');
  if (!input) return false;
  setFiles(
    input,
    dataUrls.map((url, index) => dataUrlToFile(url, index))
  );
  await sleep(800);
  return true;
}

function clickLabeledButton(labels) {
  const wanted = labels.map((label) => label.toLowerCase());
  const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')];
  const match = buttons.find((el) => {
    const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.trim().toLowerCase();
    return wanted.some((label) => text === label || text.includes(label));
  });
  if (!match) return false;
  match.click();
  return true;
}

function showHelperBanner(listing) {
  const existing = document.getElementById('crosslist-create-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'crosslist-create-banner';
  banner.style.cssText = [
    'position:fixed',
    'top:12px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:2147483647',
    'background:#111827',
    'color:#fff',
    'padding:12px 16px',
    'border-radius:10px',
    'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif',
    'box-shadow:0 10px 30px rgba(0,0,0,.25)',
    'max-width:min(560px,calc(100vw - 24px))',
  ].join(';');
  banner.textContent = `Crosslist filled "${listing.title || 'this item'}". Review category, shipping, and photos, then publish.`;
  document.documentElement.appendChild(banner);
  setTimeout(() => banner.remove(), 20000);
}

function extractListingId() {
  const href = location.href;
  const patterns = [
    /marketplace\/item\/(\d+)/i,
    /\/itm\/(\d{9,13})/i,
    /\/listing\/(\d+)/i,
    /\/products\/([^/?#]+)/i,
    /\/listing\/([^/?#]+)/i,
  ];
  for (const pattern of patterns) {
    const match = href.match(pattern);
    if (match?.[1] && !/create|list|new/i.test(match[1])) return match[1];
  }
  return '';
}

async function fillListing(listing = {}) {
  await sleep(1200);
  const photos = await uploadPhotos(listing.images);
  await sleep(400);
  const title = findField(['title', 'name', 'what are you selling', 'listing title']);
  const price = findField(['price', 'amount']);
  const description = findField(['description', 'describe', 'about this item', 'details']);
  if (listing.title) setNativeValue(title, listing.title);
  await sleep(200);
  if (listing.price != null && listing.price !== '') {
    setNativeValue(price, Number(listing.price).toFixed(2).replace(/\.00$/, ''));
  }
  await sleep(200);
  if (listing.description) setNativeValue(description, listing.description);
  await sleep(300);
  showHelperBanner(listing);
  clickLabeledButton(['next', 'continue', 'list item', 'publish', 'done']);
  await sleep(1500);
  const listingId = extractListingId();
  const published = Boolean(listingId) && !/create|list|new/i.test(location.pathname);
  return {
    success: true,
    filled: Boolean(title || price || description || photos),
    published,
    needsReview: !published,
    listingId: listingId || null,
    url: location.href,
    photos,
  };
}

if (!globalThis.__crosslistCreateListener) {
  globalThis.__crosslistCreateListener = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.command !== 'CREATE_MARKETPLACE_LISTING') return;
    fillListing(message.payload?.listing || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message, needsReview: true, url: location.href }));
    return true;
  });
}
