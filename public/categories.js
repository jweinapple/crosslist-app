/*
 * Item categories for the Add Items form: pick what you're selling and the form asks the
 * questions that matter for it (phone model, furniture size, event date, ...).
 * Category + details are stored on the item by the server; nothing here talks to a store.
 */
(function () {
  'use strict';

  var CATEGORIES = {
    clothing:  { label: 'Clothing & shoes', titleHint: 'e.g. Levi’s 501 jeans, 32×30', descHint: 'Fit, fabric, any flaws or wear.',
                 fields: [['brand', 'Brand'], ['size', 'Size'], ['color', 'Color']] },
    furniture: { label: 'Furniture', titleHint: 'e.g. Mid-century walnut dresser, 6 drawers', descHint: 'Age, material, any scratches or repairs.',
                 fields: [['dimensions', 'Size (width × depth × height)', 'e.g. 60 × 18 × 32 in'], ['material', 'Material', 'e.g. Walnut'],
                          ['handoff', 'How will the buyer get it?', '', ['Local pickup only', 'Can ship', 'Either']]] },
    home:      { label: 'Home & decor', titleHint: 'e.g. Wool area rug, 5×8, cream', descHint: 'Material, size, condition.',
                 fields: [['brand', 'Brand'], ['size', 'Size', 'e.g. 5 × 8 ft'], ['material', 'Material']] },
    tech:      { label: 'Phones & tech', titleHint: 'e.g. iPhone 14 Pro 256GB, unlocked', descHint: 'Battery health, screen condition, what’s in the box.',
                 fields: [['brand', 'Brand', 'e.g. Apple'], ['model', 'Model', 'e.g. iPhone 14 Pro'], ['storage', 'Storage', 'e.g. 256 GB'],
                          ['carrier', 'Carrier', '', ['Unlocked', 'Verizon', 'AT&T', 'T-Mobile', 'Other']]] },
    tickets:   { label: 'Event tickets', titleHint: 'e.g. Taylor Swift, Sat Aug 9, Section 112 Row 8', descHint: 'Anything the buyer should know about the seats or entry.',
                 fields: [['event', 'Event', 'e.g. Taylor Swift'], ['date', 'Date', 'e.g. Aug 9, 2026'], ['venue', 'Venue'], ['seats', 'Section, row and seats', 'e.g. Sec 112, Row 8, Seats 5–6'],
                          ['delivery', 'How are the tickets delivered?', '', ['Mobile transfer', 'PDF', 'Other']]],
                 note: 'Some ticket sites limit resale or how tickets can be transferred. Check the rules for where you bought them before you post.' },
    music:     { label: 'Music & gear', titleHint: 'e.g. Fender Player Stratocaster, sunburst', descHint: 'Make, model, year, and any wear or modifications.',
                 fields: [['brand', 'Make / brand', 'e.g. Fender'], ['model', 'Model', 'e.g. Stratocaster'], ['year', 'Year', 'e.g. 2019']] },
    other:     { label: 'Something else', titleHint: 'Item title', descHint: 'Item description', fields: [] }
  };
  var ORDER = ['clothing', 'furniture', 'home', 'tech', 'tickets', 'music', 'other'];

  // used by the inventory list
  window.categoryLabel = function (key) { return (CATEGORIES[key] || {}).label || ''; };
  window.CROSSLIST_CATEGORIES = ORDER.map(function (k) { return { id: k, label: CATEGORIES[k].label }; });

  var sel = document.getElementById('bulk-item-category');
  var box = document.getElementById('bulk-item-details');
  var title = document.getElementById('bulk-item-title');
  var desc = document.getElementById('bulk-item-description');
  if (!sel || !box) return;

  ORDER.forEach(function (k) {
    var o = document.createElement('option');
    o.value = k; o.textContent = CATEGORIES[k].label;
    sel.appendChild(o);
  });
  sel.value = 'other';

  function renderFields() {
    var cat = CATEGORIES[sel.value] || CATEGORIES.other;
    title.placeholder = cat.titleHint;
    desc.placeholder = cat.descHint;
    box.textContent = '';
    cat.fields.forEach(function (f) {
      var wrap = document.createElement('div');
      wrap.className = 'form-group';
      var id = 'bulk-detail-' + f[0];
      var label = document.createElement('label');
      label.setAttribute('for', id); label.textContent = f[1];
      var input;
      if (f[3]) {
        input = document.createElement('select');
        input.className = 'inventory-select';
        f[3].forEach(function (opt) { var o = document.createElement('option'); o.value = opt; o.textContent = opt; input.appendChild(o); });
      } else {
        input = document.createElement('input'); input.type = 'text'; input.placeholder = f[2] || '';
      }
      input.id = id; input.setAttribute('data-detail', f[0]);
      wrap.appendChild(label); wrap.appendChild(input);
      box.appendChild(wrap);
    });
    if (cat.note) {
      var n = document.createElement('p');
      n.className = 'category-note'; n.textContent = cat.note;
      box.appendChild(n);
    }
  }
  sel.addEventListener('change', renderFields);
  renderFields();

  function collect() {
    var details = {};
    Array.prototype.forEach.call(box.querySelectorAll('[data-detail]'), function (el) {
      var v = String(el.value || '').trim();
      if (v) details[el.getAttribute('data-detail')] = v;
    });
    return { category: sel.value, details: details };
  }

  // send category + details along with the new item
  window.createInventoryItem = async function (item) {
    var extra = collect();
    return apiFetch('/api/listings', {
      method: 'POST',
      body: JSON.stringify(Object.assign({}, item, extra))
    });
  };

  // clear the extra fields whenever the form is reset
  var origReset = window.resetBulkListingForm;
  window.resetBulkListingForm = function () {
    if (typeof origReset === 'function') origReset.apply(this, arguments);
    sel.value = 'other';
    renderFields();
  };

  // ---- arriving from the Sell page: fill the form so the person only has to press "list" ----
  var intent = null;
  try {
    var raw = sessionStorage.getItem('crosslist_sell_intent');
    if (raw) { intent = JSON.parse(raw); sessionStorage.removeItem('crosslist_sell_intent'); }
  } catch (e) { intent = null; }

  if (intent && typeof intent === 'object') {
    if (CATEGORIES[intent.category]) { sel.value = intent.category; renderFields(); }
    if (intent.title) title.value = String(intent.title).slice(0, 200);
    var priceEl = document.getElementById('bulk-item-price');
    if (priceEl && intent.price !== undefined && intent.price !== '') priceEl.value = intent.price;
    if (typeof intent.photo === 'string' && intent.photo.indexOf('data:image/') === 0 && typeof addBulkPhotos === 'function') {
      fetch(intent.photo).then(function (r) { return r.blob(); }).then(function (blob) {
        addBulkPhotos([new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' })]);
      }).catch(function () { /* photo is optional: the form still works without it */ });
    }
    // if they still need to sign in, say so in plain words instead of showing a generic login
    var sayAlmostDone = function () {
      var copy = document.getElementById('auth-copy');
      if (copy) copy.textContent = 'Almost done. Sign in to post your item. Your photo and details are saved.';
    };
    sayAlmostDone();
    if (typeof window.setAuthMode === 'function') {
      var origMode = window.setAuthMode;
      window.setAuthMode = function () { origMode.apply(this, arguments); sayAlmostDone(); };
    }
  }
})();
