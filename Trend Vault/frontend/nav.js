/**
 * Trend Vault — shared top-bar navigation.
 *
 * Each page mounts the nav by placing one element somewhere in its <header>:
 *
 *   <nav id="tv-nav"></nav>
 *   <script src="/nav.js" defer></script>
 *
 * The script injects scoped styles, renders the grouped link bar, and
 * highlights whichever tool matches the current pathname.
 *
 * Add or rename tools in the TOOLS array below — every page picks up the
 * change automatically on next load.
 */
(function () {
  const TOOLS = [
    {
      group: 'Create',
      items: [
        { href: '/trend-vault',  iconHTML: '<img src="/vault-icon.svg" width="14" height="14" alt="" draggable="false" style="vertical-align:-2px">', label: 'The Vault',  accent: '#a855f7' },
        { href: '/voice-lab',    icon: '🎙️', label: 'Voice Lab',    accent: '#c4b5fd' },
        { href: '/voice-editor', icon: '🎤', label: 'MP3 Editor',   accent: '#f0c040' },
        { href: '/',             icon: '✂️', label: 'Clip Tool',    accent: '#FFE500' },
      ],
    },
    {
      group: 'Hub',
      items: [
        { href: '/mainframe',    icon: '⚡', label: 'Mainframe',    accent: '#c9a227' },
        { href: '/accounts',     icon: '👥', label: 'Accounts',     accent: '#a855f7' },
      ],
    },
    {
      group: 'Distribute',
      items: [
        { href: '/tiktok',       icon: '📤', label: 'TikTok',       accent: '#fe2c55' },
        { href: '/youtube',      icon: '📺', label: 'YouTube',      accent: '#ff0033' },
        { href: '/instagram',    icon: '📸', label: 'Instagram',    accent: '#d62976' },
      ],
    },
  ];

  function normalize(p) {
    if (!p) return '/';
    const clean = p.replace(/\/+$/, '');
    return clean === '' ? '/' : clean;
  }

  function buildNav() {
    const mount = document.getElementById('tv-nav');
    if (!mount) return;
    const here = normalize(location.pathname);
    const groupsHTML = TOOLS.map((g) => {
      const itemsHTML = g.items.map((it) => {
        const isActive = normalize(it.href) === here;
        const icon = it.iconHTML ?? `<span class="tv-ico-emoji">${it.icon || ''}</span>`;
        return `<a href="${it.href}" class="tv-item${isActive ? ' tv-active' : ''}" style="--tv-accent:${it.accent}" data-tool="${it.label}">
          <span class="tv-ico">${icon}</span><span class="tv-lbl">${it.label}</span>
        </a>`;
      }).join('');
      return `<div class="tv-group" data-group="${g.group}">
        <div class="tv-group-label">${g.group}</div>
        <div class="tv-group-items">${itemsHTML}</div>
      </div>`;
    }).join('<div class="tv-divider" aria-hidden="true"></div>');
    mount.innerHTML = groupsHTML;
    mount.classList.add('tv-nav-rendered');
  }

  function injectStyle() {
    if (document.getElementById('tv-nav-style')) return;
    const css = `
      #tv-nav {
        display: flex;
        align-items: stretch;
        gap: 0;
        margin-left: auto;
        flex-wrap: wrap;
        font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      }
      #tv-nav .tv-group {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 0 16px;
        min-width: 0;
        position: relative;
      }
      #tv-nav .tv-group:first-child { padding-left: 0; }
      #tv-nav .tv-group:last-child  { padding-right: 0; }
      #tv-nav .tv-group-label {
        font-family: 'Orbitron', 'Space Grotesk', sans-serif;
        font-size: .54rem;
        letter-spacing: 2.4px;
        font-weight: 700;
        color: rgba(184,168,216,.50);
        text-transform: uppercase;
        padding-left: 3px;
        user-select: none;
      }
      #tv-nav .tv-group-items {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      #tv-nav .tv-divider {
        width: 1px;
        align-self: stretch;
        margin: 4px 0;
        background: linear-gradient(180deg, transparent, rgba(184,168,216,.18), transparent);
      }
      #tv-nav .tv-item {
        --tv-accent: #a855f7;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 7px 12px;
        border-radius: 9px;
        font-size: .73rem;
        font-weight: 600;
        letter-spacing: .35px;
        text-decoration: none;
        color: rgba(232,228,245,.78);
        border: 1px solid rgba(184,168,216,.14);
        background: transparent;
        transition: color .15s, background-color .15s, border-color .15s, box-shadow .18s, transform .12s;
        white-space: nowrap;
        line-height: 1;
      }
      #tv-nav .tv-item:hover {
        color: #ede8f5;
        border-color: color-mix(in srgb, var(--tv-accent) 55%, transparent);
        background: color-mix(in srgb, var(--tv-accent) 10%, transparent);
        transform: translateY(-1px);
      }
      #tv-nav .tv-item.tv-active {
        color: #fff;
        border-color: color-mix(in srgb, var(--tv-accent) 75%, transparent);
        background: color-mix(in srgb, var(--tv-accent) 22%, transparent);
        box-shadow: 0 0 14px color-mix(in srgb, var(--tv-accent) 32%, transparent);
      }
      #tv-nav .tv-ico { display: inline-flex; align-items: center; justify-content: center; line-height: 1; }
      #tv-nav .tv-ico-emoji { font-size: .98rem; line-height: 1; }
      /* Browsers that don't support color-mix (Safari < 16.4 etc.) fall back to translucent purple */
      @supports not (color: color-mix(in srgb, red, blue)) {
        #tv-nav .tv-item:hover { background: rgba(168,85,247,.10); border-color: rgba(168,85,247,.55); }
        #tv-nav .tv-item.tv-active { background: rgba(168,85,247,.22); border-color: rgba(168,85,247,.75); box-shadow: 0 0 14px rgba(168,85,247,.32); }
      }
      @media (max-width: 1100px) {
        #tv-nav { gap: 10px 0; }
        #tv-nav .tv-group { padding: 0 10px; }
      }
      @media (max-width: 880px) {
        #tv-nav {
          width: 100%;
          flex-direction: column;
          align-items: stretch;
          gap: 10px;
          margin-left: 0;
        }
        #tv-nav .tv-group { padding: 0; }
        #tv-nav .tv-divider { display: none; }
      }
    `;
    const el = document.createElement('style');
    el.id = 'tv-nav-style';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function init() {
    injectStyle();
    buildNav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
