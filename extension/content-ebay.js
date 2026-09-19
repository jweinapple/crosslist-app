function getEbayPageState() {
  const url = window.location.href;
  const path = window.location.pathname;

  if (url.includes('signin.ebay.com') || document.querySelector('#userid, #pass')) {
    return 'login';
  }
  if (path.includes('/sh/lst/')) {
    return 'selling';
  }
  if (path === '/' || url === 'https://www.ebay.com/') {
    return 'home';
  }
  return 'unknown';
}

function ebayImageMap() {
  const { listingsFromEmbeddedJson } = globalThis.CrosslistScrape;
  const map = new Map();
  listingsFromEmbeddedJson((obj) => {
    const raw = obj.legacyItemId || obj.itemId || obj.listingId || obj.id;
    const itemId = String(raw || '').replace(/\D/g, '');
    if (!/^\d{9,13}$/.test(itemId)) return null;
    const collected = [];
    const push = (value) => {
      if (typeof value === 'string' && /ebayimg|thumbs\.ebay/i.test(value)) collected.push(value);
      else if (value && typeof value === 'object') {
        if (typeof value.url === 'string') collected.push(value.url);
        if (typeof value.imageUrl === 'string') collected.push(value.imageUrl);
      }
    };
    push(obj.image);
    push(obj.thumbnail);
    push(obj.pictureURL);
    push(obj.imageUrl);
    push(obj.imgUrl);
    (obj.thumbnailImages || obj.images || obj.pictures || []).forEach(push);
    if (collected.length && !map.has(itemId)) map.set(itemId, collected.filter(Boolean));
    return null;
  });
  return map;
}

function scrapeEbayListings() {
  const { findListingCard, priceFromNode, extractImages, titleFromCard, quantityFromNode, buildListing } =
    globalThis.CrosslistScrape;
  const listings = [];
  const seen = new Set();
  const imageMap = ebayImageMap();

  document.querySelectorAll('a[href*="/itm/"]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    const match = href.match(/\/itm\/(\d+)/);
    if (!match) return;
    const itemId = match[1];
    if (seen.has(itemId)) return;
    seen.add(itemId);

    const card = findListingCard(anchor, { hrefIncludes: '/itm/' });
    const row = anchor.closest('tr, [role="row"], li, article') || card;
    let images = extractImages(row);
    if (!images.length) images = extractImages(card);
    if (!images.length) images = imageMap.get(itemId) || [];
    listings.push(
      buildListing({
        id: `ebay_${itemId}`,
        title: titleFromCard(card, anchor, `eBay item ${itemId}`),
        description: '',
        price: priceFromNode(card),
        quantity: quantityFromNode(card),
        images,
        platform: 'ebay',
        platformListingId: itemId,
        status: 'active',
        url: `https://www.ebay.com/itm/${itemId}`,
      })
    );
  });

  return listings;
}

async function preparePageForScrape() {
  for (let i = 0; i < 4; i += 1) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 700));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 400));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.command !== 'SCRAPE_EBAY_LISTINGS') return;

  (async () => {
    await preparePageForScrape();
    const listings = scrapeEbayListings();
    sendResponse({
      listings,
      pageState: getEbayPageState(),
      url: window.location.href,
    });
  })();

  return true;
});
