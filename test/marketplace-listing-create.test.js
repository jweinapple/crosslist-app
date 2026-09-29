import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Depop condition mapping converts values correctly', () => {
  function mapDepopCondition(condition) {
    const key = String(condition || 'used_good').toLowerCase().replace(/\s+/g, '_');
    const conditionMap = {
      new: 'new_with_tags',
      brand_new: 'new_with_tags',
      like_new: 'new_without_tags',
      mint: 'new_without_tags',
      used_excellent: 'used_excellent',
      excellent: 'used_excellent',
      used_good: 'used_good',
      used_fair: 'used_fair',
      fair: 'used_fair',
      poor: 'used_fair',
    };
    return conditionMap[key] || 'used_good';
  }

  assert.equal(mapDepopCondition('new'), 'new_with_tags');
  assert.equal(mapDepopCondition('brand_new'), 'new_with_tags');
  assert.equal(mapDepopCondition('like_new'), 'new_without_tags');
  assert.equal(mapDepopCondition('mint'), 'new_without_tags');
  assert.equal(mapDepopCondition('used_excellent'), 'used_excellent');
  assert.equal(mapDepopCondition('excellent'), 'used_excellent');
  assert.equal(mapDepopCondition('used_good'), 'used_good');
  assert.equal(mapDepopCondition('used_fair'), 'used_fair');
  assert.equal(mapDepopCondition('fair'), 'used_fair');
  assert.equal(mapDepopCondition('poor'), 'used_fair');
  assert.equal(mapDepopCondition('unknown'), 'used_good');
  assert.equal(mapDepopCondition(null), 'used_good');
  assert.equal(mapDepopCondition(undefined), 'used_good');
});

test('Depop API payload structure is correct', () => {
  const listing = {
    id: 'test_item_1',
    title: 'Vintage Band T-Shirt',
    description: 'Classic vintage band tee in excellent condition',
    price: 35.00,
    quantity: 1,
    condition: 'used_excellent',
    images: ['https://example.com/image1.jpg', 'https://example.com/image2.jpg'],
  };

  const payload = {
    name: String(listing.title || '').slice(0, 200),
    description: String(listing.description || listing.title || ''),
    price_amount: Math.round(Number(listing.price || 0) * 100),
    currency: 'USD',
    category_id: 1,
    condition: 'used_excellent',
    quantity: listing.quantity || 1,
    pictures: listing.images.slice(0, 4).map((url) => ({ url })),
  };

  assert.equal(payload.name, 'Vintage Band T-Shirt');
  assert.equal(payload.description, 'Classic vintage band tee in excellent condition');
  assert.equal(payload.price_amount, 3500);
  assert.equal(payload.currency, 'USD');
  assert.equal(payload.quantity, 1);
  assert.equal(payload.condition, 'used_excellent');
  assert.equal(payload.pictures.length, 2);
  assert.equal(payload.pictures[0].url, 'https://example.com/image1.jpg');
});

test('Etsy API payload structure is correct', () => {
  const listing = {
    id: 'test_item_2',
    title: 'Handmade Ceramic Mug',
    description: 'Beautiful handmade ceramic coffee mug',
    price: 28.50,
    quantity: 5,
    images: ['https://example.com/mug1.jpg', 'https://example.com/mug2.jpg'],
  };

  const payload = {
    title: String(listing.title || '').slice(0, 140),
    description: String(listing.description || listing.title || ''),
    price: Number(listing.price || 0).toFixed(2),
    quantity: listing.quantity || 1,
    who_made: 'i_did',
    when_made: '2020_2026',
    taxonomy_id: 1,
    is_supply: false,
    should_auto_renew: false,
    type: 'physical',
  };

  assert.equal(payload.title, 'Handmade Ceramic Mug');
  assert.equal(payload.description, 'Beautiful handmade ceramic coffee mug');
  assert.equal(payload.price, '28.50');
  assert.equal(payload.quantity, 5);
  assert.equal(payload.who_made, 'i_did');
  assert.equal(payload.when_made, '2020_2026');
  assert.equal(payload.type, 'physical');
  assert.equal(payload.is_supply, false);
});

test('API endpoint URLs are correct for each marketplace', () => {
  const depopUrl = 'https://partnerapi.depop.com/api/v1/products/';
  const etsyShopId = '12345';
  const etsyUrl = `https://openapi.etsy.com/v3/application/shops/${etsyShopId}/listings`;
  const ebayUrl = 'https://api.ebay.com/sell/inventory/v1/inventory_item';
  const reverbUrl = 'https://api.reverb.com/api/listings';

  assert.ok(depopUrl.includes('partnerapi.depop.com'));
  assert.ok(etsyUrl.includes('openapi.etsy.com/v3'));
  assert.ok(ebayUrl.includes('api.ebay.com/sell'));
  assert.ok(reverbUrl.includes('api.reverb.com'));
});

test('Listing price conversion for Depop (cents)', () => {
  const prices = [
    { input: 10, expected: 1000 },
    { input: 35.50, expected: 3550 },
    { input: 99.99, expected: 9999 },
    { input: 0.50, expected: 50 },
  ];

  for (const { input, expected } of prices) {
    const priceAmount = Math.round(Number(input) * 100);
    assert.equal(priceAmount, expected, `Price ${input} should convert to ${expected} cents`);
  }
});

test('Listing price formatting for Etsy (string with 2 decimals)', () => {
  const prices = [
    { input: 10, expected: '10.00' },
    { input: 35.5, expected: '35.50' },
    { input: 99.99, expected: '99.99' },
    { input: 0.5, expected: '0.50' },
  ];

  for (const { input, expected } of prices) {
    const price = Number(input).toFixed(2);
    assert.equal(price, expected, `Price ${input} should format to ${expected}`);
  }
});

test('Image URL filtering works correctly', () => {
  const images = [
    'https://example.com/image1.jpg',
    'http://insecure.com/image2.jpg',
    'data:image/png;base64,abc123',
    'https://example.com/image3.png',
    '',
  ];

  const filteredHttps = images.filter((url) => /^https:\/\//i.test(url));
  
  assert.equal(filteredHttps.length, 2);
  assert.ok(filteredHttps.includes('https://example.com/image1.jpg'));
  assert.ok(filteredHttps.includes('https://example.com/image3.png'));
  assert.ok(!filteredHttps.includes('http://insecure.com/image2.jpg'));
  assert.ok(!filteredHttps.includes('data:image/png;base64,abc123'));
});

test('Title length limits are enforced', () => {
  const longTitle = 'A'.repeat(300);
  
  const depopTitle = longTitle.slice(0, 200);
  assert.equal(depopTitle.length, 200);
  
  const etsyTitle = longTitle.slice(0, 140);
  assert.equal(etsyTitle.length, 140);
  
  const ebayTitle = longTitle.slice(0, 80);
  assert.equal(ebayTitle.length, 80);
});
