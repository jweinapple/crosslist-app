function isDepopLoggedIn() {
  return document.cookie.split(';').some((part) => part.trim().startsWith('access_token='));
}

function getDepopPageState() {
  const path = window.location.pathname;

  if (path.includes('/login') && !isDepopLoggedIn()) {
    return 'login';
  }
  if (path.includes('/sellinghub') || path.includes('/products/') || path.includes('/products/create')) {
    return 'selling';
  }
  if (path === '/') {
    return 'home';
  }
  return 'unknown';
}

function isCreateSlug(slug) {
  return /^(create|new|sell)$/i.test(slug);
}

function listingFromDepopJson(obj) {
  const { parseApiMoney, parseMoney, isJunkTitle, buildListing } = globalThis.CrosslistScrape;
  const slug = obj.slug || obj.productSlug;
  if (typeof slug !== 'string' || !slug || isCreateSlug(slug)) return null;
  const looksLikeProduct = obj.pictures || obj.preview || obj.status || obj.price || obj.pricing || obj.description;
  if (!looksLikeProduct) return null;

  const description = obj.description || obj.preview?.content || '';
  const titleSource = description.split('\n')[0] || obj.title || slug.replace(/-/g, ' ');
  return buildListing({
    id: `depop_${slug}`,
    title: isJunkTitle(titleSource) ? slug.replace(/-/g, ' ') : titleSource.slice(0, 120),
    description,
    price: parseApiMoney(obj.price) || parseApiMoney(obj.pricing) || parseMoney(obj.priceAmount),
    quantity: 1,
    images: extractImagesFromProduct(obj),
    platform: 'depop',
    platformListingId: slug,
    status: 'active',
    url: `https://www.depop.com/products/${slug}`,
  });
}

function extractImagesFromProduct(product) {
  const urls = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') {
      if (node.startsWith('http')) urls.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      if (node.url) urls.push(node.url);
      else Object.values(node).forEach(walk);
    }
  };
  walk(product.pictures || product.preview?.pictures || product.images);
  return [...new Set(urls)].slice(0, 8);
}

function scrapeDepopListings() {
  const {
    findListingCard,
    priceFromNode,
    extractImages,
    titleFromCard,
    listingsFromEmbeddedJson,
    isJunkTitle,
    buildListing,
  } = globalThis.CrosslistScrape;

  const listings = [];
  const seen = new Set();

  listingsFromEmbeddedJson(listingFromDepopJson).forEach((listing) => {
    if (seen.has(listing.platformListingId)) return;
    seen.add(listing.platformListingId);
    listings.push(listing);
  });

  document.querySelectorAll('a[href*="/products/"]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    if (href.includes('/products/create')) return;
    const match = href.match(/\/products\/([^/?#]+)/);
    if (!match) return;

    const slug = decodeURIComponent(match[1]);
    if (!slug || isCreateSlug(slug) || seen.has(slug)) return;
    seen.add(slug);

    const card = findListingCard(anchor, { hrefIncludes: '/products/' });
    const title = titleFromCard(card, anchor, slug.replace(/-/g, ' '));
    listings.push(
      buildListing({
        id: `depop_${slug}`,
        title: isJunkTitle(title) ? slug.replace(/-/g, ' ') : title,
        description: '',
        price: priceFromNode(card),
        quantity: 1,
        images: extractImages(card),
        platform: 'depop',
        platformListingId: slug,
        status: 'active',
        url: href.startsWith('http') ? href.split('?')[0] : `https://www.depop.com/products/${slug}`,
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
  if (message?.command !== 'SCRAPE_DEPOP_LISTINGS') return;

  (async () => {
    await preparePageForScrape();
    sendResponse({
      listings: scrapeDepopListings(),
      pageState: getDepopPageState(),
      url: window.location.href,
      loggedIn: isDepopLoggedIn(),
    });
  })();

  return true;
});
