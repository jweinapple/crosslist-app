(function (root) {
  const PRICE_RE =
    /(?:USD|CAD|GBP|EUR|AUD|US\$|CA\$|A\$|C\$|£|€|\$)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:USD|CAD|GBP|EUR|AUD)/i;
  const DECIMAL_RE = /([\d,]+\.\d{2})/;
  const JUNK_TITLE_RE =
    /^(sell now|listed|active|item listed by selling|untitled item|create|shop|closet)$/i;

  function applyMoneyDivisor(divisor) {
    const value = Number(divisor);
    if (!Number.isFinite(value) || value <= 0) return 100;
    if (value >= 10) return value;
    return Math.pow(10, value);
  }

  function parseMoney(value, depth = 0) {
    if (value == null || value === '' || depth > 6) return 0;
    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0 ? value : 0;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const parsed = parseMoney(entry, depth + 1);
        if (parsed) return parsed;
      }
      return 0;
    }
    if (typeof value === 'object') {
      const keys = [
        'priceAmount',
        'price_amount',
        'salePrice',
        'sale_price',
        'originalPrice',
        'original_price',
        'amount',
        'value',
        'price',
        'major',
      ];
      for (const key of keys) {
        if (value[key] == null) continue;
        let parsed = parseMoney(value[key], depth + 1);
        if (!parsed) continue;
        if (value.divisor != null) {
          parsed /= applyMoneyDivisor(value.divisor);
        }
        return parsed;
      }
      return 0;
    }

    const text = String(value).replace(/\s+/g, ' ').trim();
    if (!text || /^free$/i.test(text)) return 0;
    const match = text.match(PRICE_RE) || text.match(DECIMAL_RE);
    if (!match) return 0;
    const amount = parseFloat(String(match[1] || match[2]).replace(/,/g, ''));
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  }

  function parseApiMoney(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'object') {
      if (value.divisor != null && value.amount != null && typeof value.amount !== 'object') {
        const amount = Number(value.amount);
        if (!Number.isFinite(amount) || amount <= 0) return 0;
        return amount / applyMoneyDivisor(value.divisor);
      }
      const nested =
        value.priceAmount ??
        value.price_amount ??
        value.amount ??
        value.value ??
        value.price ??
        value.originalPrice ??
        value.salePrice;
      if (nested != null && nested !== value) {
        const parsed = parseApiMoney(nested);
        if (parsed) return parsed;
      }
      return parseMoney(value);
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0 ? value : 0;
    }

    const text = String(value).trim();
    const withCurrency = parseMoney(text);
    if (withCurrency) return withCurrency;

    const digits = text.replace(/[^0-9.]/g, '');
    if (!digits) return 0;
    const amount = parseFloat(digits);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    if (!digits.includes('.')) return amount / 100;
    return amount;
  }

  function collapseRepeatedTitle(text) {
    let title = String(text || '')
      .replace(/OFFER EXPIRED/gi, ' ')
      .replace(/New notification/gi, ' ')
      .replace(/notification.*$/gi, ' ')
      .replace(/\breach more buyers\b/gi, ' ')
      .replace(/\bbuy it now\b/gi, ' ')
      .replace(/\b(Sell now|Mark as sold|Promote listing|Share listing)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (title.length < 24) return title;
    const lower = title.toLowerCase();
    const start = lower.slice(0, Math.min(24, Math.floor(title.length / 2)));
    let idx = lower.indexOf(start, 12);
    while (idx !== -1) {
      const left = title.slice(0, idx).replace(/[\s\-|:–—]+$/g, '');
      const right = title.slice(idx);
      const leftN = left.toLowerCase();
      const rightN = right.toLowerCase();
      let same = 0;
      const check = Math.min(leftN.length, rightN.length);
      while (same < check && leftN[same] === rightN[same]) same += 1;
      if (left.length >= 16 && same >= Math.min(16, Math.floor(leftN.length * 0.6))) {
        return left.trim();
      }
      idx = lower.indexOf(start, idx + 1);
    }
    return title;
  }

  function cleanTitle(text) {
    return collapseRepeatedTitle(text);
  }

  function isJunkTitle(text) {
    const title = cleanTitle(text);
    return !title || title.length < 3 || JUNK_TITLE_RE.test(title);
  }

  function listingAnchors(node, hrefIncludes) {
    return [...(node?.querySelectorAll?.('a[href]') || [])].filter((anchor) =>
      (anchor.getAttribute('href') || '').includes(hrefIncludes)
    );
  }

  function uniqueHrefCount(node, hrefIncludes) {
    return new Set(
      listingAnchors(node, hrefIncludes).map((anchor) => {
        const href = anchor.getAttribute('href') || '';
        return href.split('?')[0];
      })
    ).size;
  }

  function priceFromNode(node) {
    if (!node) return 0;
    const attrEls = node.querySelectorAll
      ? node.querySelectorAll(
          '[data-price], [data-amount], [itemprop="price"], [content][itemprop], [aria-label*="price" i], [class*="price" i]'
        )
      : [];
    for (const el of attrEls) {
      const parsed = parseMoney(
        el.getAttribute('content') ||
          el.getAttribute('data-price') ||
          el.getAttribute('data-amount') ||
          el.getAttribute('aria-label') ||
          el.textContent
      );
      if (parsed) return parsed;
    }

    const table = node.closest?.('table');
    if (table && (node.matches?.('tr') || node.closest?.('tr'))) {
      const row = node.matches('tr') ? node : node.closest('tr');
      const headers = [...table.querySelectorAll('th, [role="columnheader"]')].map((cell) =>
        (cell.textContent || '').toLowerCase()
      );
      const priceIdx = headers.findIndex((header) => /price/.test(header));
      if (priceIdx >= 0) {
        const cells = row.querySelectorAll('td, [role="cell"]');
        const parsed = parseMoney(cells[priceIdx]?.textContent);
        if (parsed) return parsed;
      }
    }

    return parseMoney(node.innerText || node.textContent || '');
  }

  function findListingCard(anchor, { hrefIncludes } = {}) {
    const specific = anchor.closest(
      'tr, li, article, [role="row"], [role="listitem"], [data-testid*="listing" i], [data-testid*="item" i]'
    );
    if (specific && uniqueHrefCount(specific, hrefIncludes || '/') <= 3) {
      const priced = priceFromNode(specific);
      if (priced) return specific;
    }

    let node = anchor.parentElement;
    let fallback = specific || node;
    while (node && node !== document.body && node !== document.documentElement) {
      const hrefCount = hrefIncludes ? uniqueHrefCount(node, hrefIncludes) : 1;
      if (hrefCount > 3) break;

      const priced = priceFromNode(node);
      if (priced && hrefCount <= 2) return node;

      if (node.matches?.('tr, li, article, [role="row"], [role="listitem"]')) {
        fallback = node;
        if (priced) return node;
      }

      const text = node.innerText || '';
      if (text.length > 4000) break;
      node = node.parentElement;
    }
    return fallback || anchor.parentElement || anchor;
  }

  function normalizeImageCandidate(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    if (value.startsWith('//')) return `https:${value}`;
    return value;
  }

  function isUsefulImage(url) {
    const normalized = normalizeImageCandidate(url);
    if (!normalized || !/^https?:/i.test(normalized)) return false;
    return !/data:image|placehold\.co|via\.placeholder|placeholder|blank\.gif|spacer|pixel|1x1|sprite|rs\/v\/|ebaystatic\.com\/rs/i.test(
      normalized
    );
  }

  function upgradeImageUrl(url) {
    return normalizeImageCandidate(url)
      .replace(/s-l\d+\./i, 's-l500.')
      .replace(/\/s-\w\d+\./i, '/s-l500.');
  }

  function srcsetUrls(value) {
    return String(value || '')
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  function backgroundImageUrls(node) {
    const urls = [];
    const style = `${node?.getAttribute?.('style') || ''} ${node?.style?.backgroundImage || ''}`;
    for (const match of style.matchAll(/url\((['"]?)([^'")]+)\1\)/gi)) {
      if (match[2]) urls.push(match[2]);
    }
    return urls;
  }

  function extractImagesFromNode(root, limit, seen, urls) {
    const imgs = [...(root?.querySelectorAll?.('img') || [])];
    for (const img of imgs) {
      const candidates = [
        img.currentSrc,
        img.src,
        img.getAttribute('data-src'),
        img.getAttribute('data-original'),
        img.getAttribute('data-img-src'),
        img.getAttribute('data-lazy'),
        img.getAttribute('data-thumb'),
        img.getAttribute('data-thumbnail'),
        ...srcsetUrls(img.getAttribute('srcset') || img.srcset),
        ...srcsetUrls(img.getAttribute('data-srcset')),
        ...backgroundImageUrls(img),
      ];
      for (const candidate of candidates) {
        if (!isUsefulImage(candidate)) continue;
        const upgraded = upgradeImageUrl(candidate);
        if (seen.has(upgraded)) continue;
        seen.add(upgraded);
        urls.push(upgraded);
        if (urls.length >= limit) return urls;
      }
    }

    const styled = [root, ...(root?.querySelectorAll?.('[style*="background"]') || [])];
    for (const node of styled) {
      for (const candidate of backgroundImageUrls(node)) {
        if (!isUsefulImage(candidate)) continue;
        const upgraded = upgradeImageUrl(candidate);
        if (seen.has(upgraded)) continue;
        seen.add(upgraded);
        urls.push(upgraded);
        if (urls.length >= limit) return urls;
      }
    }
    return urls;
  }

  function extractImages(root, limit = 4) {
    const urls = [];
    const seen = new Set();
    extractImagesFromNode(root, limit, seen, urls);
    if (urls.length >= limit) return urls;
    const row = root?.closest?.('tr, [role="row"], li, article');
    if (row && row !== root) extractImagesFromNode(row, limit, seen, urls);
    return urls;
  }

  function titleFromCard(card, anchor, fallback) {
    const img = card?.querySelector?.('img');
    const heading = card?.querySelector?.(
      'h1, h2, h3, h4, [class*="title" i], [data-testid*="title" i]'
    );
    const candidates = [
      heading?.textContent,
      img?.alt,
      img?.getAttribute('aria-label'),
      anchor?.getAttribute('aria-label'),
      anchor?.getAttribute('title'),
      anchor?.textContent,
    ];
    for (const candidate of candidates) {
      const title = cleanTitle(candidate);
      if (title && !isJunkTitle(title)) return title.slice(0, 140);
    }

    const cardText = cleanTitle(
      String(card?.innerText || '')
        .replace(PRICE_RE, ' ')
        .replace(DECIMAL_RE, ' ')
    );
    if (cardText && !isJunkTitle(cardText)) return cardText.slice(0, 140);
    return fallback;
  }

  function quantityFromNode(node) {
    const text = node?.innerText || '';
    const match = text.match(/(?:qty|quantity|available)[:\s]*(\d+)/i);
    return match ? parseInt(match[1], 10) : 1;
  }

  function walkJson(node, visit, seen = new Set(), depth = 0, maxDepth = 14) {
    if (!node || depth > maxDepth || seen.has(node)) return;
    if (typeof node !== 'object') return;
    seen.add(node);
    visit(node);
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const value of values) walkJson(value, visit, seen, depth + 1, maxDepth);
  }

  function listingsFromEmbeddedJson(matcher, { maxDepth = 14, scriptFilter } = {}) {
    const listings = [];
    const seen = new Set();
    const scripts = document.querySelectorAll(
      'script#__NEXT_DATA__, script[type="application/json"], script[type="application/ld+json"]'
    );
    for (const script of scripts) {
      const text = script.textContent || '';
      if (text.length < 20 || text.length > 6_000_000) continue;
      if (scriptFilter && !scriptFilter(text)) continue;
      try {
        walkJson(
          JSON.parse(text),
          (obj) => {
            const listing = matcher(obj);
            const key = listing?.platformListingId || listing?.id;
            if (!listing || !key || seen.has(key)) return;
            seen.add(key);
            listings.push(listing);
          },
          new Set(),
          0,
          maxDepth
        );
      } catch (_error) {
        // Ignore invalid JSON blobs.
      }
    }
    return listings;
  }

  function buildListing(fields) {
    return {
      id: fields.id,
      title: fields.title || 'Untitled Item',
      description: fields.description || '',
      price: Number(fields.price) || 0,
      quantity: fields.quantity || 1,
      images: (fields.images || []).filter(Boolean),
      platform: fields.platform,
      platformListingId: fields.platformListingId,
      status: fields.status || 'active',
      url: fields.url,
      lastUpdated: new Date().toISOString(),
    };
  }

  root.CrosslistScrape = {
    parseMoney,
    parseApiMoney,
    cleanTitle,
    isJunkTitle,
    findListingCard,
    priceFromNode,
    extractImages,
    titleFromCard,
    quantityFromNode,
    listingsFromEmbeddedJson,
    buildListing,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
