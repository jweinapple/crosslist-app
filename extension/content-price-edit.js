function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setNativeInputValue(input, value) {
  const proto =
    input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  const rendered = String(value);
  input.focus();
  input._valueTracker?.setValue?.('');
  descriptor?.set?.call(input, rendered);
  input.value = rendered;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: rendered, inputType: 'insertText' }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function visible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function buttonText(el) {
  return String(el?.textContent || el?.value || el?.getAttribute?.('aria-label') || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function clickFirst(labels) {
  const nodes = [
    ...document.querySelectorAll(
      'div[role="button"], button, span[role="button"], a[role="button"], input[type="submit"], input[type="button"]'
    ),
  ];
  for (const label of labels) {
    const wanted = label.toLowerCase();
    const match = nodes.find((el) => {
      if (!visible(el)) return false;
      const text = buttonText(el);
      return text === wanted || text.startsWith(`${wanted} `);
    });
    if (match) {
      match.click();
      return true;
    }
  }
  return false;
}

function findPriceInput(extraSelectors = []) {
  for (const selector of extraSelectors) {
    const el = document.querySelector(selector);
    if (el && visible(el) && !el.disabled) return el;
  }

  const candidates = [...document.querySelectorAll('input, textarea')].filter((input) => {
    if (input.disabled || input.type === 'hidden' || input.type === 'checkbox' || input.type === 'radio') {
      return false;
    }
    if (!visible(input)) return false;
    const hay = [
      input.getAttribute('aria-label'),
      input.getAttribute('placeholder'),
      input.getAttribute('name'),
      input.id,
      input.getAttribute('data-testid'),
      input.getAttribute('autocomplete'),
    ]
      .filter(Boolean)
      .join(' ');
    return /price|amount|binprice|listing_price/i.test(hay);
  });
  if (candidates.length) return candidates[0];

  return (
    [...document.querySelectorAll('input[inputmode="decimal"], input[type="number"]')].find(
      (input) => visible(input) && !input.disabled
    ) || null
  );
}

async function maybeOpenEditor(platform) {
  const path = window.location.pathname;
  if (platform === 'poshmark' && !/edit-listing/i.test(path)) {
    const editLink = [...document.querySelectorAll('a, button, div[role="button"]')].find((el) => {
      const href = el.getAttribute('href') || '';
      const text = buttonText(el);
      return /edit-listing/i.test(href) || text === 'edit' || text === 'edit listing';
    });
    if (editLink) {
      editLink.click();
      await sleep(2500);
    }
  }
  if (platform === 'etsy' && !/listing-editor|\/edit/i.test(path)) {
    const editLink = [...document.querySelectorAll('a, button')].find((el) => {
      const href = el.getAttribute('href') || '';
      const text = buttonText(el);
      return /listing-editor|\/edit/i.test(href) || text === 'edit';
    });
    if (editLink) {
      editLink.click();
      await sleep(2500);
    }
  }
  if (platform === 'reverb' && !/\/edit/i.test(path)) {
    const editLink = [...document.querySelectorAll('a, button')].find((el) => {
      const href = el.getAttribute('href') || '';
      const text = buttonText(el);
      return /\/selling\/\d+\/edit|\/edit/i.test(href) || text === 'edit' || text === 'edit listing';
    });
    if (editLink) {
      editLink.click();
      await sleep(2500);
    }
  }
}

const PLATFORM_SELECTORS = {
  facebook: [],
  ebay: ['#binPrice', 'input[name="binPrice"]', 'input[name="price"]', '[data-testid*="price" i] input'],
  depop: ['input[name="price"]', 'input[id="price"]', 'input[autocomplete="transaction-amount"]'],
  poshmark: ['input[name="listing_price"]', '#listing_price', 'input[data-test="price"]', 'input[name="price"]'],
  etsy: ['input[name="price"]', '#listing-price', 'input[id*="price" i]'],
  reverb: ['input[name="price"]', 'input[id*="price" i]', 'input[placeholder*="price" i]'],
};

const SAVE_LABELS = {
  facebook: ['update', 'save', 'publish'],
  ebay: ['revise', 'list it', 'publish', 'save', 'update', 'submit'],
  depop: ['save', 'update', 'publish', 'post'],
  poshmark: ['update listing', 'save listing', 'save changes', 'update', 'save'],
  etsy: ['publish', 'update', 'save and continue', 'save'],
  reverb: ['save', 'update', 'publish', 'list it'],
};

async function updateListingPrice(platform, targetPrice) {
  const price = Number(targetPrice);
  if (!price || Number.isNaN(price)) {
    return { success: false, error: 'Invalid price payload' };
  }

  await sleep(1800);
  await maybeOpenEditor(platform);
  await sleep(800);

  const priceInput = findPriceInput(PLATFORM_SELECTORS[platform] || []);
  if (!priceInput) {
    return { success: false, error: `Price input not found on ${platform} edit page`, url: window.location.href };
  }

  setNativeInputValue(priceInput, price.toFixed(2));
  await sleep(600);

  const clicked = clickFirst(SAVE_LABELS[platform] || ['save', 'update']);
  if (!clicked) {
    return { success: false, error: `Save button not found on ${platform} edit page`, url: window.location.href };
  }

  await sleep(2200);
  return { success: true, price, platform, url: window.location.href };
}

if (!globalThis.__crosslistPriceEditListener) {
  globalThis.__crosslistPriceEditListener = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.command !== 'UPDATE_LISTING_PRICE') return;

    (async () => {
      sendResponse(await updateListingPrice(message.payload?.platform, message.payload?.price));
    })();

    return true;
  });
}
