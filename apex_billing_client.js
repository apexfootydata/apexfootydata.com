/* apex_billing_client.js — accounts + Stripe checkout wiring (2026-07-07)
 *
 * Client side of cloudflare_worker/apex_billing.js. Populates the entitlement
 * seam (assets/apex_entitlements.js): on success it sets
 *     window.APEX_USER = { tier: 'free'|'season' }
 *     window.APEX_ENTITLEMENT_READY = true
 * and the seam does the rest. On ANY failure it sets NOTHING, which by the
 * seam's own fail-open rule keeps a possibly-paying user unlocked. This file
 * never decides tier rules — it only reports identity.
 *
 * MASTER FLAG:  window.APEX_BILLING_LIVE === true   (deliberately NOT reusing
 * APEX_TIERS — accounts-live and gates-on are separate decisions). Default is
 * absent/false: this file then does NOTHING observable — no network, no DOM,
 * no storage reads beyond feature detection. Live behaviour is byte-identical
 * until the August flip (scripts/billing_flip.py --live).
 *
 * Storage:  localStorage apex_session_v1  (90-day HMAC session token)
 *           localStorage apex_email_hint  (display only — what the user typed)
 * Login flow: email -> POST /magic -> user clicks emailed link, which lands on
 * LOGIN_URL#apex_magic=<token> -> this file swaps it via POST /session for the
 * session token -> GET /entitlement resolves tier.
 *
 * Accepted risk (pricing playbook 2026-07-03): everything here is client-side
 * and bypassable. We gate identity + convenience, not secrets.
 */
