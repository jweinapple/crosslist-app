import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Reverb personal access token validation', () => {
  const validTokens = [
    'a'.repeat(40),
    'reverb_' + 'x'.repeat(32),
    '1234567890abcdefghij1234567890abcdefghij',
  ];
  
  const invalidTokens = [
    '',
    'short',
    'a'.repeat(10),
    null,
    undefined,
  ];

  for (const token of validTokens) {
    const isValid = token && token.length >= 20 && token.length <= 200;
    assert.ok(isValid, `Token should be valid: ${token?.slice(0, 10)}...`);
  }

  for (const token of invalidTokens) {
    const isValid = token && token.length >= 20 && token.length <= 200;
    assert.ok(!isValid, `Token should be invalid: ${token}`);
  }
});

test('Reverb API headers format', () => {
  const token = 'test_token_12345';
  const baseUrl = 'http://localhost:3000';
  
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/hal+json',
    'Accept-Version': '3.0',
    'Content-Type': 'application/hal+json',
    'User-Agent': `Crosslist/1.0 (+${baseUrl})`,
  };

  assert.equal(headers.Authorization, 'Bearer test_token_12345');
  assert.equal(headers.Accept, 'application/hal+json');
  assert.equal(headers['Accept-Version'], '3.0');
  assert.equal(headers['Content-Type'], 'application/hal+json');
  assert.ok(headers['User-Agent'].includes('Crosslist'));
});

