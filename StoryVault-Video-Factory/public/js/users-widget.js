/**
 * users-widget.js — account & user management as a floating modal.
 * Account: avatar, role, change password, sign out. Admin: open-signup toggle,
 * user list (rename / remove), add user. Calls /api/auth/*.
 *
 * Public API: window.SVUsers = { open(), close() }
 */
(function () {
  'use strict';
  if (window.SVUsers) return;

  var overlay = null, built = false;
  function $(id) { return document.getElementById(id); }
  function api(method, path, body) {
    return fetch('/api/auth' + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(async function (r) { var d = await r.json().catch(function () { return {}; }); if (!r.ok) throw new Error(d.error || ('Failed (' + r.status + ')')); return d; });
  }

  function injectStyle() {
    if (document.getElementById('sv-users-css')) return;
    var css = `
      #suOverlay { position: fixed; inset: 0; z-index: 4200; background: color-mix(in srgb, #000 50%, transparent); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; padding: 24px; }
      #suOverlay[hidden] { display: none; }
      #suWin { width: min(560px, 96vw); max-height: 86vh; overflow: hidden; display: flex; flex-direction: column;
        background: var(--surface, #21252b); border: 1px solid var(--border, #355a66); border-radius: 14px;
        box-shadow: 0 24px 70px rgba(0,0,0,.55); font-family: var(--font-mono, monospace); color: var(--text, #9cdef2); }
      #suWin .su-bar { display: flex; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--border, #355a66); background: color-mix(in srgb, var(--surface3, #1b1e24) 90%, transparent); }
      #suWin .su-bar .t { font-size: .76rem; font-weight: 800; letter-spacing: 1.6px; text-transform: uppercase; color: var(--text2, #7fb8cc); margin-right: auto; }
      #suWin .su-close { width: 28px; height: 28px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--muted, #6b8a94); cursor: pointer; }
      #suWin .su-close:hover { color: var(--red, #ff5b5b); border-color: color-mix(in srgb, var(--red,#ff5b5b) 45%, transparent); }
      #suBody { padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
      #suWin .su-card { background: var(--surface2, #2c313c); border: 1px solid var(--border, #355a66); border-radius: 12px; padding: 14px; }
      #suWin .su-card h3 { font-size: .62rem; letter-spacing: 1.8px; text-transform: uppercase; color: var(--text2,#7fb8cc); margin: 0 0 12px; font-weight: 800; }
      #suWin .su-acct { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
      #suWin .su-av { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #fff; background: linear-gradient(135deg, var(--purple2,#eb8a91), var(--gold,#d19a66)); }
      #suWin .su-nm { font-weight: 700; }
      #suWin .su-role { font-size: .55rem; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted,#6b8a94); }
      #suWin input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border,#355a66); background: var(--surface,#21252b); color: var(--text,#9cdef2); font-family: inherit; font-size: .76rem; margin-bottom: 8px; box-sizing: border-box; }
      #suWin .su-btn { padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border,#355a66); background: transparent; color: var(--text2,#7fb8cc); font-family: inherit; font-size: .74rem; font-weight: 700; cursor: pointer; }
      #suWin .su-btn:hover { border-color: var(--accent,#e06c75); color: var(--text,#9cdef2); }
      #suWin .su-btn.primary { background: linear-gradient(135deg, var(--purple,#e06c75), var(--purple2,#eb8a91)); border: none; color: #fff; }
      #suWin .su-btn.danger { color: var(--red,#ff5b5b); border-color: color-mix(in srgb, var(--red,#ff5b5b) 45%, transparent); }
      #suWin .su-row { display: flex; align-items: center; gap: 8px; }
      #suWin .su-user { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-top: 1px solid color-mix(in srgb, var(--border,#355a66) 55%, transparent); }
      #suWin .su-user .nm { flex: 1; font-size: .76rem; }
      #suWin .su-badge { font-size: .55rem; letter-spacing: 1px; text-transform: uppercase; color: var(--gold,#d19a66); }
      #suWin .su-msg { font-size: .68rem; min-height: 1em; margin-top: 6px; }
      #suWin .su-msg.err { color: var(--red,#ff5b5b); } #suWin .su-msg.ok { color: #86efac; }
      #suWin .su-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    `;
    var el = document.createElement('style'); el.id = 'sv-users-css'; el.textContent = css; document.head.appendChild(el);
  }

  function build() {
    injectStyle();
    overlay = document.createElement('div');
    overlay.id = 'suOverlay'; overlay.hidden = true;
    overlay.innerHTML =
      '<div id="suWin" role="dialog" aria-modal="true">' +
        '<div class="su-bar"><span class="t">Account</span><button class="su-close" id="suClose">✕</button></div>' +
        '<div id="suBody"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    $('suClose').addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay && !overlay.hidden) close(); });
    built = true;
  }

  async function logout() {
    try { await api('POST', '/logout', {}); } catch (e) {}
    try {
      var keep = { 'storyvault-theme': 1, 'storyvault-last-user': 1, 'nav-collapsed': 1 };
      for (var i = localStorage.length - 1; i >= 0; i--) { var k = localStorage.key(i); if (k && !keep[k]) localStorage.removeItem(k); }
    } catch (e) {}
    window.location.href = '/login';
  }

  async function render() {
    var body = $('suBody');
    body.innerHTML = '<div style="opacity:.6;font-size:.78rem">Loading…</div>';
    var s = await api('GET', '/status').catch(function () { return null; });
    if (!s || !s.authenticated) { body.innerHTML = '<div class="su-card">Not signed in. <a href="/login">Sign in</a></div>'; return; }

    var html = '';
    // Account card
    html += '<div class="su-card">' +
      '<div class="su-acct"><div class="su-av">' + (s.username || '?').charAt(0).toUpperCase() + '</div>' +
        '<div><div class="su-nm">' + s.username + '</div><div class="su-role">' + (s.is_admin ? 'Admin' : 'User') + '</div></div></div>' +
      '<h3>Change password</h3>' +
      '<input id="suCur" type="password" placeholder="Current password" autocomplete="current-password"/>' +
      '<input id="suNew" type="password" placeholder="New password (8+ chars)" autocomplete="new-password"/>' +
      '<input id="suNew2" type="password" placeholder="Confirm new password" autocomplete="new-password"/>' +
      '<div class="su-row"><button class="su-btn primary" id="suChange">Update password</button>' +
      '<button class="su-btn danger" id="suLogout" style="margin-left:auto">Sign out</button></div>' +
      '<div class="su-msg" id="suMsg1"></div></div>';

    if (s.is_admin) {
      html += '<div class="su-card"><h3>Access</h3><div class="su-toggle"><span style="font-size:.76rem">Open signup (anyone can create an account)</span>' +
        '<label class="check"><input type="checkbox" id="suSignup"' + (s.signup_enabled ? ' checked' : '') + ' style="width:auto"/> <span></span></label></div></div>';
      html += '<div class="su-card"><h3>Users</h3><div id="suUsers">Loading…</div></div>';
      html += '<div class="su-card"><h3>Add user</h3>' +
        '<input id="suNuName" placeholder="username"/>' +
        '<input id="suNuPass" type="password" placeholder="password (8+ chars)"/>' +
        '<div class="su-row"><label class="check"><input type="checkbox" id="suNuAdmin" style="width:auto"/> <span>Admin</span></label>' +
        '<button class="su-btn primary" id="suAddUser" style="margin-left:auto">Add user</button></div>' +
        '<div class="su-msg" id="suMsg2"></div></div>';
    }
    body.innerHTML = html;

    $('suChange').addEventListener('click', changePassword);
    $('suLogout').addEventListener('click', logout);
    if (s.is_admin) {
      $('suSignup').addEventListener('change', function (e) { api('PUT', '/open-signup', { enabled: e.target.checked }); });
      $('suAddUser').addEventListener('click', addUser);
      loadUsers();
    }
  }

  async function changePassword() {
    var msg = $('suMsg1'); msg.className = 'su-msg';
    var cur = $('suCur').value, nw = $('suNew').value, nw2 = $('suNew2').value;
    if (nw !== nw2) { msg.textContent = 'New passwords do not match.'; msg.className = 'su-msg err'; return; }
    try { await api('POST', '/change-password', { current_password: cur, new_password: nw }); msg.textContent = '✓ Password updated.'; msg.className = 'su-msg ok'; $('suCur').value = $('suNew').value = $('suNew2').value = ''; }
    catch (e) { msg.textContent = e.message; msg.className = 'su-msg err'; }
  }

  async function loadUsers() {
    var box = $('suUsers'); if (!box) return;
    try {
      var d = await api('GET', '/users');
      box.innerHTML = (d.users || []).map(function (u) {
        return '<div class="su-user"><span class="nm">' + u.username + (u.is_admin ? ' <span class="su-badge">admin</span>' : '') + '</span>' +
          '<button class="su-btn" data-rename="' + u.username + '">Rename</button>' +
          '<button class="su-btn danger" data-del="' + u.username + '">Remove</button></div>';
      }).join('') || '<div style="opacity:.6;font-size:.74rem">No users.</div>';
      box.querySelectorAll('[data-rename]').forEach(function (b) { b.addEventListener('click', function () { renameUser(b.getAttribute('data-rename')); }); });
      box.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { delUser(b.getAttribute('data-del')); }); });
    } catch (e) { box.textContent = e.message; }
  }
  async function renameUser(name) {
    var nu = prompt('New username for "' + name + '":', name); if (!nu) return;
    try { await api('PUT', '/users/' + encodeURIComponent(name) + '/rename', { username: nu }); loadUsers(); }
    catch (e) { alert(e.message); }
  }
  async function delUser(name) {
    if (!confirm('Remove user "' + name + '"? This cannot be undone.')) return;
    try { await api('DELETE', '/users', { username: name }); loadUsers(); }
    catch (e) { alert(e.message); }
  }
  async function addUser() {
    var msg = $('suMsg2'); msg.className = 'su-msg';
    try {
      await api('POST', '/users', { username: $('suNuName').value.trim(), password: $('suNuPass').value, is_admin: $('suNuAdmin').checked });
      $('suNuName').value = ''; $('suNuPass').value = ''; $('suNuAdmin').checked = false;
      msg.textContent = '✓ User added.'; msg.className = 'su-msg ok'; loadUsers();
    } catch (e) { msg.textContent = e.message; msg.className = 'su-msg err'; }
  }

  function open() { if (!built) build(); overlay.hidden = false; render(); }
  function close() { if (overlay) overlay.hidden = true; }

  window.SVUsers = { open: open, close: close };
})();
