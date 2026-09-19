function getEtsyPageState() {
  const path = window.location.pathname;
  if (path.includes('/signin') || path.includes('/join') || path.includes('/login')) {
    return 'login';
  }
  if (
    path.includes('/your/shops') ||
    path.includes('/listings') ||
    path.includes('/listing/') ||
    path.includes('/shop/')
  ) {
    return 'selling';
  }
  if (path === '/') return 'home';
  return 'unknown';
}

function scrapeEtsyListings() {
  const {
    findListingCard,
    priceFromNode,
    extractImages,
    titleFromCard,
    quantityFromNode,
    listingsFromEmbeddedJson,
    parseApiMoney,
    parseMoney,
    buildListing,
  } = globalThis.CrosslistScrape;
  const listings = [];
  const seen = new Set();

  listingsFromEmbeddedJson((obj) => {
    const listingId = obj.listing_id || obj.listingId;
    if (!listingId || !obj.title) return null;
    const price = parseApiMoney(obj.price) || parseMoney(obj.price);
    if (!price) return null;
    return buildListing({
      id: `etsy_${listingId}`,
      title: obj.title,
      description: obj.description || '',
      price,
      quantity: obj.quantity || 1,
      images: [obj.MainImage?.url_570xN, obj.images?.[0]?.url_570xN, obj.image_url].filter(Boolean),
      platform: 'etsy',
      platformListingId: String(listingId),
      status: obj.state === 'active' ? 'active' : obj.state || 'active',
      url: obj.url || `https://www.etsy.com/listing/${listingId}`,
    });
  }).forEach((listing) => {
    if (seen.has(listing.platformListingId)) return;
    seen.add(listing.platformListingId);
    listings.push(listing);
  });

  document.querySelectorAll('a[href*="/listing/"]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    const match = href.match(/\/listing\/(\d+)/);
    if (!match) return;

    const listingId = match[1];
    if (seen.has(listingId)) return;
    seen.add(listingId);

    const card = findListingCard(anchor, { hrefIncludes: '/listing/' });
    listings.push(
      buildListing({
        id: `etsy_${listingId}`,
        title: titleFromCard(card, anchor, `Etsy listing ${listingId}`),
        description: '',
        price: priceFromNode(card),
        quantity: quantityFromNode(card),
        images: extractImages(card),
        platform: 'etsy',
        platformListingId: listingId,
        status: 'active',
        url: href.startsWith('http') ? href.split('?')[0] : `https://www.etsy.com/listing/${listingId}`,
      })
    );
  });

  return listings;
}

async function preparePageForScrape() {
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise((r) => setTimeout(r, 800));
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 400));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.command !== 'SCRAPE_ETSY_LISTINGS') return;

  (async () => {
    await preparePageForScrape();
    sendResponse({
      listings: scrapeEtsyListings(),
      pageState: getEtsyPageState(),
      url: window.location.href,
    });
  })();

  return true;
});