(function () {
  "use strict";

  // Never let billing wiring break the solver, whatever happens below.
  try {

    var WORKER_URL = (typeof window.APEX_BILLING_URL === 'string' && window.APEX_BILLING_URL)
      ? window.APEX_BILLING_URL.replace(/\/+$/, '')
      : 'https://apex-billing.weathered-bird-16f4.workers.dev';

    var SESSION_KEY = 'apex_session_v1';
    var HINT_KEY = 'apex_email_hint';
    var PLANS = { monthly: '£3.50/month', season: '£22/season', founder: '£15 founder' };

    function live() { return window.APEX_BILLING_LIVE === true; }

    function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
    function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) {} }

    function post(path, body) {
      return window.fetch(WORKER_URL + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json(); });
    }

    function announce() {
      try {
        window.dispatchEvent(new CustomEvent('apex:entitlement', {
          detail: { tier: window.APEX_USER && window.APEX_USER.tier, ready: !!window.APEX_ENTITLEMENT_READY },
        }));
      } catch (e) {}
      try { renderMount(); } catch (e) {}
    }

    // ── entitlement refresh ─────────────────────────────────────────────────
    function refresh() {
      if (!live()) return Promise.resolve(null);
      var session = lsGet(SESSION_KEY);
      if (!session) {
        // Logged out is a KNOWN state: free, resolved.
        window.APEX_USER = { tier: 'free' };
        window.APEX_ENTITLEMENT_READY = true;
        announce();
        return Promise.resolve(window.APEX_USER);
      }
      return window.fetch(WORKER_URL + '/entitlement', {
        headers: { 'Authorization': 'Bearer ' + session },
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d || d.ready !== true) {
          // Worker could not resolve (KV read error -> {ready:false}) or spoke
          // garbage. Set NOTHING: the seam stays fail-open and a paying member
          // keeps access. Do NOT mark ready.
          return null;
        }
        if (d.authed === false) lsDel(SESSION_KEY);   // stale/expired token
        window.APEX_USER = { tier: d.tier === 'season' ? 'season' : 'free' };
        window.APEX_ENTITLEMENT_READY = true;
        announce();
        return window.APEX_USER;
      }).catch(function () { return null; });          // network down: seam fail-open
    }

    // ── magic-link landing (#apex_magic=... in the URL fragment) ────────────
    function consumeMagicFromHash() {
      if (!live()) return Promise.resolve(false);
      var m = null;
      try { m = String(window.location.hash || '').match(/apex_magic=([^&]+)/); } catch (e) {}
      if (!m) return Promise.resolve(false);
      // Strip the token from the URL immediately (before any await) so it never
      // lingers in the address bar / gets copied around.
      try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
      return post('/session', { token: m[1] }).then(function (d) {
        if (d && d.session) {
          lsSet(SESSION_KEY, d.session);
          toast('Signed in ✓');
          return true;
        }
        toast((d && d.error) || 'Sign-in link invalid or expired — request a new one.');
        return false;
      }).catch(function () { toast('Could not reach the sign-in service.'); return false; });
    }

    // ── public API ──────────────────────────────────────────────────────────
    function subscribe(plan) {
      if (!live()) return Promise.resolve({ error: 'billing not live' });
      plan = PLANS[plan] ? plan : 'season';
      var email = lsGet(HINT_KEY) || '';
      return post('/checkout', { plan: plan, email: email }).then(function (d) {
        if (d && d.url) { window.location.href = d.url; return d; }
        toast((d && d.error) || 'Checkout unavailable right now.');
        return d;
      }).catch(function () { toast('Could not reach checkout.'); return { error: 'network' }; });
    }

    function startLogin(email) {
      if (!live()) return Promise.resolve({ error: 'billing not live' });
      email = String(email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        toast('Enter a valid email address.');
        return Promise.resolve({ error: 'bad email' });
      }
      lsSet(HINT_KEY, email);
      return post('/magic', { email: email }).then(function (d) {
        if (d && d.ok) toast('Check your email — your sign-in link is on its way.');
        else toast((d && d.error) || 'Could not send the link.');
        return d;
      }).catch(function () { toast('Could not reach the sign-in service.'); return { error: 'network' }; });
    }

    function logout() {
      lsDel(SESSION_KEY);
      if (live()) {
        window.APEX_USER = { tier: 'free' };
        window.APEX_ENTITLEMENT_READY = true;
        announce();
      }
      return true;
    }

    function status() {
      return {
        live: live(),
        worker: WORKER_URL,
        loggedIn: !!lsGet(SESSION_KEY),
        emailHint: lsGet(HINT_KEY) || null,
        tier: (window.APEX_USER && window.APEX_USER.tier) || null,
        ready: !!window.APEX_ENTITLEMENT_READY,
      };
    }

    // ── minimal UI (brand: teal #1D9E75, cream, Plus Jakarta Sans) ──────────
    var _mount = null;

    function toast(msg) {
      if (!live()) return;
      try {
        var el = window.document.getElementById('apex-billing-toast');
        if (!el) {
          el = window.document.createElement('div');
          el.id = 'apex-billing-toast';
          el.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);' +
            'background:#12221d;color:#fff;padding:10px 18px;border-radius:10px;font-size:.85rem;' +
            'z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,.25);transition:opacity .3s;max-width:90vw;';
          window.document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        window.clearTimeout(el._t);
        el._t = window.setTimeout(function () { el.style.opacity = '0'; }, 4000);
      } catch (e) {}
    }

    function btnCss(primary) {
      return 'cursor:pointer;border-radius:9px;font-weight:700;font-size:.8rem;' +
        'padding:7px 14px;font-family:inherit;' +
        (primary ? 'background:#1D9E75;color:#fff;border:1px solid #1D9E75;'
                 : 'background:transparent;color:#1D9E75;border:1px solid #1D9E75;');
    }

    function renderMount() {
      if (!live() || !_mount) return;
      var s = status();
      var tierBadge = s.ready && s.tier === 'season'
        ? '<span style="background:#1D9E75;color:#fff;border-radius:7px;padding:3px 9px;font-size:.72rem;font-weight:800;">APEX MEMBER</span>'
        : '<span style="background:rgba(29,158,117,.12);color:#1D9E75;border-radius:7px;padding:3px 9px;font-size:.72rem;font-weight:800;">FREE</span>';
      if (s.loggedIn) {
        _mount.innerHTML =
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' + tierBadge +
          (s.emailHint ? '<span style="font-size:.78rem;color:#7a8783;">' + escapeHtml(s.emailHint) + '</span>' : '') +
          (s.tier !== 'season' ? '<button id="apex-bill-sub" style="' + btnCss(true) + '">Get Apex — £22/season</button>' : '') +
          '<button id="apex-bill-out" style="' + btnCss(false) + '">Log out</button></div>';
        wire('apex-bill-sub', function () { openModal('subscribe'); });
        wire('apex-bill-out', function () { logout(); });
      } else {
        _mount.innerHTML =
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
          '<button id="apex-bill-sub" style="' + btnCss(true) + '">Get Apex — £22/season</button>' +
          '<button id="apex-bill-in" style="' + btnCss(false) + '">Log in / Restore purchase</button></div>';
        wire('apex-bill-sub', function () { openModal('subscribe'); });
        wire('apex-bill-in', function () { openModal('login'); });
      }
    }

    function wire(id, fn) {
      try {
        var el = window.document.getElementById(id);
        if (el) el.onclick = fn;
      } catch (e) {}
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function openModal(mode) {
      try {
        var old = window.document.getElementById('apex-billing-modal');
        if (old) old.parentNode.removeChild(old);
        var wrap = window.document.createElement('div');
        wrap.id = 'apex-billing-modal';
        wrap.style.cssText = 'position:fixed;inset:0;background:rgba(18,34,29,.55);z-index:99998;' +
          'display:flex;align-items:center;justify-content:center;padding:16px;';
        var hint = escapeHtml(lsGet(HINT_KEY) || '');
        var inner =
          '<div style="background:#fdfcf8;border-radius:16px;max-width:400px;width:100%;padding:24px;' +
          'font-family:inherit;box-shadow:0 10px 40px rgba(0,0,0,.3);">' +
          '<div style="font-weight:800;font-size:1.05rem;color:#12221d;margin-bottom:4px;">' +
          (mode === 'login' ? 'Log in / Restore purchase' : 'Get FPL Apex') + '</div>' +
          '<div style="font-size:.8rem;color:#7a8783;margin-bottom:14px;">' +
          (mode === 'login'
            ? 'Enter the email you subscribed with (or want to use). We email you a sign-in link — no password.'
            : 'One tier. Everything unlocked: full-season planning, transfer paths, rival mode, chip timing.') +
          '</div>' +
          '<input id="apex-bill-email" type="email" placeholder="you@email.com" value="' + hint + '" ' +
          'style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d8d4c8;border-radius:9px;' +
          'font-size:.9rem;font-family:inherit;margin-bottom:12px;">' +
          (mode === 'login'
            ? '<button id="apex-bill-go" style="' + btnCss(true) + 'width:100%;">Email me a sign-in link</button>'
            : '<div style="display:grid;gap:8px;">' +
              '<button id="apex-bill-p-season" style="' + btnCss(true) + '">Season pass — £22</button>' +
              '<button id="apex-bill-p-monthly" style="' + btnCss(false) + '">Monthly — £3.50</button>' +
              '<button id="apex-bill-p-founder" style="' + btnCss(false) + '">Founder — £15 (limited)</button></div>' +
              '<div style="font-size:.72rem;color:#7a8783;margin-top:10px;">Already subscribed? ' +
              '<a href="#" id="apex-bill-switch" style="color:#1D9E75;">Log in instead</a></div>') +
          '<div style="text-align:right;margin-top:12px;">' +
          '<a href="#" id="apex-bill-close" style="font-size:.78rem;color:#7a8783;">Close</a></div></div>';
        wrap.innerHTML = inner;
        window.document.body.appendChild(wrap);
        function email() {
          var el = window.document.getElementById('apex-bill-email');
          return el ? el.value : '';
        }
        function close() { try { wrap.parentNode.removeChild(wrap); } catch (e) {} }
        wire('apex-bill-close', function (ev) { if (ev) ev.preventDefault(); close(); return false; });
        wrap.onclick = function (ev) { if (ev.target === wrap) close(); };
        if (mode === 'login') {
          wire('apex-bill-go', function () { startLogin(email()); close(); });
        } else {
          wire('apex-bill-p-season', function () { lsSet(HINT_KEY, email().trim()); subscribe('season'); });
          wire('apex-bill-p-monthly', function () { lsSet(HINT_KEY, email().trim()); subscribe('monthly'); });
          wire('apex-bill-p-founder', function () { lsSet(HINT_KEY, email().trim()); subscribe('founder'); });
          wire('apex-bill-switch', function (ev) { if (ev) ev.preventDefault(); openModal('login'); return false; });
        }
      } catch (e) {}
    }

    // Renders the account chip into a container. GATED: does nothing at all
    // unless window.APEX_BILLING_LIVE === true, so no UI can appear pre-flip.
    function mountUI(containerOrSelector) {
      if (!live()) return false;
      try {
        _mount = typeof containerOrSelector === 'string'
          ? window.document.querySelector(containerOrSelector)
          : containerOrSelector;
        if (!_mount) return false;
        renderMount();
        return true;
      } catch (e) { return false; }
    }

    // Zero-wiring fallback so the August flip needs NO further page edits:
    // when live, if nothing has mounted the UI explicitly, float an account
    // chip top-right. Opt out with window.APEX_BILLING_NO_AUTOMOUNT = true
    // and call apexBilling.mountUI('#your-container') for a proper placement.
    function autoMount() {
      if (!live() || window.APEX_BILLING_NO_AUTOMOUNT === true || _mount) return;
      try {
        var d = window.document;
        if (!d || !d.body || !d.createElement) return;
        var box = d.createElement('div');
        box.id = 'apex-billing-chip';
        box.style.cssText = 'position:fixed;top:10px;right:12px;z-index:99990;' +
          'background:rgba(253,252,248,.96);border:1px solid #e3dfd2;border-radius:12px;' +
          'padding:8px 12px;box-shadow:0 2px 10px rgba(0,0,0,.08);font-family:inherit;';
        d.body.appendChild(box);
        mountUI(box);
      } catch (e) {}
    }
    function whenDomReady(fn) {
      try {
        var d = window.document;
        if (d && d.readyState === 'loading' && d.addEventListener) {
          d.addEventListener('DOMContentLoaded', fn);
        } else {
          fn();
        }
      } catch (e) {}
    }

    window.apexBilling = {
      subscribe: subscribe,
      startLogin: startLogin,
      logout: logout,
      status: status,
      refresh: refresh,
      mountUI: mountUI,
      openModal: openModal,   // homepage pricing band opens the same modal (2026-07-07)
    };

    // ── boot (network + DOM only when live) ─────────────────────────────────
    if (live()) {
      consumeMagicFromHash()
        .then(function () { return refresh(); })
        .then(function () { whenDomReady(autoMount); });
      try {
        if (/[?&]apex_sub=success/.test(String(window.location.search))) {
          toast('Payment received ✓ — now enter your email under “Log in” to unlock this device.');
        }
      } catch (e) {}
    }

  } catch (e) {
    // Absolute last line of defence: billing must never break the solver.
    try { window.apexBilling = window.apexBilling || { status: function () { return { live: false, error: String(e) }; } }; } catch (_) {}
  }
})();
