/*
 * Crosslist "get going" panel for the My Items page.
 * Shows setup progress, one obvious next step, and live stats — all computed from the user's
 * real data (no made-up numbers). Reads the dashboard's globals (`listings`, `marketplaceAuth`)
 * and never writes to them.
 */
(function () {
  'use strict';

  var root = document.getElementById('engage-root');
  if (!root) return;

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var STORES = ['ebay', 'facebook', 'depop', 'poshmark', 'etsy'];
  var STEP_LABELS = ['Create your account', 'Link a store', 'Add an item', 'Post on 2 stores'];
  var RING_R = 34;
  var RING_C = 2 * Math.PI * RING_R;

  var firstName = '';
  var lastSig = null;
  var built = false;
  var els = {};
  var shown = { items: 0, value: 0, stores: 0, toPost: 0 };

  // ---------- read the app's state ----------
  function read() {
    var L = [];
    var A = {};
    try { if (typeof listings !== 'undefined' && Array.isArray(listings)) L = listings; } catch (e) {}
    try { if (typeof marketplaceAuth !== 'undefined' && marketplaceAuth) A = marketplaceAuth; } catch (e) {}

    var connected = STORES.filter(function (p) { return A[p] && A[p].connected; });
    var value = 0;
    var multi = false;
    var toPost = 0;
    L.forEach(function (item) {
      var price = parseFloat(item && item.price);
      if (isFinite(price)) value += price;
      var on = item && item.platforms && typeof item.platforms === 'object' ? Object.keys(item.platforms) : [];
      if (on.length >= 2) multi = true;
      connected.forEach(function (p) { if (on.indexOf(p) === -1) toPost += 1; });
    });
    return { items: L.length, value: Math.round(value), stores: connected.length, storeNames: connected, multi: multi, toPost: toPost };
  }

  function stepsDone(s) { return [true, s.stores > 0, s.items > 0, s.multi]; }

  function nextAction(s) {
    if (s.stores === 0) {
      return { title: 'Link your first store', sub: 'Connect one of your accounts so your items have somewhere to go.', cta: 'Link a store', go: function () { showDashboardSection('marketplaces'); } };
    }
    if (s.items === 0) {
      return { title: 'Add your first item', sub: 'Add photos and a price once, then choose which stores to post it on.', cta: 'Add an item', go: function () { showDashboardSection('list'); } };
    }
    if (!s.multi) {
      return s.stores < 2
        ? { title: 'Sell in a second place', sub: 'Listing in more than one place puts your items in front of more buyers.', cta: 'Link another store', go: function () { showDashboardSection('marketplaces'); } }
        : { title: 'Post an item on 2 stores', sub: 'Choose two stores when you add your next item.', cta: 'Add an item', go: function () { showDashboardSection('list'); } };
    }
    if (s.toPost > 0) {
      return {
        title: s.toPost + (s.toPost === 1 ? ' item isn’t' : ' items aren’t') + ' on all your stores yet',
        sub: 'Look for the blue “Connect” buttons below to post them.',
        cta: 'Show me',
        go: function () {
          var btn = document.querySelector('.inv-list-btn');
          if (btn) {
            btn.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
            btn.classList.add('engage-pulse');
            setTimeout(function () { btn.classList.remove('engage-pulse'); }, 2600);
          } else { showDashboardSection('list'); }
        }
      };
    }
    return { title: 'Your shop is set up', sub: 'Your items are listed. Add more whenever you’re ready.', cta: 'Add another item', go: function () { showDashboardSection('list'); } };
  }

  // ---------- build the panel once ----------
  function build() {
    root.innerHTML =
      '<div class="engage">' +
        '<div class="engage-hero" style="--i:0">' +
          '<div class="engage-hero-text">' +
            '<div class="engage-hi"></div>' +
            '<h2 class="engage-title"></h2>' +
            '<p class="engage-sub"></p>' +
            '<button type="button" class="engage-cta"><span class="engage-cta-label"></span><span aria-hidden="true">&rarr;</span></button>' +
          '</div>' +
          '<div class="engage-progress">' +
            '<div class="engage-ring" role="img">' +
              '<svg viewBox="0 0 80 80" aria-hidden="true"><circle class="engage-ring-bg" cx="40" cy="40" r="' + RING_R + '"/><circle class="engage-ring-fg" cx="40" cy="40" r="' + RING_R + '" stroke-dasharray="' + RING_C.toFixed(2) + '" stroke-dashoffset="' + RING_C.toFixed(2) + '"/></svg>' +
              '<div class="engage-ring-num"></div>' +
            '</div>' +
            '<ol class="engage-steps"></ol>' +
          '</div>' +
        '</div>' +
        '<div class="engage-stats">' +
          '<button type="button" class="engage-stat" data-go="items" style="--i:1"><span class="engage-stat-num" data-k="items">0</span><span class="engage-stat-label">Items you’re selling</span></button>' +
          '<div class="engage-stat" style="--i:2"><span class="engage-stat-num" data-k="value">$0</span><span class="engage-stat-label">Total value of your items</span></div>' +
          '<button type="button" class="engage-stat" data-go="marketplaces" style="--i:3"><span class="engage-stat-num" data-k="stores">0</span><span class="engage-stat-label">Stores linked</span></button>' +
          '<div class="engage-stat" style="--i:4"><span class="engage-stat-num" data-k="toPost">0</span><span class="engage-stat-label">Waiting to be posted</span></div>' +
        '</div>' +
      '</div>';

    els.hi = root.querySelector('.engage-hi');
    els.title = root.querySelector('.engage-title');
    els.sub = root.querySelector('.engage-sub');
    els.cta = root.querySelector('.engage-cta');
    els.ctaLabel = root.querySelector('.engage-cta-label');
    els.ring = root.querySelector('.engage-ring-fg');
    els.ringWrap = root.querySelector('.engage-ring');
    els.ringNum = root.querySelector('.engage-ring-num');
    els.steps = root.querySelector('.engage-steps');
    els.nums = {};
    Array.prototype.forEach.call(root.querySelectorAll('.engage-stat-num'), function (n) { els.nums[n.getAttribute('data-k')] = n; });

    STEP_LABELS.forEach(function () { els.steps.appendChild(document.createElement('li')); });

    Array.prototype.forEach.call(root.querySelectorAll('[data-go]'), function (b) {
      b.addEventListener('click', function () { showDashboardSection(b.getAttribute('data-go')); });
    });
    built = true;
  }

  // ---------- numbers that count up ----------
  function format(key, n) { return key === 'value' ? '$' + n.toLocaleString() : String(n); }
  function countTo(key, target) {
    var el = els.nums[key];
    if (!el) return;
    var from = shown[key];
    shown[key] = target;
    if (reduceMotion || from === target) { el.textContent = format(key, target); return; }
    var start = null;
    var dur = 900;
    function frame(t) {
      if (start === null) start = t;
      var p = Math.min(1, (t - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = format(key, Math.round(from + (target - from) * eased));
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ---------- render ----------
  function render(s, animateEntrance) {
    if (!built) build();
    var done = stepsDone(s);
    var count = done.filter(Boolean).length;
    var act = nextAction(s);

    els.hi.textContent = firstName ? 'Welcome back, ' + firstName : 'Welcome back';
    els.title.textContent = act.title;
    els.sub.textContent = act.sub;
    els.ctaLabel.textContent = act.cta;
    els.cta.onclick = act.go;

    els.ringNum.textContent = count + '/4';
    els.ringWrap.setAttribute('aria-label', count + ' of 4 setup steps done');
    els.ring.style.strokeDashoffset = (RING_C * (1 - count / 4)).toFixed(2);

    Array.prototype.forEach.call(els.steps.children, function (li, i) {
      li.className = done[i] ? 'is-done' : (i === done.indexOf(false) ? 'is-next' : '');
      li.textContent = STEP_LABELS[i];
    });

    countTo('items', s.items); countTo('value', s.value); countTo('stores', s.stores); countTo('toPost', s.toPost);

    // confirm real progress only (never on first ever load, never on plain reloads)
    try {
      var key = 'crosslist_setup_steps';
      var prev = parseInt(localStorage.getItem(key), 10);
      if (isFinite(prev) && count > prev) {
        if (typeof showToast === 'function') showToast(count === 4 ? 'Setup complete' : 'Step done: ' + count + ' of 4', 'success');
      }
      localStorage.setItem(key, String(count));
    } catch (e) { /* storage blocked: skip celebrations */ }

    if (animateEntrance && !reduceMotion) root.classList.add('is-entering');
  }

  function tick() {
    var authGate = document.getElementById('auth-gate');
    var loggedIn = !authGate || !authGate.classList.contains('visible');
    root.hidden = !loggedIn;
    if (!loggedIn) return;
    var s = read();
    var sig = [s.items, s.value, s.stores, s.multi, s.toPost, firstName].join('|');
    if (sig === lastSig) return;
    var first = lastSig === null;
    lastSig = sig;
    render(s, first);
  }

  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (d && d.user) firstName = String(d.user.name || '').trim().split(/\s+/)[0] || '';
      lastSig = null; tick();
    })
    .catch(function () {});

  setInterval(tick, 700);
  tick();
})();