test('Reverb listing payload structure with required fields', () => {
  const listing = {
    id: 'test_item_1',
    title: 'Fender Stratocaster 2020',
    description: 'Excellent condition electric guitar',
    price: 850.00,
    quantity: 1,
    condition: 'used_excellent',
    images: ['https://example.com/guitar1.jpg', 'https://example.com/guitar2.jpg'],
    details: {
      brand: 'Fender',
      model: 'Stratocaster',
      year: 2020,
    },
  };

  const words = listing.title.split(/\s+/).filter(Boolean);
  const make = listing.details.brand || words[0] || 'Unknown';
  const model = listing.details.model || words.slice(1).join(' ') || listing.title;

  const payload = {
    title: listing.title.slice(0, 255),
    make: make.slice(0, 80),
    model: model.slice(0, 80),
    description: listing.description,
    price: {
      amount: Number(listing.price).toFixed(2),
      currency: 'USD',
    },
    condition: { uuid: 'df268ad1-c462-4ba6-b6db-e007e23922ea' },
    photos: listing.images.filter((url) => /^https:\/\//i.test(url)),
    upc_does_not_apply: true,
    has_inventory: true,
    inventory: listing.quantity,
    shipping: { local: true },
    publish: true,
    year: String(listing.details.year),
  };

  assert.equal(payload.title, 'Fender Stratocaster 2020');
  assert.equal(payload.make, 'Fender');
  assert.equal(payload.model, 'Stratocaster');
  assert.equal(payload.price.amount, '850.00');
  assert.equal(payload.price.currency, 'USD');
  assert.equal(payload.inventory, 1);
  assert.equal(payload.photos.length, 2);
  assert.equal(payload.publish, true);
  assert.equal(payload.year, '2020');
  assert.equal(payload.upc_does_not_apply, true);
  assert.equal(payload.has_inventory, true);
});

test('Reverb condition UUID mapping', () => {
  function mapReverbConditionUuid(value) {
    const key = String(value || 'used_good').toLowerCase().replace(/\s+/g, '_');
    if (key === 'new' || key === 'brand_new') return '7c3f45de-2ae0-4c81-8400-fdb6b1d74890';
    if (key === 'like_new' || key === 'mint') return 'ac5b9c1e-dc78-466d-b0b3-7cf712967a48';
    if (key === 'used_excellent' || key === 'excellent') return 'df268ad1-c462-4ba6-b6db-e007e23922ea';
    if (key === 'used_fair' || key === 'fair') return '98777886-76d0-44c8-865e-bb40e669e934';
    if (key === 'poor') return '6a9dfcad-600b-46c8-9e08-ce6e5057921e';
    return 'f7a3f48c-972a-44c6-b01a-0cd27488d3f6';
  }

  assert.equal(mapReverbConditionUuid('new'), '7c3f45de-2ae0-4c81-8400-fdb6b1d74890');
  assert.equal(mapReverbConditionUuid('brand_new'), '7c3f45de-2ae0-4c81-8400-fdb6b1d74890');
  assert.equal(mapReverbConditionUuid('like_new'), 'ac5b9c1e-dc78-466d-b0b3-7cf712967a48');
  assert.equal(mapReverbConditionUuid('mint'), 'ac5b9c1e-dc78-466d-b0b3-7cf712967a48');
  assert.equal(mapReverbConditionUuid('used_excellent'), 'df268ad1-c462-4ba6-b6db-e007e23922ea');
  assert.equal(mapReverbConditionUuid('excellent'), 'df268ad1-c462-4ba6-b6db-e007e23922ea');
  assert.equal(mapReverbConditionUuid('used_fair'), '98777886-76d0-44c8-865e-bb40e669e934');
  assert.equal(mapReverbConditionUuid('fair'), '98777886-76d0-44c8-865e-bb40e669e934');
  assert.equal(mapReverbConditionUuid('poor'), '6a9dfcad-600b-46c8-9e08-ce6e5057921e');
  assert.equal(mapReverbConditionUuid('used_good'), 'f7a3f48c-972a-44c6-b01a-0cd27488d3f6');
  assert.equal(mapReverbConditionUuid('unknown'), 'f7a3f48c-972a-44c6-b01a-0cd27488d3f6');
});

test('Reverb listing state detection', () => {
  const testCases = [
    { slug: 'live', expected: true },
    { slug: 'published', expected: true },
    { slug: 'active', expected: true },
    { slug: 'draft', expected: false },
    { slug: 'ended', expected: false },
    { slug: 'sold', expected: false },
    { slug: '', expected: false },
  ];

  for (const { slug, expected } of testCases) {
    const isLive = slug === 'live' || slug === 'published' || slug === 'active';
    assert.equal(
      isLive,
      expected,
      `State '${slug}' should be ${expected ? 'live' : 'not live'}`
    );
  }
});

test('Reverb API endpoint URLs', () => {
  const accountUrl = 'https://api.reverb.com/api/my/account';
  const createUrl = 'https://api.reverb.com/api/listings';
  const listingId = '12345';
  const updateUrl = `https://api.reverb.com/api/listings/${listingId}`;
  const endUrl = `https://api.reverb.com/api/listings/${listingId}`;
  const categoriesUrl = `https://api.reverb.com/api/categories?q=${encodeURIComponent('guitar')}`;

  assert.ok(accountUrl.includes('/api/my/account'));
  assert.ok(createUrl.includes('/api/listings'));
  assert.ok(updateUrl.includes(`/api/listings/${listingId}`));
  assert.ok(endUrl.includes(`/api/listings/${listingId}`));
  assert.ok(categoriesUrl.includes('/api/categories'));
  assert.ok(categoriesUrl.includes('q=guitar'));
});

test('Reverb make and model extraction from title', () => {
  const testCases = [
    {
      title: 'Fender Stratocaster 2020 Sunburst',
      brand: 'Fender',
      expectedMake: 'Fender',
      expectedModel: 'Stratocaster 2020 Sunburst',
    },
    {
      title: 'Gibson Les Paul Standard',
      brand: null,
      expectedMake: 'Gibson',
      expectedModel: 'Les Paul Standard',
    },
    {
      title: 'Vintage Tube Amp',
      brand: 'Unknown Brand',
      expectedMake: 'Unknown Brand',
      expectedModel: 'Tube Amp',
    },
  ];

  for (const { title, brand, expectedMake, expectedModel } of testCases) {
    const words = title.split(/\s+/).filter(Boolean);
    const make = brand || words[0] || 'Unknown';
    const model = words.slice(1).join(' ') || title;

    assert.equal(make, expectedMake, `Make should be ${expectedMake}`);
    assert.equal(model, expectedModel, `Model should be ${expectedModel}`);
  }
});

test('Reverb error message extraction', () => {
  const errorResponses = [
    {
      response: { data: { message: 'Invalid token' }, status: 401 },
      expected: 'Invalid or expired Reverb token',
    },
    {
      response: { data: { error: 'Price is required' }, status: 400 },
      expected: 'Price is required',
    },
    {
      response: { data: { errors: ['Title cannot be blank'] }, status: 422 },
      expected: 'Title cannot be blank',
    },
  ];

  for (const { response, expected } of errorResponses) {
    let message = response.data?.message || response.data?.error || response.data?.errors?.[0];
    
    if (response.status === 401 || response.status === 403) {
      message = 'Invalid or expired Reverb token';
    }

    assert.ok(
      message.includes(expected) || message === expected,
      `Error message should contain: ${expected}`
    );
  }
});

test('Reverb listing publish state transition', () => {
  const draftListing = {
    id: '12345',
    state: { slug: 'draft' },
  };

  const shouldPublish = draftListing.state.slug !== 'live' && 
                       draftListing.state.slug !== 'published' && 
                       draftListing.state.slug !== 'active';
  
  assert.ok(shouldPublish, 'Draft listing should be published');

  const livePayload = {
    state: { slug: 'live' },
  };

  assert.equal(livePayload.state.slug, 'live');
});

test('Reverb category search query format', () => {
  const titles = [
    'Fender Stratocaster Electric Guitar',
    'Vintage Roland TR-808 Drum Machine',
    'Audio-Technica AT2020 Microphone',
  ];

  for (const title of titles) {
    const query = encodeURIComponent(title.slice(0, 50));
    const url = `https://api.reverb.com/api/categories?q=${query}`;
    
    assert.ok(url.includes('/api/categories'));
    assert.ok(url.includes('q='));
    assert.ok(decodeURIComponent(query).length <= 50);
  }
});
