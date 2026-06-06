/**
 * Automation Map — self-contained toast notifications.
 *
 * Dependency-free (no import of the app's ui.js, which can't be pulled into the
 * Automation Map module graph cleanly). Creates its own host element and shows
 * info / success / error toasts that stack briefly bottom-centre.
 */

let _host = null;

function host() {
  if (_host && document.body.contains(_host)) return _host;
  _host = document.createElement('div');
  _host.className = 'am-toast-host';
  document.body.appendChild(_host);
  return _host;
}

const ICONS = {
  success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  warning: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
};

/**
 * @param {string} msg
 * @param {{type?: 'info'|'success'|'error'|'warning'|'loading', duration?: number}} opts
 */
export function toast(msg, opts = {}) {
  const type = opts.type || 'info';
  const el = document.createElement('div');
  el.className = `am-toast am-toast-${type}`;
  if (type === 'loading') {
    el.innerHTML = '<span class="am-toast-spinner"></span>';
  } else if (ICONS[type]) {
    el.innerHTML = `<span class="am-toast-ico">${ICONS[type]}</span>`;
  }
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  host().appendChild(el);
  // enter
  requestAnimationFrame(() => el.classList.add('show'));
  const duration = opts.duration || (type === 'error' ? 6000 : type === 'loading' ? 4000 : 2600);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, duration);
  return el;
}
