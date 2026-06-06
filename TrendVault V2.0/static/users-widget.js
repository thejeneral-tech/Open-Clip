/**
 * users-widget.js — User Management as a floating, draggable window widget.
 *
 * Mirrors the Coder's "cookbook" pattern: a modal overlay containing a window
 * card with a draggable title bar (grab + move), a ✕ close button, and a
 * scrollable body. Opened over whatever page you're on (no navigation) from the
 * sidebar account control. Loaded globally by nav.js so it's available on every
 * page, exactly like the cookbook is available throughout the Coder's SPA.
 *
 * Public API: window.TVAUsers = { open(), close() }
 */
(function () {
  'use strict';
  if (window.TVAUsers) return;

  var overlay = null, win = null, built = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function jreq(path, body, method) {
    return fetch(path, {
      method: method || 'POST', credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  function injectStyle() {
    if (document.getElementById('tva-users-widget-css')) return;
    var css = `
      #uwOverlay { position: fixed; inset: 0; z-index: 4000; background: color-mix(in srgb, #000 46%, transparent); backdrop-filter: blur(2px); }
      #uwOverlay[hidden] { display: none; }
      #uwWindow {
        position: absolute; width: min(720px, 94vw); height: min(82vh, 720px);
        display: flex; flex-direction: column; overflow: hidden;
        background: var(--surface, #21252b); border: 1px solid var(--border, #355a66); border-radius: 14px;
        box-shadow: 0 24px 70px rgba(0,0,0,.55), 0 0 0 1px color-mix(in srgb, var(--accent, #e06c75) 12%, transparent);
        font-family: var(--font-mono, 'Fira Code', monospace); color: var(--text, #9cdef2);
        animation: uwPop .16s cubic-bezier(.2,.9,.3,1.2);
      }
      @keyframes uwPop { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: scale(1); } }
      #uwOverlay .uw-titlebar {
        display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: move; user-select: none;
        background: color-mix(in srgb, var(--surface3, #1b1e24) 90%, transparent);
        border-bottom: 1px solid var(--border, #355a66); touch-action: none;
      }
      #uwOverlay .uw-title { font-size: .78rem; font-weight: 800; letter-spacing: 1.8px; text-transform: uppercase; color: var(--text2, #7fb8cc); display: flex; align-items: center; gap: 8px; margin-right: auto; }
      #uwOverlay .uw-title svg { opacity: .7; }
      #uwOverlay .uw-close {
        width: 28px; height: 28px; border-radius: 7px; border: 1px solid transparent; background: transparent;
        color: var(--muted, #6b8a94); cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center; transition: all .15s;
      }
      #uwOverlay .uw-close:hover { color: var(--red, #ff5b5b); border-color: color-mix(in srgb, var(--red, #ff5b5b) 45%, transparent); background: color-mix(in srgb, var(--red, #ff5b5b) 12%, transparent); }
      #uwOverlay .uw-body {
        flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px;
        scrollbar-width: thin; scrollbar-color: rgba(var(--accent-rgb,224,108,117), .45) transparent;
      }
      #uwOverlay .uw-body::-webkit-scrollbar { width: 8px; }
      #uwOverlay .uw-body::-webkit-scrollbar-thumb { background: rgba(var(--accent-rgb,224,108,117), .4); border-radius: 8px; }
      #uwOverlay .uw-card { background: var(--surface2, #2c313c); border: 1px solid var(--border, #355a66); border-radius: 12px; padding: 16px; }
      #uwOverlay .uw-card h3 { font-size: .68rem; letter-spacing: 1.8px; text-transform: uppercase; color: var(--text2, #7fb8cc); margin: 0 0 14px; display: flex; align-items: center; gap: 8px; font-weight: 800; }
      #uwOverlay .uw-card h3 svg { opacity: .65; }
      #uwOverlay .uw-acct { display: flex; align-items: center; gap: 13px; }
      #uwOverlay .uw-avatar { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 19px; font-weight: 800; color: #fff; background: linear-gradient(135deg, var(--purple2, #eb8a91), var(--gold, #d19a66)); flex-shrink: 0; }
      #uwOverlay .uw-acct-meta { flex: 1; min-width: 0; }
      #uwOverlay .uw-acct-name { font-size: .96rem; font-weight: 700; color: var(--text, #9cdef2); }
      #uwOverlay .uw-acct-role { font-size: .58rem; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted, #6b8a94); margin-top: 2px; }
      #uwOverlay .uw-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 9px 13px; border-radius: 9px; border: 1px solid var(--border, #355a66); background: transparent; color: var(--text2, #7fb8cc); font-family: inherit; font-size: .78rem; font-weight: 700; cursor: pointer; transition: all .15s; white-space: nowrap; }
      #uwOverlay .uw-btn:hover { border-color: var(--accent, #e06c75); color: var(--text, #9cdef2); background: rgba(var(--accent-rgb,224,108,117), .10); }
      #uwOverlay .uw-btn-primary { background: linear-gradient(135deg, var(--purple2, #eb8a91), var(--gold, #d19a66)); color: #fff; border: none; }
      #uwOverlay .uw-btn-primary:hover { filter: brightness(1.08); background: linear-gradient(135deg, var(--purple2, #eb8a91), var(--gold, #d19a66)); }
      #uwOverlay .uw-btn-danger { color: var(--red, #ff5b5b); border-color: color-mix(in srgb, var(--red, #ff5b5b) 45%, transparent); }
      #uwOverlay .uw-btn-danger:hover { background: color-mix(in srgb, var(--red, #ff5b5b) 12%, transparent); border-color: var(--red, #ff5b5b); color: var(--red, #ff5b5b); }
      #uwOverlay .uw-btn-sm { padding: 6px 11px; font-size: .72rem; }
      #uwOverlay label.uw-fld { display: block; font-size: .7rem; color: var(--text2, #7fb8cc); margin: 0 0 5px; }
      #uwOverlay input[type=text], #uwOverlay input[type=password] { width: 100%; padding: 9px 11px; background: var(--bg, #282c34); border: 1px solid var(--border, #355a66); border-radius: 8px; color: var(--text, #9cdef2); font-size: .85rem; font-family: var(--font-mono, monospace); outline: none; }
      #uwOverlay input:focus { border-color: var(--accent, #e06c75); }
      #uwOverlay .uw-row { display: flex; gap: 9px; flex-wrap: wrap; align-items: flex-end; }
      #uwOverlay .uw-row > div { flex: 1; min-width: 140px; }
      #uwOverlay .uw-msg { font-size: .74rem; margin-top: 4px; min-height: 1em; }
      #uwOverlay .uw-msg.ok { color: var(--green, #50fa7b); } #uwOverlay .uw-msg.err { color: var(--red, #ff5b5b); }
      #uwOverlay .uw-switch { position: relative; display: inline-block; width: 42px; height: 24px; flex-shrink: 0; }
      #uwOverlay .uw-switch input { opacity: 0; width: 0; height: 0; }
      #uwOverlay .uw-slider { position: absolute; inset: 0; cursor: pointer; background: var(--surface3, #1b1e24); border: 1px solid var(--border, #355a66); border-radius: 24px; transition: .2s; }
      #uwOverlay .uw-slider:before { content: ''; position: absolute; height: 16px; width: 16px; left: 3px; bottom: 3px; background: var(--muted, #6b8a94); border-radius: 50%; transition: .2s; }
      #uwOverlay .uw-switch input:checked + .uw-slider { background: rgba(var(--accent-rgb,224,108,117), .30); border-color: var(--accent, #e06c75); }
      #uwOverlay .uw-switch input:checked + .uw-slider:before { transform: translateX(18px); background: var(--accent, #e06c75); }
      #uwOverlay .uw-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
      #uwOverlay .uw-sub { font-size: .7rem; color: var(--muted, #6b8a94); margin-top: 3px; }
      #uwOverlay .uw-user-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 1px solid var(--border, #355a66); border-radius: 10px; margin-bottom: 8px; background: var(--surface, #21252b); }
      #uwOverlay .uw-user-row:last-child { margin-bottom: 0; }
      #uwOverlay .uw-uid { display: flex; align-items: center; gap: 11px; min-width: 0; }
      #uwOverlay .uw-uav { width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; color: var(--accent, #e06c75); background: color-mix(in srgb, var(--accent, #e06c75) 18%, var(--surface3, #1b1e24)); flex-shrink: 0; }
      #uwOverlay .uw-uname { font-size: .85rem; font-weight: 600; color: var(--text, #9cdef2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #uwOverlay .uw-badge { font-size: .52rem; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; padding: 2px 7px; border-radius: 20px; background: linear-gradient(135deg, var(--purple, #e06c75), var(--gold, #d19a66)); color: #fff; margin-left: 7px; vertical-align: 1px; }
      #uwOverlay .uw-uactions { display: flex; gap: 7px; flex-shrink: 0; }
      #uwOverlay .uw-empty { color: var(--muted, #6b8a94); font-size: .82rem; text-align: center; padding: 12px; }
      #uwOverlay .uw-note { font-size: .8rem; color: var(--text2, #7fb8cc); line-height: 1.6; }
      #uwOverlay .uw-divider { height: 1px; background: var(--border, #355a66); margin: 14px 0; opacity: .6; }
    `;
    var el = document.createElement('style');
    el.id = 'tva-users-widget-css';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function bodyHTML() {
    return `
      <section class="uw-card">
        <h3><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>Account</h3>
        <div class="uw-acct">
          <div class="uw-avatar" id="uwAvatar">?</div>
          <div class="uw-acct-meta"><div class="uw-acct-name" id="uwName">—</div><div class="uw-acct-role" id="uwRole"></div></div>
          <button class="uw-btn uw-btn-danger" id="uwLogout" type="button">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>Sign out
          </button>
        </div>
        <div class="uw-divider"></div>
        <label class="uw-fld">Change password</label>
        <div class="uw-row">
          <div><input type="password" id="uwCpCur" placeholder="Current password" autocomplete="current-password"></div>
          <div><input type="password" id="uwCpNew" placeholder="New password (min 8)" autocomplete="new-password"></div>
        </div>
        <div class="uw-row" style="margin-top:9px">
          <div><input type="password" id="uwCpConf" placeholder="Confirm new password" autocomplete="new-password"></div>
          <button class="uw-btn uw-btn-primary" id="uwCpBtn" type="button">Update</button>
        </div>
        <div class="uw-msg" id="uwCpMsg"></div>
      </section>

      <section class="uw-card" id="uwNotAdmin" style="display:none">
        <p class="uw-note">You're signed in as a standard user. User management is available to administrators only.</p>
      </section>

      <section class="uw-card uw-admin" style="display:none">
        <h3><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Access</h3>
        <div class="uw-toggle-row">
          <div><div style="font-weight:600;font-size:.85rem">Open signup</div><div class="uw-sub">Allow anyone to create an account from the login page</div></div>
          <label class="uw-switch"><input type="checkbox" id="uwSignup"><span class="uw-slider"></span></label>
        </div>
      </section>

      <section class="uw-card uw-admin" style="display:none">
        <h3><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Users</h3>
        <div id="uwList"><div class="uw-empty">Loading…</div></div>
      </section>

      <section class="uw-card uw-admin" style="display:none">
        <h3><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>Add user</h3>
        <div class="uw-row">
          <div><label class="uw-fld">Username</label><input type="text" id="uwNewUser" placeholder="username"></div>
          <div><label class="uw-fld">Password</label><input type="password" id="uwNewPass" placeholder="min 8 characters"></div>
        </div>
        <div class="uw-toggle-row" style="margin-top:12px">
          <div><div style="font-weight:600;font-size:.85rem">Administrator</div><div class="uw-sub">Full access, including user management</div></div>
          <label class="uw-switch"><input type="checkbox" id="uwNewAdmin"><span class="uw-slider"></span></label>
        </div>
        <div class="uw-row" style="margin-top:12px">
          <button class="uw-btn uw-btn-primary" id="uwAddBtn" type="button">Add user</button>
          <div class="uw-msg" id="uwAddMsg" style="flex:1"></div>
        </div>
      </section>`;
  }

  function $(id) { return document.getElementById(id); }

  function build() {
    injectStyle();
    overlay = document.createElement('div');
    overlay.id = 'uwOverlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div id="uwWindow" role="dialog" aria-modal="true" aria-label="User Management">' +
        '<div class="uw-titlebar" id="uwTitlebar">' +
          '<span class="uw-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>User Management</span>' +
          '<button class="uw-close" id="uwClose" type="button" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="uw-body">' + bodyHTML() + '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    win = $('uwWindow');

    // Close interactions
    $('uwClose').addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay && !overlay.hidden) close(); });

    wireDrag();
    wireActions();
    built = true;
  }

  // ── Drag the window by its title bar (pointer events cover mouse + touch) ──
  function wireDrag() {
    var bar = $('uwTitlebar');
    var drag = null;
    bar.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.uw-close')) return;
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

  // ── Data + actions ──
  function wireActions() {
    $('uwLogout').addEventListener('click', logout);
    $('uwCpBtn').addEventListener('click', changePassword);
    $('uwAddBtn').addEventListener('click', addUser);
    $('uwSignup').addEventListener('change', toggleSignup);
  }

  async function logout() {
    try { await jreq('/api/auth/logout'); } catch (e) {}
    try {
      var keep = { 'trendvault-ai-theme': 1, 'trendvault-ai-last-user': 1 };
      var rm = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && !keep[k]) rm.push(k); }
      rm.forEach(function (k) { localStorage.removeItem(k); });
      sessionStorage.clear();
    } catch (e) {}
    window.location.href = '/login';
  }

  async function loadStatus() {
    var d = null;
    try { d = await (await fetch('/api/auth/status', { credentials: 'same-origin' })).json(); } catch (e) {}
    if (!d || !d.authenticated) { close(); window.location.href = '/login'; return; }
    var name = d.username || 'user', isAdmin = !!d.is_admin;
    $('uwAvatar').textContent = name.charAt(0).toUpperCase();
    $('uwName').textContent = name;
    $('uwRole').textContent = isAdmin ? 'Admin' : 'User';
    overlay.querySelectorAll('.uw-admin').forEach(function (c) { c.style.display = isAdmin ? '' : 'none'; });
    $('uwNotAdmin').style.display = isAdmin ? 'none' : '';
    if (isAdmin) { $('uwSignup').checked = !!d.signup_enabled; loadUsers(); }
  }

  async function loadUsers() {
    var list = $('uwList');
    try {
      var r = await fetch('/api/auth/users', { credentials: 'same-origin' });
      if (r.status === 401 || r.status === 403) { list.innerHTML = '<div class="uw-empty">Access denied</div>'; return; }
      var users = (await r.json()).users || [];
      if (!users.length) { list.innerHTML = '<div class="uw-empty">No users</div>'; return; }
      list.innerHTML = '';
      users.forEach(function (u) {
        var row = document.createElement('div');
        row.className = 'uw-user-row';
        var initial = (u.username || '?').charAt(0).toUpperCase();
        row.innerHTML =
          '<div class="uw-uid"><span class="uw-uav">' + esc(initial) + '</span>' +
          '<span class="uw-uname">' + esc(u.username) + (u.is_admin ? '<span class="uw-badge">Admin</span>' : '') + '</span></div>' +
          '<div class="uw-uactions"><button class="uw-btn uw-btn-sm" data-rename="' + esc(u.username) + '">Rename</button>' +
          (u.is_admin ? '' : '<button class="uw-btn uw-btn-sm uw-btn-danger" data-del="' + esc(u.username) + '">Remove</button>') + '</div>';
        list.appendChild(row);
      });
      list.querySelectorAll('[data-rename]').forEach(function (b) { b.addEventListener('click', function () { renameUser(b.getAttribute('data-rename')); }); });
      list.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { deleteUser(b.getAttribute('data-del')); }); });
    } catch (e) { list.innerHTML = '<div class="uw-empty">Failed to load users</div>'; }
  }

  async function renameUser(oldName) {
    var next = window.prompt('Rename "' + oldName + '" to:', oldName);
    if (next == null) return;
    next = next.trim();
    if (!next || next === oldName) return;
    try {
      var r = await jreq('/api/auth/users/' + encodeURIComponent(oldName) + '/rename', { username: next }, 'PUT');
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) { alert(d.detail || 'Failed to rename'); return; }
      if (d.renamed_self) { window.location.reload(); return; }
      loadUsers();
    } catch (e) { alert('Failed to rename'); }
  }

  async function deleteUser(name) {
    if (!window.confirm('Remove user "' + name + '"? This cannot be undone.')) return;
    try {
      var r = await jreq('/api/auth/users', { username: name }, 'DELETE');
      if (r.ok) loadUsers();
      else { var d = await r.json().catch(function () { return {}; }); alert(d.detail || 'Failed to remove'); }
    } catch (e) { alert('Failed to remove'); }
  }

  async function addUser() {
    var msg = $('uwAddMsg'); msg.textContent = ''; msg.className = 'uw-msg';
    var username = $('uwNewUser').value.trim(), password = $('uwNewPass').value, is_admin = $('uwNewAdmin').checked;
    if (!username) { msg.textContent = 'Username required'; msg.className = 'uw-msg err'; return; }
    if (password.length < 8) { msg.textContent = 'Password must be at least 8 characters'; msg.className = 'uw-msg err'; return; }
    $('uwAddBtn').disabled = true;
    try {
      var r = await jreq('/api/auth/users', { username: username, password: password, is_admin: is_admin });
      var d = await r.json().catch(function () { return {}; });
      if (r.ok) { msg.textContent = 'User created'; msg.className = 'uw-msg ok'; $('uwNewUser').value = ''; $('uwNewPass').value = ''; $('uwNewAdmin').checked = false; loadUsers(); }
      else { msg.textContent = d.detail || 'Failed'; msg.className = 'uw-msg err'; }
    } catch (e) { msg.textContent = 'Request failed'; msg.className = 'uw-msg err'; }
    $('uwAddBtn').disabled = false;
  }

  async function changePassword() {
    var msg = $('uwCpMsg'); msg.textContent = ''; msg.className = 'uw-msg';
    var cur = $('uwCpCur').value, nw = $('uwCpNew').value, cf = $('uwCpConf').value;
    if (!cur || !nw) { msg.textContent = 'Fill in all fields'; msg.className = 'uw-msg err'; return; }
    if (nw.length < 8) { msg.textContent = 'New password must be at least 8 characters'; msg.className = 'uw-msg err'; return; }
    if (nw !== cf) { msg.textContent = 'Passwords do not match'; msg.className = 'uw-msg err'; return; }
    $('uwCpBtn').disabled = true;
    try {
      var r = await jreq('/api/auth/change-password', { current_password: cur, new_password: nw });
      var d = await r.json().catch(function () { return {}; });
      if (r.ok) { msg.textContent = 'Password updated'; msg.className = 'uw-msg ok'; $('uwCpCur').value = ''; $('uwCpNew').value = ''; $('uwCpConf').value = ''; }
      else { msg.textContent = d.detail || 'Failed'; msg.className = 'uw-msg err'; }
    } catch (e) { msg.textContent = 'Request failed'; msg.className = 'uw-msg err'; }
    $('uwCpBtn').disabled = false;
  }

  async function toggleSignup() {
    var want = $('uwSignup').checked;
    try {
      var r = await jreq('/api/auth/open-signup', { enabled: want }, 'PUT');
      var d = await r.json();
      if (!r.ok) throw 0;
      $('uwSignup').checked = !!d.signup_enabled;
    } catch (e) { $('uwSignup').checked = !want; }
  }

  function open() {
    if (!built) build();
    overlay.hidden = false;
    // Center after it's laid out so getBoundingClientRect has real dimensions.
    requestAnimationFrame(centerWindow);
    loadStatus();
  }
  function close() { if (overlay) overlay.hidden = true; }

  window.TVAUsers = { open: open, close: close };
})();
