/**
 * TrendVault — shared theme system (ported from the TrendVault AI / Coder).
 *
 * Mirrors the Coder's theme.js: a preset map of {bg,fg,panel,border,red},
 * applied to :root via style.setProperty, persisted in localStorage under
 * the SAME key ('trendvault-ai-theme'). Each preset is expanded into the
 * full token set the studio's components use (--surface/--accent/--gold/…)
 * so the whole UI recolors. The old purple/gold studio look is preserved
 * as the selectable "vault" theme — nothing is lost.
 *
 * Load this in <head> WITHOUT defer so the saved theme is applied before
 * first paint (no flash); the picker mounts on DOMContentLoaded.
 */
(function () {
  'use strict';

  var LS_KEY = 'trendvault-ai-theme';
  var DEFAULT = 'dark';

  // Coder presets (verbatim) + "vault" = the original studio purple/gold.
  var THEMES = {
    dark:      { bg: '#282c34', fg: '#9cdef2', panel: '#21252b', border: '#355a66', red: '#e06c75' },
    vault:     { bg: '#040208', fg: '#f8f4ff', panel: '#0b0814', border: '#3a2860', red: '#a855f7',
                 ext: { '--surface': '#0b0814', '--surface2': '#120f1e', '--surface3': '#1a1530',
                        '--border2': '#5840a0', '--accent2': '#c9a227', '--gold': '#c9a227',
                        '--gold2': '#f0c040', '--red': '#e53e3e' } },
    claude:    { bg: '#262624', fg: '#f5f4f0', panel: '#30302e', border: '#4a4a47', red: '#c6613f' },
    midnight:  { bg: '#0d1117', fg: '#c9d1d9', panel: '#161b22', border: '#30363d', red: '#f85149' },
    ocean:     { bg: '#0b1a2c', fg: '#64d2ff', panel: '#091422', border: '#1e5074', red: '#4facfe' },
    forest:    { bg: '#1b2a1b', fg: '#a8d5a2', panel: '#142414', border: '#3d6b3d', red: '#7cb871' },
    terminal:  { bg: '#000000', fg: '#00ff41', panel: '#0a0a0a', border: '#003b00', red: '#00ff41' },
    cyberpunk: { bg: '#0a0a0f', fg: '#0ff0fc', panel: '#12101a', border: '#9b30ff', red: '#e040fb' },
    retrowave: { bg: '#1a1a2e', fg: '#e94560', panel: '#16213e', border: '#533483', red: '#e94560' },
    ume:       { bg: '#2b1b2e', fg: '#f5c2e7', panel: '#1e1420', border: '#6c4675', red: '#f5a0c0' },
    copper:    { bg: '#1c1410', fg: '#e8c39e', panel: '#140f0a', border: '#7a5533', red: '#d4764e' },
    organs:    { bg: '#0a0406', fg: '#efe1c8', panel: '#15080a', border: '#3a1519', red: '#c83240' },
    gpt:       { bg: '#212121', fg: '#ececec', panel: '#171717', border: '#424242', red: '#949494' },
    paper:     { bg: '#faf8f5', fg: '#3b3836', panel: '#ffffff', border: '#d5d0c8', red: '#c5ac4a' },
    lavender:  { bg: '#f3eef8', fg: '#3d3551', panel: '#faf7ff', border: '#cec3de', red: '#9b6dcc' },
    cute:      { bg: '#fff0f5', fg: '#d4608a', panel: '#fff8fa', border: '#f0c0d0', red: '#ff6b9d' },
    light:     { bg: '#f0ebe3', fg: '#5a5248', panel: '#faf6f0', border: '#d4cdc2', red: '#c47d5a' }
  };

  var ORDER = ['dark', 'vault', 'claude', 'midnight', 'ocean', 'forest', 'terminal',
               'cyberpunk', 'retrowave', 'ume', 'copper', 'organs', 'gpt',
               'paper', 'lavender', 'cute', 'light'];

  var current = DEFAULT;

  function mix(a, p, b) { return 'color-mix(in srgb, ' + a + ' ' + p + '%, ' + b + ')'; }

  // Hex helpers — emit rgb() components so every hard-coded rgba(224,108,117,α)
  // / rgba(209,154,102,α) in the studio can become rgba(var(--accent-rgb),α)
  // and recolor with the active theme.
  function toRgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbStr(hex) { var c = toRgb(hex); return c[0] + ',' + c[1] + ',' + c[2]; }
  function blendHex(a, p, b) {
    var ca = toRgb(a), cb = toRgb(b), f = p / 100;
    function hx(v) { return ('0' + Math.round(v).toString(16)).slice(-2); }
    return '#' + hx(ca[0] * f + cb[0] * (1 - f)) + hx(ca[1] * f + cb[1] * (1 - f)) + hx(ca[2] * f + cb[2] * (1 - f));
  }

  // Expand a {bg,fg,panel,border,red} preset into the full studio token set.
  function deriveTokens(t) {
    var goldHex = (t.ext && t.ext['--gold']) ? t.ext['--gold'] : blendHex(t.red, 45, '#d9a05a');
    var o = {
      '--bg': t.bg,
      '--fg': t.fg,
      '--text': t.fg,
      '--panel': t.panel,
      '--surface': t.panel,
      '--surface2': mix(t.panel, 82, t.fg),
      '--surface3': mix(t.panel, 86, '#000'),
      '--border': t.border,
      '--border2': mix(t.border, 60, t.fg),
      '--accent': t.red,
      '--accent2': mix(t.red, 70, t.fg),
      '--purple': t.red,
      '--purple2': mix(t.red, 72, '#ffffff'),
      '--purple3': mix(t.red, 55, '#ffffff'),
      '--gold': goldHex,
      '--gold2': '#f0ad4e',
      '--accent-rgb': rgbStr(t.red),
      '--gold-rgb': rgbStr(goldHex),
      '--red': '#ff5b5b',
      '--green': '#50fa7b',
      '--warn': '#f0ad4e',
      '--text2': mix(t.fg, 72, t.bg),
      '--muted': mix(t.fg, 48, t.bg)
    };
    if (t.ext) { for (var k in t.ext) { o[k] = t.ext[k]; } }
    return o;
  }

  function applyTheme(name) {
    var t = THEMES[name] || THEMES[DEFAULT];
    var tokens = deriveTokens(t);
    var s = document.documentElement.style;
    for (var k in tokens) { s.setProperty(k, tokens[k]); }
    document.documentElement.setAttribute('data-theme', name);
    current = name;
    updateActive();
  }

  function save(name) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ theme: name })); } catch (e) { /* ignore */ }
  }

  function load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return DEFAULT;
      var v = JSON.parse(raw);
      if (typeof v === 'string') return THEMES[v] ? v : DEFAULT;
      return (v && v.theme && THEMES[v.theme]) ? v.theme : DEFAULT;
    } catch (e) { return DEFAULT; }
  }

  function pretty(name) { return name.charAt(0).toUpperCase() + name.slice(1); }

  function updateActive() {
    var opts = document.querySelectorAll('.tva-theme-opt');
    for (var i = 0; i < opts.length; i++) {
      opts[i].classList.toggle('active', opts[i].getAttribute('data-theme') === current);
    }
  }

  function buildOption(name) {
    var t = THEMES[name];
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tva-theme-opt';
    b.setAttribute('data-theme', name);
    var sw = document.createElement('span');
    sw.className = 'tva-sw';
    sw.style.background = 'linear-gradient(135deg, ' + t.bg + ' 0 50%, ' + t.red + ' 50% 100%)';
    var nm = document.createElement('span');
    nm.className = 'tva-nm';
    nm.textContent = name === 'vault' ? 'Vault' : pretty(name);
    b.appendChild(sw);
    b.appendChild(nm);
    b.addEventListener('click', function () { applyTheme(name); save(name); });
    return b;
  }

  function mountPicker() {
    if (document.querySelector('.tva-theme-wrap')) return;

    var wrap = document.createElement('div');
    wrap.className = 'tva-theme-wrap';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tva-theme-fab';
    btn.setAttribute('aria-label', 'Change theme');
    btn.innerHTML = '<span class="tva-fab-dot"></span><span class="tva-fab-lbl">Theme</span>';

    var pop = document.createElement('div');
    pop.className = 'tva-theme-pop';
    var title = document.createElement('div');
    title.className = 'tva-theme-pop-title';
    title.textContent = 'Theme';
    pop.appendChild(title);
    ORDER.forEach(function (name) { if (THEMES[name]) pop.appendChild(buildOption(name)); });

    wrap.appendChild(btn);
    wrap.appendChild(pop);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      pop.classList.toggle('open');
      updateActive();
    });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { pop.classList.remove('open'); });

    place(wrap);
    updateActive();
  }

  function place(wrap) {
    var nav = document.getElementById('tv-nav');
    if (nav && nav.parentElement) {
      nav.parentElement.appendChild(wrap);
      wrap.style.marginLeft = '10px';
      return;
    }
    var header = document.querySelector('header');
    if (header) {
      header.appendChild(wrap);
      wrap.style.marginLeft = 'auto';
      return;
    }
    wrap.style.position = 'fixed';
    wrap.style.top = '12px';
    wrap.style.right = '14px';
    wrap.style.zIndex = '3000';
    (document.body || document.documentElement).appendChild(wrap);
  }

  // Apply saved theme immediately (before paint), mount picker when DOM ready.
  applyTheme(load());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPicker);
  } else {
    mountPicker();
  }

  // Expose a tiny API for pages that want to drive the theme programmatically.
  window.TVATheme = { apply: function (n) { applyTheme(n); save(n); }, get: function () { return current; }, THEMES: THEMES };
})();
