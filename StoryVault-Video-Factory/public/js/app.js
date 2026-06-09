/* App shell: navigation, hash router, shared meta/prefs cache, SSE live updates. */
(function () {
  const { el, clear } = UI;

  const NAV = [
    { sep: 'Workspace' },
    { id: 'command', label: 'Command Center', ico: '◎' },
    { id: 'discovery', label: 'Story Finder', ico: '🔎' },
    { id: 'library', label: 'Story Library', ico: '📚' },
    { id: 'backgrounds', label: 'Footage Library', ico: '🎞' },
    { id: 'templates', label: 'Templates', ico: '▦' },
    { sep: 'Production' },
    { id: 'composer', label: 'Video Studio', ico: '🎬' },
    { id: 'batch', label: 'Batch Factory', ico: '⚙' },
    { id: 'review', label: 'Review Queue', ico: '✅' },
    { id: 'exports', label: 'Exports', ico: '📤' },
    { sep: 'System' },
    { id: 'jobs', label: 'Job Monitor', ico: '📈' },
    { id: 'accounts', label: 'Accounts', ico: '🔑' },
    { id: 'preferences', label: 'Settings', ico: '⚙' },
    { id: 'system', label: 'System Health', ico: '🩺' },
    { id: 'logs', label: 'Logs', ico: '📜' },
  ];

  const App = {
    meta: null, prefs: null, listeners: {},
    on(ev, cb) { (this.listeners[ev] = this.listeners[ev] || []).push(cb); return cb; },
    off(ev, cb) { if (this.listeners[ev]) this.listeners[ev] = this.listeners[ev].filter((x) => x !== cb); },
    emit(ev, data) { (this.listeners[ev] || []).forEach((cb) => { try { cb(data); } catch (e) { console.error(e); } }); },
    go(page) { location.hash = '#/' + page; },
  };
  window.App = App;

  function buildNav() {
    const nav = document.getElementById('nav');
    clear(nav);
    NAV.forEach((item) => {
      if (item.sep) { nav.appendChild(el('div.nav-sep', item.sep)); return; }
      nav.appendChild(el('div.nav-item', { 'data-page': item.id, title: item.label, onclick: () => App.go(item.id) }, [el('span.ico', item.ico), el('span.nav-label', item.label)]));
    });
  }

  function setActive(page) {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
    const item = NAV.find((n) => n.id === page);
    document.getElementById('pageTitle').textContent = item ? item.label : 'StoryVault';
  }

  async function route() {
    const page = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'dashboard';
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
    // Collapsible sidebar (icons-only with tooltips); preference persisted.
    const collapseBtn = document.getElementById('navCollapse');
    if (collapseBtn) {
      const apply = (on) => document.body.classList.toggle('nav-collapsed', on);
      apply(localStorage.getItem('nav-collapsed') === '1');
      collapseBtn.onclick = () => { const on = !document.body.classList.contains('nav-collapsed'); apply(on); localStorage.setItem('nav-collapsed', on ? '1' : '0'); };
    }
  }

  async function boot() {
    buildNav(); bindChrome();
    try { App.meta = await API.get('/meta'); } catch (e) { UI.toast('Failed to load app metadata: ' + e.message, 'err'); }
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
