/* content-grailed.js — Grailed listing form automation for the Crosslist Connector.
 *
 * HONESTY NOTES (read before touching this file):
 * - Grailed has NO public listing API. There is no endpoint we can POST to from
 *   the server. Everything here runs in the user's own Chrome, where the user
 *   is already logged in to Grailed. No credentials ever leave this page.
 * - This script only FILLS the sell form at https://www.grailed.com/sell/new.
 *   It never clicks Publish/List, never solves captchas, never logs anyone in.
 *   The seller reviews the filled draft and publishes it themselves — the
 *   result is always { needsReview: true }.
 * - Grailed's sell form is a React SPA with a category → size → sub-category
 *   → designer cascade and searchable designer/color comboboxes. The cascade
 *   only makes sense after a human-confirmed category, so the script fills
 *   best-effort text matches and flags anything uncertain in the on-page
 *   banner and in the returned checklist. It must never invent a designer.
 * - Selectors here are brittle by nature: a Grailed redesign can break any of
 *   them. The script is written defensively (multi-strategy field lookup,
 *   per-field success flags) and reports what it could NOT fill so the seller
 *   can finish it — a partial fill is the expected degraded mode, not an error.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGrailedLoggedIn() {
  const path = window.location.pathname;
  if (/sign_in|login|register/i.test(path)) return false;
  if (document.querySelector('form[action*="sign_in"], a[href*="/users/sign_in"]')) return false;
  return document.cookie.split(';').some((part) => {
    const name = part.trim().split('=')[0].toLowerCase();
    return name.includes('session') || name.includes('grailed') || name.includes('user');
  });
}

// React-safe value setter: mirrors extension/content-create.js so controlled
// inputs actually register the change instead of ignoring it.
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
  el._valueTracker?.setValue?.('');
  descriptor?.set?.call(el, String(value));
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' })
  );
  return true;
}

function haystackFor(el) {
  const labelText = el.labels
    ? [...el.labels].map((label) => label.textContent || '').join(' ')
    : '';
  const parentText = String(
    el.closest('label, [role="group"], div')?.innerText || ''
  ).slice(0, 140);
  return [
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
    el.getAttribute('name'),
    el.id,
    el.getAttribute('title'),
    labelText,
    parentText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function findField(keywords) {
  const wanted = keywords.map((word) => String(word).toLowerCase());
  const nodes = [...document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')];
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
  await sleep(1200);
  return true;
}

// Best-effort option picker for native <select> or custom listboxes/dropdowns.
// Returns the label that was actually chosen, or '' when nothing matched.
// Never invents an option: only clicks options that exist in the DOM.
async function pickOption(fieldKeywords, candidateLabels) {
  const wanted = candidateLabels.map((label) => String(label).toLowerCase());
  const field = findField(fieldKeywords);
  if (!field) return '';

  const clickOption = async () => {
    await sleep(400);
    const options = [
      ...document.querySelectorAll('[role="option"], [role="menuitem"], li[data-value], option'),
    ];
    for (const want of wanted) {
      const match = options.find((opt) => {
        const text = String(opt.textContent || opt.value || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        return text === want || text.startsWith(`${want} `);
      });
      if (match) {
        match.scrollIntoView({ block: 'center' });
        await sleep(150);
        match.click();
        await sleep(500);
        return String(match.textContent || '').replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  };

  if (field.tagName === 'SELECT') {
    for (const want of wanted) {
      const opt = [...field.options].find((o) =>
        String(o.text || o.value).trim().toLowerCase() === want
      );
      if (opt) {
        field.value = opt.value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(400);
        return String(opt.text).trim();
      }
    }
    return '';
  }

  field.click();
  const chosen = await clickOption();
  if (!chosen && document.activeElement === field) field.blur();
  return chosen;
}

// Grailed's designer field is a searchable combobox. Type the designer name,
// then pick the top exact-ish match from the suggestion list. If nothing
// matches confidently, leave it alone and flag it — never invent a designer.
async function pickDesigner(designer) {
  const name = String(designer || '').trim();
  if (!name) return '';
  const field = findField(['designer', 'brand', 'designer name']);
  if (!field) return '';

  setNativeValue(field, name);
  await sleep(1200);
  const suggestions = [...document.querySelectorAll('[role="option"], [role="listbox"] li, ul[role="listbox"] > *')];
  const target = name.toLowerCase();
  const match = suggestions.find((el) => {
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return text === target || text.startsWith(`${target} `) || text.startsWith(target);
  });
  if (match) {
    match.scrollIntoView({ block: 'center' });
    await sleep(150);
    match.click();
    await sleep(600);
    return String(match.textContent || '').replace(/\s+/g, ' ').trim();
  }
  field.blur();
  return '';
}

const GRAILED_CONDITION_ORDER = ['new', 'like new', 'gently used', 'used', 'very worn'];

function grailedConditionCandidates(condition) {
  const key = String(condition || 'used').toLowerCase().replace(/[\s_]+/g, ' ').trim();
  const map = {
    new: ['new'],
    'brand new': ['new'],
    'like new': ['like new', 'new'],
    mint: ['like new', 'new'],
    excellent: ['gently used', 'like new'],
    'used excellent': ['gently used', 'like new'],
    'used good': ['used', 'gently used'],
    good: ['used', 'gently used'],
    'used fair': ['used', 'very worn'],
    fair: ['used', 'very worn'],
    poor: ['very worn', 'used'],
  };
  return map[key] || [key, 'used', 'gently used'];
}

async function waitForGrailedForm(ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (
      findField(['title']) ||
      document.querySelector('input[type="file"]')
    ) {
      return true;
    }
    await sleep(300);
  }
  return false;
}

function showGrailedBanner(listing, filledFields, missingFields) {
  const existing = document.getElementById('crosslist-grailed-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'crosslist-grailed-banner';
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
  const missing =
    missingFields.length
      ? ` Still needs you: ${missingFields.join(', ')}.`
      : '';
  banner.textContent =
    `Crosslist filled "${listing.title || 'this item'}" on Grailed (${filledFields.join(', ')}).` +
    ` Review the category/size/designer fields, then publish it yourself.${missing}`;
  document.documentElement.appendChild(banner);
  setTimeout(() => banner.remove(), 25000);
}

async function fillGrailedListing(listing = {}) {
  const filled = [];
  const missing = [];
  const note = (label, ok) => (ok ? filled.push(label) : missing.push(label));

  if (!isGrailedLoggedIn()) {
    return {
      success: false,
      filled: false,
      published: false,
      needsReview: true,
      listingId: null,
      url: window.location.href,
      error: 'Sign in to Grailed in this browser first, then run the listing again',
    };
  }

  const formReady = await waitForGrailedForm(12000);
  if (!formReady) {
    return {
      success: false,
      filled: false,
      published: false,
      needsReview: true,
      listingId: null,
      url: window.location.href,
      error: 'Could not find the Grailed sell form on this page',
    };
  }

  const photos = await uploadPhotos(listing.images);
  note('photos', photos);
  await sleep(400);

  const title = findField(['title', 'listing title', 'what are you selling']);
  note('title', Boolean(listing.title && title && setNativeValue(title, String(listing.title).slice(0, 140))));
  await sleep(250);

  // Grailed wants whole-dollar prices on the sell form.
  const price = findField(['price', 'amount', 'asking price']);
  const priceText =
    listing.price != null && listing.price !== ''
      ? String(Math.max(1, Math.round(Number(listing.price))))
      : '';
  note('price', Boolean(priceText && price && setNativeValue(price, priceText)));
  await sleep(250);

  const description = findField(['description', 'describe', 'about this item', 'details']);
  note(
    'description',
    Boolean(listing.description && description && setNativeValue(description, listing.description))
  );
  await sleep(250);

  // Grailed's category → size → sub-category → designer cascade only makes
  // sense after a human-confirmed category. We attempt best-effort matches
  // for the simple selects but never force the cascade; the seller confirms it.
  const details = listing.details && typeof listing.details === 'object' ? listing.details : {};
  const designer = details.designer || details.brand || '';
  const chosenDesigner = await pickDesigner(designer);
  note('designer', Boolean(chosenDesigner));
  if (designer && !chosenDesigner) missing[missing.length - 1] = `designer (${designer})`;

  const color = details.color || '';
  const chosenColor = color
    ? await pickOption(['color'], [color, color.split(/\s+/)[0]])
    : '';
  note('color', Boolean(chosenColor));

  const condition = listing.condition || 'used';
  const chosenCondition = await pickOption(['condition'], grailedConditionCandidates(condition));
  note('condition', Boolean(chosenCondition));

  const size = details.size || '';
  const chosenSize = size
    ? await pickOption(['size'], [String(size), String(size).toLowerCase()])
    : '';
  note('size', Boolean(chosenSize));

  showGrailedBanner(listing, filled, missing);

  // Deliberate: this script never clicks Publish. Grailed's cascade + designer
  // fields need a human eye, and auto-publishing would be the part most likely
  // to mis-list an item. The seller always publishes manually.
  return {
    success: filled.length > 0,
    filled: filled.length > 0,
    published: false,
    needsReview: true,
    listingId: null,
    url: window.location.href,
    fields: { filled, missing },
  };
}

if (!globalThis.__crosslistGrailedListener) {
  globalThis.__crosslistGrailedListener = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.command !== 'CREATE_GRAILED_LISTING') return;
    fillGrailedListing(message.payload?.listing || {})
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          success: false,
          error: error.message,
          needsReview: true,
          url: window.location.href,
        })
      );
    return true;
  });
}
