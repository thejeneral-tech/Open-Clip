/**
 * settings-widget.js — Settings as a floating, draggable, tabbed window widget.
 *
 * Replicates the Coder's settings modal: a window with a draggable title bar,
 * a left tab rail (icon + label) and right content panels. Opened from the
 * "Settings" entry at the bottom of the sidebar. Adapted for the TrendVault
 * studio — Appearance (theme), Account, and About — wired to real features
 * (window.TVATheme, /api/auth/*, /api/version).
 *
 * Public API: window.TVASettings = { open(tab?), close() }
 */
(function () {
  'use strict';
  if (window.TVASettings) return;

  var overlay = null, win = null, built = false;
  function $(id) { return document.getElementById(id); }

  var TABS = [
    { id: 'appearance', label: 'Appearance', icon: '<circle cx="12" cy="12" r="10"/><path d="M12 2a7 7 0 0 0 0 20 4 4 0 0 1 0-8 4 4 0 0 0 0-8"/>' },
    { id: 'account', label: 'Account', icon: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
    { id: 'about', label: 'About', icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>' },
  ];

  function injectStyle() {
    if (document.getElementById('tva-settings-widget-css')) return;
    var css = `
      #stOverlay { position: fixed; inset: 0; z-index: 4100; background: color-mix(in srgb, #000 46%, transparent); backdrop-filter: blur(2px); }
      #stOverlay[hidden] { display: none; }
      #stWindow {
        position: absolute; width: min(780px, 95vw); height: min(78vh, 600px);
        display: flex; flex-direction: column; overflow: hidden;
        background: var(--surface, #21252b); border: 1px solid var(--border, #355a66); border-radius: 14px;
        box-shadow: 0 24px 70px rgba(0,0,0,.55), 0 0 0 1px color-mix(in srgb, var(--accent, #e06c75) 12%, transparent);
        font-family: var(--font-mono, 'Fira Code', monospace); color: var(--text, #9cdef2);
        animation: stPop .16s cubic-bezier(.2,.9,.3,1.2);
      }
      @keyframes stPop { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: scale(1); } }
      #stOverlay .st-titlebar {
        display: flex; align-items: center; gap: 9px; padding: 12px 14px; cursor: move; user-select: none;
        background: color-mix(in srgb, var(--surface3, #1b1e24) 90%, transparent);
        border-bottom: 1px solid var(--border, #355a66); touch-action: none; flex-shrink: 0;
      }
      #stOverlay .st-title { font-size: .78rem; font-weight: 800; letter-spacing: 1.8px; text-transform: uppercase; color: var(--text2, #7fb8cc); display: flex; align-items: center; gap: 8px; margin-right: auto; }
      #stOverlay .st-title svg { opacity: .7; }
      #stOverlay .st-close { width: 28px; height: 28px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--muted, #6b8a94); cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center; transition: all .15s; }
      #stOverlay .st-close:hover { color: var(--red, #ff5b5b); border-color: color-mix(in srgb, var(--red, #ff5b5b) 45%, transparent); background: color-mix(in srgb, var(--red, #ff5b5b) 12%, transparent); }
      #stOverlay .st-layout { flex: 1; display: flex; min-height: 0; }
      #stOverlay .st-rail { width: 168px; flex-shrink: 0; padding: 12px 10px; display: flex; flex-direction: column; gap: 3px; border-right: 1px solid var(--border, #355a66); background: color-mix(in srgb, var(--surface3, #1b1e24) 55%, transparent); overflow-y: auto; }
      #stOverlay .st-tab { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 9px; border: 1px solid transparent; background: transparent; color: var(--text2, #7fb8cc); font-family: inherit; font-size: .82rem; font-weight: 600; cursor: pointer; text-align: left; transition: all .14s; white-space: nowrap; }
      #stOverlay .st-tab:hover { color: var(--text, #9cdef2); background: color-mix(in srgb, var(--accent, #e06c75) 9%, transparent); }
      #stOverlay .st-tab.active { color: var(--text, #9cdef2); background: color-mix(in srgb, var(--accent, #e06c75) 16%, transparent); border-color: color-mix(in srgb, var(--accent, #e06c75) 45%, transparent); }
      #stOverlay .st-tab svg { opacity: .75; flex-shrink: 0; }
      #stOverlay .st-content { flex: 1; overflow-y: auto; padding: 18px; min-width: 0; scrollbar-width: thin; scrollbar-color: rgba(var(--accent-rgb,224,108,117), .45) transparent; }
      #stOverlay .st-content::-webkit-scrollbar { width: 8px; }
      #stOverlay .st-content::-webkit-scrollbar-thumb { background: rgba(var(--accent-rgb,224,108,117), .4); border-radius: 8px; }
      #stOverlay .st-panel { display: none; flex-direction: column; gap: 16px; }
      #stOverlay .st-panel.active { display: flex; }
      #stOverlay .st-card { background: var(--surface2, #2c313c); border: 1px solid var(--border, #355a66); border-radius: 12px; padding: 16px; }
      #stOverlay .st-card h3 { font-size: .66rem; letter-spacing: 1.8px; text-transform: uppercase; color: var(--text2, #7fb8cc); margin: 0 0 13px; font-weight: 800; }
      #stOverlay .st-sub { font-size: .72rem; color: var(--muted, #6b8a94); margin: -6px 0 12px; line-height: 1.5; }
      #stOverlay .st-theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 9px; }
      #stOverlay .st-theme { display: flex; flex-direction: column; align-items: stretch; gap: 7px; padding: 7px; border-radius: 10px; border: 1px solid var(--border, #355a66); background: var(--surface, #21252b); color: var(--text2, #7fb8cc); cursor: pointer; font-family: inherit; font-size: .7rem; font-weight: 600; transition: all .14s; }
      #stOverlay .st-theme:hover { border-color: color-mix(in srgb, var(--accent, #e06c75) 50%, transparent); color: var(--text, #9cdef2); }
      #stOverlay .st-theme.active { border-color: var(--accent, #e06c75); color: var(--text, #9cdef2); box-shadow: 0 0 0 1px var(--accent, #e06c75), 0 0 14px color-mix(in srgb, var(--accent, #e06c75) 25%, transparent); }
      #stOverlay .st-sw { height: 38px; border-radius: 7px; border: 1px solid rgba(255,255,255,.12); }
      #stOverlay .st-theme-nm { text-align: center; }
      #stOverlay .st-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 14px; }
      #stOverlay .st-toggle-row .st-tt { font-size: .84rem; font-weight: 600; color: var(--text, #9cdef2); }
      #stOverlay .st-toggle-row .st-ts { font-size: .7rem; color: var(--muted, #6b8a94); margin-top: 2px; }
      #stOverlay .st-switch { position: relative; display: inline-block; width: 42px; height: 24px; flex-shrink: 0; }
      #stOverlay .st-switch input { opacity: 0; width: 0; height: 0; }
      #stOverlay .st-slider { position: absolute; inset: 0; cursor: pointer; background: var(--surface3, #1b1e24); border: 1px solid var(--border, #355a66); border-radius: 24px; transition: .2s; }
      #stOverlay .st-slider:before { content: ''; position: absolute; height: 16px; width: 16px; left: 3px; bottom: 3px; background: var(--muted, #6b8a94); border-radius: 50%; transition: .2s; }
      #stOverlay .st-switch input:checked + .st-slider { background: rgba(var(--accent-rgb,224,108,117), .30); border-color: var(--accent, #e06c75); }
      #stOverlay .st-switch input:checked + .st-slider:before { transform: translateX(18px); background: var(--accent, #e06c75); }
      #stOverlay .st-acct { display: flex; align-items: center; gap: 13px; }
      #stOverlay .st-avatar { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 19px; font-weight: 800; color: #fff; background: linear-gradient(135deg, var(--purple2, #eb8a91), var(--gold, #d19a66)); flex-shrink: 0; }
      #stOverlay .st-acct-name { font-size: .96rem; font-weight: 700; color: var(--text, #9cdef2); }
      #stOverlay .st-acct-role { font-size: .58rem; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted, #6b8a94); margin-top: 2px; }
      #stOverlay .st-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 9px 13px; border-radius: 9px; border: 1px solid var(--border, #355a66); background: transparent; color: var(--text2, #7fb8cc); font-family: inherit; font-size: .78rem; font-weight: 700; cursor: pointer; transition: all .15s; }
      #stOverlay .st-btn:hover { border-color: var(--accent, #e06c75); color: var(--text, #9cdef2); background: rgba(var(--accent-rgb,224,108,117), .10); }
      #stOverlay .st-btn-danger { color: var(--red, #ff5b5b); border-color: color-mix(in srgb, var(--red, #ff5b5b) 45%, transparent); }
      #stOverlay .st-btn-danger:hover { background: color-mix(in srgb, var(--red, #ff5b5b) 12%, transparent); border-color: var(--red, #ff5b5b); color: var(--red, #ff5b5b); }
      #stOverlay .st-actions { display: flex; gap: 9px; flex-wrap: wrap; margin-top: 14px; }
      #stOverlay .st-about-name { font-size: 1.05rem; font-weight: 900; letter-spacing: .5px; background: linear-gradient(135deg, var(--purple2, #eb8a91), var(--gold, #d19a66)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
      #stOverlay .st-about-row { display: flex; justify-content: space-between; font-size: .8rem; padding: 7px 0; border-top: 1px solid color-mix(in srgb, var(--border, #355a66) 55%, transparent); }
      #stOverlay .st-about-row:first-of-type { border-top: none; }
      #stOverlay .st-about-row span { color: var(--muted, #6b8a94); }
      #stOverlay .st-about-row strong { color: var(--text, #9cdef2); font-weight: 600; }
      @media (max-width: 560px) {
        #stOverlay .st-layout { flex-direction: column; }
        #stOverlay .st-rail { width: auto; flex-direction: row; overflow-x: auto; border-right: none; border-bottom: 1px solid var(--border, #355a66); }
      }
    `;
    var el = document.createElement('style');
    el.id = 'tva-settings-widget-css';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function railHTML() {
    return TABS.map(function (t, i) {
      return '<button class="st-tab' + (i === 0 ? ' active' : '') + '" data-tab="' + t.id + '" type="button">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + t.icon + '</svg>' +
        '<span>' + t.label + '</span></button>';
    }).join('');
  }

  function panelsHTML() {
    return `
      <div class="st-panel active" data-panel="appearance">
        <div class="st-card">
          <h3>Theme</h3>
          <div class="st-sub">Recolors the entire studio. Your choice is saved on this device.</div>
          <div class="st-theme-grid" id="stThemeGrid"></div>
        </div>
        <div class="st-card">
          <h3>Layout</h3>
          <div class="st-toggle-row" style="margin-top:0">
            <div><div class="st-tt">Collapse sidebar by default</div><div class="st-ts">Start with the navigation rail collapsed (toggle anytime with Ctrl+B)</div></div>
            <label class="st-switch"><input type="checkbox" id="stCollapse"><span class="st-slider"></span></label>
          </div>
        </div>
      </div>

      <div class="st-panel" data-panel="account">
        <div class="st-card">
          <h3>Signed in</h3>
          <div class="st-acct">
            <div class="st-avatar" id="stAvatar">?</div>
            <div style="flex:1;min-width:0"><div class="st-acct-name" id="stName">—</div><div class="st-acct-role" id="stRole"></div></div>
          </div>
          <div class="st-actions">
            <button class="st-btn" id="stManageBtn" type="button">Account &amp; password</button>
            <button class="st-btn st-btn-danger" id="stLogout" type="button">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>Sign out
            </button>
          </div>
        </div>
      </div>

      <div class="st-panel" data-panel="about">
        <div class="st-card">
          <div class="st-about-name">Trend Vault video Generator</div>
          <div class="st-sub" style="margin-top:8px">A local-first studio for turning trends into short-form videos.</div>
          <div class="st-about-row"><span>Version</span><strong id="stVersion">—</strong></div>
          <div class="st-about-row"><span>Theme</span><strong id="stCurTheme">—</strong></div>
          <div class="st-about-row"><span>Backend</span><strong>FastAPI + Remotion</strong></div>
        </div>
      </div>`;
  }

  function build() {
    injectStyle();
    overlay = document.createElement('div');
    overlay.id = 'stOverlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div id="stWindow" role="dialog" aria-modal="true" aria-label="Settings">' +
        '<div class="st-titlebar" id="stTitlebar">' +
          '<span class="st-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>Settings</span>' +
          '<button class="st-close" id="stClose" type="button" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="st-layout">' +
          '<div class="st-rail" id="stRail">' + railHTML() + '</div>' +
          '<div class="st-content" id="stContent">' + panelsHTML() + '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    win = $('stWindow');

    $('stClose').addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay && !overlay.hidden) close(); });

    // Tab switching
    overlay.querySelectorAll('.st-tab').forEach(function (b) {
      b.addEventListener('click', function () { selectTab(b.getAttribute('data-tab')); });
    });

    wireDrag();
    wireActions();
    renderThemes();
    built = true;
  }

  function selectTab(id) {
    overlay.querySelectorAll('.st-tab').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === id); });
    overlay.querySelectorAll('.st-panel').forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-panel') === id); });
    if (id === 'account') loadAccount();
    if (id === 'about') loadAbout();
  }

  function wireDrag() {
    var bar = $('stTitlebar'), drag = null;
    bar.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.st-close')) return;
      var r = win.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      try { bar.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    bar.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var r = win.getBoundingClientRect();
      var x = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - r.width);
      var y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - r.height);
      win.style.left = x + 'px'; win.style.top = y + 'px';
    });
    function end(e) { if (drag && e.pointerId === drag.id) drag = null; }
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  function centerWindow() {
    var r = win.getBoundingClientRect();
    win.style.left = Math.max(8, Math.round((window.innerWidth - r.width) / 2)) + 'px';
    win.style.top = Math.max(8, Math.round((window.innerHeight - r.height) / 2)) + 'px';
  }

  function prettyTheme(n) { return n === 'vault' ? 'Vault' : (n ? n.charAt(0).toUpperCase() + n.slice(1) : '—'); }

  function renderThemes() {
    var grid = $('stThemeGrid');
    var TVA = window.TVATheme || {};
    var T = TVA.THEMES || {};
    var cur = (TVA.get && TVA.get()) || '';
    var names = Object.keys(T);
    if (!names.length) { grid.innerHTML = '<div style="opacity:.5;font-size:.78rem">Theme system unavailable</div>'; return; }
    grid.innerHTML = names.map(function (name) {
      var t = T[name];
      var sw = 'linear-gradient(135deg,' + t.bg + ' 0 52%,' + t.red + ' 52% 100%)';
      return '<button class="st-theme' + (name === cur ? ' active' : '') + '" data-theme="' + name + '" type="button">' +
        '<span class="st-sw" style="background:' + sw + '"></span><span class="st-theme-nm">' + prettyTheme(name) + '</span></button>';
    }).join('');
    grid.querySelectorAll('[data-theme]').forEach(function (b) {
      b.addEventListener('click', function () {
        var n = b.getAttribute('data-theme');
        if (window.TVATheme && window.TVATheme.apply) window.TVATheme.apply(n);
        grid.querySelectorAll('.st-theme').forEach(function (x) { x.classList.toggle('active', x === b); });
        var ct = $('stCurTheme'); if (ct) ct.textContent = prettyTheme(n);
      });
    });
  }

  function wireActions() {
    var col = $('stCollapse');
    try { col.checked = localStorage.getItem('tv-sidebar-collapsed') === '1'; } catch (e) {}
    col.addEventListener('change', function () {
      var on = col.checked;
      try { localStorage.setItem('tv-sidebar-collapsed', on ? '1' : '0'); } catch (e) {}
      document.documentElement.classList.toggle('tv-collapsed', on);
    });
    $('stManageBtn').addEventListener('click', function () { if (window.TVAUsers && window.TVAUsers.open) window.TVAUsers.open(); });
    $('stLogout').addEventListener('click', logout);
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
    try {
      var keep = { 'trendvault-ai-theme': 1, 'trendvault-ai-last-user': 1 };
      var rm = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && !keep[k]) rm.push(k); }
      rm.forEach(function (k) { localStorage.removeItem(k); });
      sessionStorage.clear();
    } catch (e) {}
    window.location.href = '/login';
  }

  async function loadAccount() {
    var d = null;
    try { d = await (await fetch('/api/auth/status', { credentials: 'same-origin' })).json(); } catch (e) {}
    if (!d || !d.authenticated) { $('stName').textContent = 'Not signed in'; $('stRole').textContent = ''; $('stAvatar').textContent = '?'; return; }
    $('stAvatar').textContent = (d.username || '?').charAt(0).toUpperCase();
    $('stName').textContent = d.username;
    $('stRole').textContent = d.is_admin ? 'Admin' : 'User';
    $('stManageBtn').textContent = d.is_admin ? 'Manage users & account' : 'Account & password';
  }

  async function loadAbout() {
    var v = $('stVersion');
    if (v && v.textContent === '—') {
      try { var d = await (await fetch('/api/version', { credentials: 'same-origin' })).json(); v.textContent = 'v' + (d.version || '?'); } catch (e) { v.textContent = '—'; }
    }
    var ct = $('stCurTheme');
    if (ct) ct.textContent = prettyTheme((window.TVATheme && window.TVATheme.get && window.TVATheme.get()) || '');
  }

  function open(tab) {
    if (!built) build();
    overlay.hidden = false;
    requestAnimationFrame(centerWindow);
    selectTab(tab && TABS.some(function (t) { return t.id === tab; }) ? tab : 'appearance');
    // keep the theme grid's active state in sync with the live theme
    renderThemes();
  }
  function close() { if (overlay) overlay.hidden = true; }

  window.TVASettings = { open: open, close: close };
})();
