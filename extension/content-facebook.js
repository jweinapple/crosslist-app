function getFacebookPageState() {
  const url = window.location.href;
  const path = window.location.pathname;

  if (path.includes('/login') || document.querySelector('input[name="email"], input[name="pass"]')) {
    return 'login';
  }
  if (path.includes('/marketplace/you/selling')) {
    return 'selling';
  }
  if (path === '/' || path === '/home.php' || url === 'https://www.facebook.com/') {
    return 'home';
  }
  return 'unknown';
}

function scrapeFacebookListings() {
  const { findListingCard, priceFromNode, extractImages, titleFromCard, buildListing } =
    globalThis.CrosslistScrape;
  const listings = [];
  const seen = new Set();

  document.querySelectorAll('a[href*="/marketplace/item/"]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    const match = href.match(/\/marketplace\/item\/(\d+)/);
    if (!match) return;
    const id = match[1];
    if (seen.has(id)) return;
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

async function preparePageForScrape() {
  for (let i = 0; i < 4; i += 1) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 700));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 400));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.command !== 'SCRAPE_FACEBOOK_LISTINGS') return;

  (async () => {
    await preparePageForScrape();
    sendResponse({
      listings: scrapeFacebookListings(),
      pageState: getFacebookPageState(),
      url: window.location.href,
    });
  })();

  return true;
});
