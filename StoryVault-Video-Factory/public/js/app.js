/* App shell: navigation, hash router, shared meta/prefs cache, SSE live updates. */
(function () {
  const { el, clear } = UI;

  const NAV = [
    { sep: 'Workspace' },
    { id: 'command', label: 'Command Center', ico: '◎', acc: '#e06c75' },
    { id: 'library', label: 'Story Library', ico: '📚', acc: '#9cdef2' },
    { id: 'backgrounds', label: 'Footage Library', ico: '🎞', acc: '#d19a66' },
    { id: 'templates', label: 'Templates', ico: '▦', acc: '#f0ad4e' },
    { id: 'presets', label: 'Presets', ico: '✦', acc: '#7fb8cc' },
    { sep: 'Production' },
    { id: 'composer', label: 'Video Studio', ico: '🎬', acc: '#e06c75' },
    { id: 'batch', label: 'Batch Factory', ico: '⚙', acc: '#d19a66' },
    { id: 'review', label: 'Review Queue', ico: '✅', acc: '#50fa7b' },
    { id: 'exports', label: 'Exports', ico: '📤', acc: '#9cdef2' },
    { sep: 'Voice' },
    { id: 'voiceLab', label: 'Voice Lab', ico: '🎙', acc: '#f0a6ab' },
    { id: 'voicePresets', label: 'Voice Presets', ico: '🎚', acc: '#d19a66' },
    { sep: 'System' },
    { id: 'jobs', label: 'Job Monitor', ico: '📈', acc: '#9cdef2' },
    { id: 'accounts', label: 'Source Accounts', ico: '🔑', acc: '#7fb8cc' },
    { id: 'preferences', label: 'Settings', ico: '⚙', acc: '#d19a66' },
    { id: 'system', label: 'System Health', ico: '🩺', acc: '#50fa7b' },
    { id: 'logs', label: 'Logs', ico: '📜', acc: '#6b8a94' },
  ];

  const App = {
    meta: null, prefs: null, listeners: {},
    on(ev, cb) { (this.listeners[ev] = this.listeners[ev] || []).push(cb); return cb; },
    off(ev, cb) { if (this.listeners[ev]) this.listeners[ev] = this.listeners[ev].filter((x) => x !== cb); },
    emit(ev, data) { (this.listeners[ev] || []).forEach((cb) => { try { cb(data); } catch (e) { console.error(e); } }); },
    go(page) { location.hash = '#/' + page; },
    async refreshMeta() { try { this.meta = await API.get('/meta'); this.emit('meta', this.meta); } catch { /* */ } },
  };
  window.App = App;

  function buildNav() {
    const nav = document.getElementById('nav');
    clear(nav);
    NAV.forEach((item) => {
      if (item.sep) { nav.appendChild(el('div.nav-sep', item.sep)); return; }
      nav.appendChild(el('div.nav-item', { 'data-page': item.id, title: item.label, style: item.acc ? { '--tv-accent': item.acc } : null, onclick: () => App.go(item.id) }, [el('span.ico', item.ico), el('span.nav-label', item.label)]));
    });
  }

  function setActive(page) {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
    const item = NAV.find((n) => n.id === page);
    document.getElementById('pageTitle').textContent = item ? item.label : 'StoryVault';
  }

  async function route() {
    let page = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'dashboard';
    if (page === 'discovery') { location.hash = '#/library'; return; } // Story Finder folded into Library
    if (page === 'voices' || page === 'fishspeech') { location.hash = '#/voiceLab'; return; } // folded into Voice Lab
    const param = location.hash.split('/')[2] || null;
    setActive(page);
    document.getElementById('sidebar').classList.remove('open');
    const view = document.getElementById('view');
    clear(view); view.appendChild(UI.spinner());
    const fn = PAGES[page] || PAGES.command;
    try { await fn(view, param); }
    catch (e) { clear(view); view.appendChild(UI.empty('⚠️', 'Could not load this page', e.message)); console.error(e); }
  }

  // SSE live activity stream ---------------------------------------------------
  const logBody = document.getElementById('logBody');
  function addLogLine(row) {
    const line = el('div.log-line ' + (row.level || 'info'), [el('span.tag', '[' + row.tag + '] '), document.createTextNode(row.message)]);
    logBody.insertBefore(line, logBody.firstChild);
    while (logBody.childElementCount > 400) logBody.removeChild(logBody.lastChild);
    document.getElementById('activityTicker').textContent = row.message;
  }
  function connectStream() {
    try {
      const es = new EventSource('/api/stream');
      es.addEventListener('activity', (e) => { const row = JSON.parse(e.data); addLogLine(row); App.emit('activity', row); });
      es.addEventListener('progress', (e) => App.emit('progress', JSON.parse(e.data)));
      es.onerror = () => { /* browser auto-reconnects */ };
    } catch (e) { console.warn('SSE unavailable', e); }
  }

  async function refreshStatusMini() {
    try {
      const s = await API.get('/system/status');
      const mini = document.getElementById('statusMini');
      clear(mini);
      const items = [['DB', s.database], ['FFmpeg', s.ffmpeg], ['TTS', s.tts], ['Footage', s.backgroundLibrary]];
      items.forEach(([name, st]) => {
        const cls = st.status === 'Ready' ? 'ok' : (st.status === 'Loading' ? 'loading' : (['Missing', 'Limited', 'Degraded'].includes(st.status) ? 'warn' : 'err'));
        mini.appendChild(el('div.sm-row', [el('span.dot.' + cls), el('span', name)]));
      });
    } catch { /* ignore */ }
  }

  function bindChrome() {
    document.getElementById('logBtn').onclick = () => document.getElementById('logPanel').classList.toggle('hidden');
    document.getElementById('logClose').onclick = () => document.getElementById('logPanel').classList.add('hidden');
    document.getElementById('navToggle').onclick = () => document.getElementById('sidebar').classList.toggle('open');
    // Settings widget (Appearance / AI Model / Account / About).
    const setBtn = document.getElementById('settingsBtn');
    if (setBtn) setBtn.onclick = () => { if (window.SVSettings) window.SVSettings.open(); else App.go('preferences'); };
    // Sidebar account row → user-management widget.
    const acct = document.getElementById('sbAccount');
    if (acct) acct.onclick = () => { if (window.SVUsers) window.SVUsers.open(); };
    const out = document.getElementById('logoutBtn');
    if (out) out.onclick = () => logout();
    // Collapsible sidebar (icons-only with tooltips); preference persisted.
    const collapseBtn = document.getElementById('navCollapse');
    if (collapseBtn) {
      const apply = (on) => document.body.classList.toggle('nav-collapsed', on);
      apply(localStorage.getItem('nav-collapsed') === '1');
      collapseBtn.onclick = () => { const on = !document.body.classList.contains('nav-collapsed'); apply(on); localStorage.setItem('nav-collapsed', on ? '1' : '0'); };
    }
  }

  async function logout() {
    try { await API.post('/auth/logout', {}); } catch { /* ignore */ }
    const keep = { theme: localStorage.getItem('storyvault-theme'), lastUser: localStorage.getItem('storyvault-last-user') };
    try { localStorage.clear(); } catch { /* ignore */ }
    if (keep.theme) localStorage.setItem('storyvault-theme', keep.theme);
    if (keep.lastUser) localStorage.setItem('storyvault-last-user', keep.lastUser);
    window.location.href = '/login';
  }

  // Populate the sidebar account row from /api/auth/status. Hidden when auth is
  // disabled / not configured (so the app works fine with no accounts).
  async function loadAccount() {
    try {
      const s = await API.get('/auth/status');
      App.auth = s;
      const row = document.getElementById('sbAccount');
      const out = document.getElementById('logoutBtn');
      if (s && s.authenticated && s.username) {
        document.getElementById('sbAvatar').textContent = s.username.charAt(0).toUpperCase();
        document.getElementById('sbAcctName').textContent = s.username;
        document.getElementById('sbAcctRole').textContent = s.is_admin ? 'Admin' : 'User';
        row.classList.remove('hidden');
        if (out) out.classList.remove('hidden');
      } else {
        row.classList.add('hidden');
        if (out) out.classList.add('hidden');
      }
    } catch { /* auth not enabled */ }
  }
  App.loadAccount = loadAccount;

  async function boot() {
    buildNav(); bindChrome();
    try { App.meta = await API.get('/meta'); }
    catch (e) {
      if (/\b401\b|not authenticated/i.test(e.message)) { window.location.href = '/login'; return; }
      UI.toast('Failed to load app metadata: ' + e.message, 'err');
    }
    loadAccount();
    try { App.prefs = await API.get('/preferences'); } catch { App.prefs = {}; }
    try { const log = await API.get('/activity?limit=60'); log.reverse().forEach(addLogLine); } catch { /* */ }
    connectStream();
    refreshStatusMini();
    setInterval(refreshStatusMini, 20000);
    window.addEventListener('hashchange', route);
    if (!location.hash || location.hash === '#/' || location.hash === '#/dashboard') location.hash = '#/command';
    route();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
