function getPoshmarkPageState() {
  const path = window.location.pathname;
  if (path.includes('/login') || path.includes('/signup')) return 'login';
  if (path.includes('/closet') || path.includes('/listing') || path.includes('/feed')) {
    return 'selling';
  }
  if (path === '/') return 'home';
  return 'unknown';
}

function scrapePoshmarkListings() {
  const {
    findListingCard,
    priceFromNode,
    extractImages,
    titleFromCard,
    listingsFromEmbeddedJson,
    parseApiMoney,
    parseMoney,
    buildListing,
  } = globalThis.CrosslistScrape;
  const listings = [];
  const seen = new Set();

  listingsFromEmbeddedJson((obj) => {
    const id = obj.id || obj.listing_id;
    const slug = obj.slug || obj.url_slug;
    const title = obj.title || obj.inventory?.title;
    const price = parseApiMoney(obj.price) || parseApiMoney(obj.price_amount) || parseMoney(obj.price);
    if (!title || (!id && !slug) || !price) return null;
    const listingId = String(slug || id);
    return buildListing({
      id: `poshmark_${listingId}`,
      title,
      description: obj.description || '',
      price,
      quantity: 1,
      images: [obj.cover_shot?.url_small || obj.cover_shot?.url || obj.picture_url].filter(Boolean),
      platform: 'poshmark',
      platformListingId: listingId,
      status: 'active',
      url: `https://poshmark.com/listing/${listingId}`,
    });
  }).forEach((listing) => {
    if (seen.has(listing.platformListingId)) return;
    seen.add(listing.platformListingId);
    listings.push(listing);
  });

  document.querySelectorAll('a[href*="/listing/"]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    const match = href.match(/\/listing\/([^/?#]+)/);
    if (!match) return;

    const slug = decodeURIComponent(match[1]);
    if (seen.has(slug)) return;
    seen.add(slug);

    const card = findListingCard(anchor, { hrefIncludes: '/listing/' });
    listings.push(
      buildListing({
        id: `poshmark_${slug}`,
        title: titleFromCard(card, anchor, `Poshmark item ${slug}`),
        description: '',
        price: priceFromNode(card),
        quantity: 1,
        images: extractImages(card),
        platform: 'poshmark',
        platformListingId: slug,
        status: 'active',
        url: href.startsWith('http') ? href.split('?')[0] : `https://poshmark.com/listing/${slug}`,
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
  if (message?.command !== 'SCRAPE_POSHMARK_LISTINGS') return;

  (async () => {
    await preparePageForScrape();
    sendResponse({
      listings: scrapePoshmarkListings(),
      pageState: getPoshmarkPageState(),
      url: window.location.href,
    });
  })();

  return true;
});
