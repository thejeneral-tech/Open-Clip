/**
 * Trend Vault — shared LEFT SIDEBAR navigation (TrendVault AI / Coder look).
 *
 * Each page already mounts an empty <nav id="tv-nav"></nav> in its <header> and
 * loads this script. We hide that old top bar and instead inject a fixed
 * left sidebar (brand + grouped tool rows) styled like the Coder's sidebar,
 * then shift page content right via a --tv-sb-w CSS variable so the studio's
 * sticky header + fixed action bar line up cleanly. Collapsible (Ctrl+B),
 * state remembered in localStorage, auto icon-rail on narrow screens.
 *
 * Add or rename tools in the TOOLS array — every page updates on next load.
 */
(function () {
  const TOOLS = [
    {
      group: 'Create',
      items: [
        { href: '/trend-vault', iconHTML: '<img src="/vault-icon.svg" width="16" height="16" alt="" draggable="false" style="vertical-align:-3px">', label: 'The Vault', accent: '#e06c75' },
        { href: '/voice-lab',   icon: '🎙️', label: 'Voice Lab', accent: '#9cdef2' },
        { href: '/',            icon: '✂️', label: 'Clip Tool', accent: '#f0ad4e' },
      ],
    },
    {
      group: 'Hub',
      items: [
        { href: '/mainframe', icon: '⚡', label: 'Mainframe', accent: '#d19a66' },
        { href: '/accounts',  icon: '👥', label: 'Accounts',  accent: '#7fb8cc' },
      ],
    },
  ];

  const SB_KEY = 'tv-sidebar-collapsed';

  function normalize(p) {
    if (!p) return '/';
    const clean = p.replace(/\/+$/, '');
    return clean === '' ? '/' : clean;
  }

  function applyCollapsed(collapsed) {
    document.documentElement.classList.toggle('tv-collapsed', !!collapsed);
  }

  function toggle() {
    const next = !document.documentElement.classList.contains('tv-collapsed');
    applyCollapsed(next);
    try { localStorage.setItem(SB_KEY, next ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function buildSidebar() {
    if (document.getElementById('tv-sidebar')) return;
    const here = normalize(location.pathname);

    const sectionsHTML = TOOLS.map((g) => {
      const items = g.items.map((it) => {
        const isActive = normalize(it.href) === here;
        const icon = it.iconHTML ?? `<span class="tv-sb-emoji">${it.icon || ''}</span>`;
        return `<a href="${it.href}" class="tv-sb-item${isActive ? ' tv-active' : ''}" style="--tv-accent:${it.accent}" title="${it.label}">
          <span class="tv-sb-ico">${icon}</span><span class="tv-sb-lbl">${it.label}</span>
        </a>`;
      }).join('');
      return `<div class="tv-sb-section">
        <div class="tv-sb-label">${g.group}</div>${items}
      </div>`;
    }).join('');

    const aside = document.createElement('aside');
    aside.id = 'tv-sidebar';
    aside.innerHTML = `
      <div class="tv-sb-top">
        <button class="tv-sb-toggle" id="tvSbToggle" title="Toggle sidebar (Ctrl+B)" aria-label="Toggle sidebar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <a class="tv-sb-brand" href="/trend-vault" title="Trend Vault">
          <img src="/vault-icon.svg" width="18" height="18" alt="" draggable="false">
          <span class="tv-sb-brand-title">TrendVault AI</span>
        </a>
      </div>
      <nav class="tv-sb-nav" aria-label="Primary navigation">${sectionsHTML}</nav>
      <button class="tv-sb-settings" id="tvSbSettings" type="button" title="Settings">
        <span class="tv-sb-ico"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span><span class="tv-sb-lbl">Settings</span>
      </button>
      <div class="tv-sb-account" id="tvSbAccount" hidden>
        <a class="tv-sb-acct-main" id="tvSbAcctMain" title="Account">
          <span class="tv-sb-avatar" id="tvSbAvatar" aria-hidden="true">?</span>
          <span class="tv-sb-acct-meta">
            <span class="tv-sb-acct-name" id="tvSbAcctName">—</span>
            <span class="tv-sb-acct-role" id="tvSbAcctRole"></span>
          </span>
        </a>
        <button class="tv-sb-logout" id="tvSbLogout" type="button" title="Sign out" aria-label="Sign out">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
      <div class="tv-sb-foot"><span class="tv-sb-dot" aria-hidden="true"></span><span class="tv-sb-lbl">v2.0</span></div>
    `;
    document.body.appendChild(aside);
    const tgl = document.getElementById('tvSbToggle');
    if (tgl) tgl.addEventListener('click', toggle);
  }

  function injectStyle() {
    if (document.getElementById('tv-sb-style')) return;
    const css = `
      /* Retire the old top-bar nav */
      #tv-nav { display: none !important; }

      :root { --tv-sb-w: 220px; }
      :root.tv-collapsed { --tv-sb-w: 58px; }

      body { padding-left: var(--tv-sb-w) !important; transition: padding-left .22s ease; }
      /* Offset any full-width fixed bottom bar (the studio action bar) */
      .action-bar { left: var(--tv-sb-w) !important; transition: left .22s ease; }

      #tv-sidebar {
        position: fixed; top: 0; left: 0; bottom: 0; width: var(--tv-sb-w);
        display: flex; flex-direction: column;
        background: var(--panel, #21252b);
        border-right: 1px solid var(--border, #355a66);
        box-shadow: 2px 0 18px rgba(0,0,0,.28);
        z-index: 500; overflow: hidden;
        font-family: var(--font-mono, 'Fira Code', ui-monospace, monospace);
        transition: width .22s ease;
      }
      #tv-sidebar .tv-sb-top {
        display: flex; align-items: center; gap: 9px;
        padding: 14px 12px 10px; min-height: 46px; flex-shrink: 0;
      }
      #tv-sidebar .tv-sb-toggle {
        flex-shrink: 0; width: 30px; height: 30px; border-radius: 8px;
        display: inline-flex; align-items: center; justify-content: center;
        background: transparent; color: var(--text2, #7fb8cc); cursor: pointer;
        border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
        transition: color .15s, background-color .15s, border-color .15s;
      }
      #tv-sidebar .tv-sb-toggle:hover {
        color: var(--text, #9cdef2);
        border-color: color-mix(in srgb, var(--accent) 55%, transparent);
        background: color-mix(in srgb, var(--accent) 10%, transparent);
      }
      #tv-sidebar .tv-sb-brand { display: flex; align-items: center; gap: 9px; text-decoration: none; min-width: 0; }
      #tv-sidebar .tv-sb-brand img { filter: drop-shadow(0 0 5px color-mix(in srgb, var(--accent) 50%, transparent)); flex-shrink: 0; }
      #tv-sidebar .tv-sb-brand-title {
        font-size: .92rem; font-weight: 700; letter-spacing: .3px; white-space: nowrap;
        color: var(--accent, #e06c75);
        text-shadow: 0 0 8px color-mix(in srgb, var(--accent) 35%, transparent);
      }
      #tv-sidebar .tv-sb-nav {
        flex: 1; overflow-y: auto; overflow-x: hidden; padding: 6px 8px 8px;
        display: flex; flex-direction: column; gap: 2px; scrollbar-width: none;
      }
      #tv-sidebar .tv-sb-nav::-webkit-scrollbar { width: 0; height: 0; }
      #tv-sidebar .tv-sb-section { display: flex; flex-direction: column; gap: 3px; margin-top: 12px; }
      #tv-sidebar .tv-sb-section:first-child { margin-top: 2px; }
      #tv-sidebar .tv-sb-label {
        font-size: .55rem; letter-spacing: 2.2px; font-weight: 700; text-transform: uppercase;
        color: var(--muted, #6b8a94); padding: 4px 9px 2px; user-select: none; white-space: nowrap;
      }
      #tv-sidebar .tv-sb-item {
        --tv-accent: var(--accent, #e06c75);
        display: flex; align-items: center; gap: 11px;
        padding: 9px 10px; border-radius: 9px;
        color: var(--text2, #7fb8cc); text-decoration: none;
        font-size: .8rem; font-weight: 600; letter-spacing: .2px;
        border: 1px solid transparent; white-space: nowrap; line-height: 1;
        transition: color .14s, background-color .14s, border-color .14s, box-shadow .16s;
      }
      #tv-sidebar .tv-sb-item:hover {
        color: var(--text, #9cdef2);
        background: color-mix(in srgb, var(--tv-accent) 10%, transparent);
        border-color: color-mix(in srgb, var(--tv-accent) 45%, transparent);
      }
      #tv-sidebar .tv-sb-item.tv-active {
        color: #fff;
        background: color-mix(in srgb, var(--tv-accent) 20%, transparent);
        border-color: color-mix(in srgb, var(--tv-accent) 60%, transparent);
        box-shadow: inset 3px 0 0 var(--tv-accent), 0 0 14px color-mix(in srgb, var(--tv-accent) 26%, transparent);
      }
      #tv-sidebar .tv-sb-ico { width: 20px; min-width: 20px; display: inline-flex; align-items: center; justify-content: center; }
      #tv-sidebar .tv-sb-emoji { font-size: 1.02rem; line-height: 1; }
      #tv-sidebar .tv-sb-foot {
        flex-shrink: 0; padding: 9px 16px; display: flex; align-items: center; gap: 8px;
        font-size: .6rem; letter-spacing: 1.6px; color: var(--muted, #6b8a94);
        border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
      }
      #tv-sidebar .tv-sb-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green, #50fa7b); box-shadow: 0 0 6px var(--green, #50fa7b); }

      /* Account + logout (signed-in user) — mirrors the Coder's account control */
      #tv-sidebar .tv-sb-account {
        flex-shrink: 0; display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; margin: 4px 8px 0;
        border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
      }
      #tv-sidebar .tv-sb-acct-main {
        display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0;
        text-decoration: none; color: inherit; border-radius: 8px; padding: 4px;
        transition: background-color .14s;
      }
      #tv-sidebar a.tv-sb-acct-main { cursor: pointer; }
      #tv-sidebar a.tv-sb-acct-main:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
      #tv-sidebar .tv-sb-avatar {
        width: 28px; height: 28px; min-width: 28px; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 12px; font-weight: 700; flex-shrink: 0; color: #fff;
        background: linear-gradient(135deg, var(--purple2), var(--gold));
      }
      #tv-sidebar .tv-sb-acct-meta { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
      #tv-sidebar .tv-sb-acct-name { font-size: .8rem; font-weight: 600; color: var(--text, #9cdef2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #tv-sidebar .tv-sb-acct-role { font-size: .56rem; letter-spacing: 1.4px; text-transform: uppercase; color: var(--muted, #6b8a94); }
      #tv-sidebar .tv-sb-logout {
        flex-shrink: 0; width: 30px; height: 30px; border-radius: 8px;
        display: inline-flex; align-items: center; justify-content: center;
        background: transparent; color: var(--muted, #6b8a94); cursor: pointer;
        border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
        transition: color .15s, background-color .15s, border-color .15s;
      }
      #tv-sidebar .tv-sb-logout:hover {
        color: var(--red, #ff5b5b);
        border-color: color-mix(in srgb, var(--red, #ff5b5b) 55%, transparent);
        background: color-mix(in srgb, var(--red, #ff5b5b) 12%, transparent);
      }
      :root.tv-collapsed #tv-sidebar .tv-sb-account { flex-direction: column; gap: 6px; padding: 8px 0; margin: 4px 6px 0; }
      :root.tv-collapsed #tv-sidebar .tv-sb-acct-meta { display: none; }
      :root.tv-collapsed #tv-sidebar .tv-sb-acct-main { justify-content: center; flex: none; }

      /* Settings entry at the bottom of the sidebar */
      #tv-sidebar .tv-sb-settings {
        flex-shrink: 0; display: flex; align-items: center; gap: 11px;
        margin: 8px 8px 0; padding: 9px 10px; border-radius: 9px;
        background: transparent; border: 1px solid transparent;
        color: var(--text2, #7fb8cc); font-family: inherit; font-size: .8rem; font-weight: 600; letter-spacing: .2px;
        cursor: pointer; white-space: nowrap; line-height: 1; text-align: left;
        transition: color .14s, background-color .14s, border-color .14s;
      }
      #tv-sidebar .tv-sb-settings:hover { color: var(--text, #9cdef2); background: color-mix(in srgb, var(--accent) 10%, transparent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
      :root.tv-collapsed #tv-sidebar .tv-sb-settings { justify-content: center; padding: 10px 0; gap: 0; margin: 8px 6px 0; }

      /* Collapsed icon-rail */
      :root.tv-collapsed #tv-sidebar .tv-sb-lbl,
      :root.tv-collapsed #tv-sidebar .tv-sb-brand,
      :root.tv-collapsed #tv-sidebar .tv-sb-label { display: none; }
      :root.tv-collapsed #tv-sidebar .tv-sb-top { justify-content: center; padding: 14px 0 10px; }
      :root.tv-collapsed #tv-sidebar .tv-sb-item { justify-content: center; padding: 10px 0; gap: 0; }
      :root.tv-collapsed #tv-sidebar .tv-sb-label { height: 8px; }
      :root.tv-collapsed #tv-sidebar .tv-sb-foot { justify-content: center; padding: 9px 0; }

      /* Fallback for browsers without color-mix */
      @supports not (color: color-mix(in srgb, red, blue)) {
        #tv-sidebar .tv-sb-item:hover { background: rgba(224,108,117,.10); border-color: rgba(224,108,117,.45); }
        #tv-sidebar .tv-sb-item.tv-active { background: rgba(224,108,117,.20); border-color: rgba(224,108,117,.60); box-shadow: inset 3px 0 0 var(--tv-accent); }
      }

      /* Narrow screens → auto icon rail */
      @media (max-width: 820px) {
        :root { --tv-sb-w: 58px; }
        #tv-sidebar .tv-sb-lbl, #tv-sidebar .tv-sb-brand, #tv-sidebar .tv-sb-label { display: none; }
        #tv-sidebar .tv-sb-top { justify-content: center; padding: 14px 0 10px; }
        #tv-sidebar .tv-sb-item { justify-content: center; padding: 10px 0; gap: 0; }
        #tv-sidebar .tv-sb-foot { justify-content: center; padding: 9px 0; }
        #tv-sidebar .tv-sb-account { flex-direction: column; gap: 6px; padding: 8px 0; margin: 4px 6px 0; }
        #tv-sidebar .tv-sb-acct-meta { display: none; }
        #tv-sidebar .tv-sb-acct-main { justify-content: center; flex: none; }
        #tv-sidebar .tv-sb-settings { justify-content: center; padding: 10px 0; gap: 0; margin: 8px 6px 0; }
      }
    `;
    const el = document.createElement('style');
    el.id = 'tv-sb-style';
    el.textContent = css;
    document.head.appendChild(el);
  }

  async function _logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* ignore */ }
    // Wipe per-user client state on logout so the next account that signs in on
    // this browser doesn't inherit it — but KEEP the saved theme and remembered
    // username for a smooth re-login.
    try {
      var keep = { 'trendvault-ai-theme': 1, 'trendvault-ai-last-user': 1 };
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && !keep[k]) toRemove.push(k);
      }
      toRemove.forEach(function (k) { localStorage.removeItem(k); });
      sessionStorage.clear();
    } catch (e) { /* ignore */ }
    window.location.href = '/login';
  }

  async function initAccount() {
    var wrap = document.getElementById('tvSbAccount');
    if (!wrap) return;
    var data = null;
    try {
      var res = await fetch('/api/auth/status', { credentials: 'same-origin' });
      data = await res.json();
    } catch (e) { /* auth disabled / unreachable */ }
    if (!data || !data.authenticated) { wrap.hidden = true; return; }
    wrap.hidden = false;
    var name = data.username || 'user';
    var isAdmin = !!data.is_admin;
    var avatar = document.getElementById('tvSbAvatar');
    var nameEl = document.getElementById('tvSbAcctName');
    var roleEl = document.getElementById('tvSbAcctRole');
    var main = document.getElementById('tvSbAcctMain');
    if (avatar) avatar.textContent = name.charAt(0).toUpperCase();
    if (nameEl) { nameEl.textContent = name; nameEl.title = name; }
    if (roleEl) roleEl.textContent = isAdmin ? 'Admin' : 'User';
    // Account row opens the User Management window widget — account + password
    // for everyone, full user administration for admins.
    if (main) {
      main.title = isAdmin ? 'Manage users' : 'Account';
      if (!main.dataset.wired) {
        main.dataset.wired = '1';
        main.setAttribute('role', 'button');
        main.setAttribute('tabindex', '0');
        main.style.cursor = 'pointer';
        var openUsers = function (e) { if (e) e.preventDefault(); if (window.TVAUsers && window.TVAUsers.open) window.TVAUsers.open(); };
        main.addEventListener('click', openUsers);
        main.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') openUsers(e); });
      }
    }
    var logoutBtn = document.getElementById('tvSbLogout');
    if (logoutBtn && !logoutBtn.dataset.wired) {
      logoutBtn.dataset.wired = '1';
      logoutBtn.addEventListener('click', _logout);
    }
  }

  // The User Management + Settings window widgets live in separate scripts loaded
  // on every page (so they're reachable from the sidebar anywhere, like the
  // Coder's cookbook + settings). Each self-registers a global and builds lazily.
  function loadWidget(id, src, globalName) {
    if (document.getElementById(id) || window[globalName]) return;
    var s = document.createElement('script');
    s.id = id; s.src = src; s.defer = true;
    document.head.appendChild(s);
  }

  function init() {
    injectStyle();
    let collapsed = false;
    try { collapsed = localStorage.getItem(SB_KEY) === '1'; } catch (e) { /* ignore */ }
    applyCollapsed(collapsed);
    buildSidebar();
    loadWidget('tva-users-widget-js', '/users-widget.js', 'TVAUsers');
    loadWidget('tva-settings-widget-js', '/settings-widget.js', 'TVASettings');
    var settingsBtn = document.getElementById('tvSbSettings');
    if (settingsBtn) settingsBtn.addEventListener('click', function () { if (window.TVASettings && window.TVASettings.open) window.TVASettings.open(); });
    initAccount();
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggle();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
