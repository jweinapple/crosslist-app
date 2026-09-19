function setNativeInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function findPriceInput() {
  const candidates = [...document.querySelectorAll('input')];
  return (
    candidates.find((input) => /price/i.test(input.getAttribute('aria-label') || '')) ||
    candidates.find((input) => /price/i.test(input.getAttribute('placeholder') || '')) ||
    candidates.find((input) => input.inputMode === 'decimal' && input.type === 'text')
  );
}

function clickUpdateButton() {
  const buttons = [...document.querySelectorAll('div[role="button"], button, span[role="button"]')];
  const updateBtn = buttons.find((el) => {
    const text = (el.textContent || '').trim().toLowerCase();
    return text === 'update' || text === 'save' || text === 'publish';
  });
  if (updateBtn) {
    updateBtn.click();
    return true;
  }
  return false;
}

async function updateListingPrice(targetPrice) {
  await new Promise((r) => setTimeout(r, 2500));

  const priceInput = findPriceInput();
  if (!priceInput) {
    return { success: false, error: 'Price input not found on Facebook edit page' };
  }

  setNativeInputValue(priceInput, targetPrice.toFixed(2));
  await new Promise((r) => setTimeout(r, 500));

  const clicked = clickUpdateButton();
  if (!clicked) {
    return { success: false, error: 'Update button not found on Facebook edit page' };
  }

  await new Promise((r) => setTimeout(r, 2000));
  return { success: true, price: targetPrice, url: window.location.href };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.command !== 'UPDATE_FACEBOOK_PRICE') return;

  (async () => {
    const price = Number(message.payload?.price);
    if (!price || Number.isNaN(price)) {
      sendResponse({ success: false, error: 'Invalid price payload' });
      return;
    }
    sendResponse(await updateListingPrice(price));
  })();

  return true;
});
