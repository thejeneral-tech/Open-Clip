/**
 * Automation Map — floating panels (ported from HealthPanel.tsx +
 * SearchFilterPanel.tsx). Connection-health summary (bottom-left) and
 * search & filters (top-left). Both toggle via the toolbar / store ui flags.
 */

import * as store from './store.js';
import { el, clear, cx, icon } from './dom.js';
import { KIND_META, KIND_ORDER, STATUS_META, STATUS_ORDER, HEALTH_META, HEALTH_ORDER } from './registry.js';
import { validateWorkflow, summarizeWorkflow } from './validation.js';
import { nodeMatchesFilters } from './filtering.js';

const ATTENTION = ['missing-input', 'missing-output', 'broken-chain', 'needs-review'];
const SHORT = {
  ready: 'Ready', connected: 'Connected', 'needs-review': 'Needs review',
  'missing-input': 'Missing input', 'missing-output': 'Missing output', 'broken-chain': 'Broken chain',
};
const MAX_VISIBLE = 8;

/* ====================== Health panel ====================== */
export function createHealthPanel(api = {}) {
  const root = el('section', { class: 'am-panel am-health' });
  let collapsed = false;

  function render() {
    const state = store.getState();
    root.style.display = state.ui.showHealth ? '' : 'none';
    if (!state.ui.showHealth) return;
    clear(root);

    const health = validateWorkflow(state.nodes, state.edges);
    const summary = summarizeWorkflow(state.nodes, state.edges, health);
    const attention = [];
    for (const n of state.nodes) {
      const level = health[n.id]?.level;
      if (level && ATTENTION.includes(level)) attention.push({ id: n.id, title: n.data.title.trim() || 'Untitled node', level });
    }
    const attentionCount = ATTENTION.reduce((s, l) => s + summary.counts[l], 0);
    const ready = summary.readyToBuild;
    const isEmpty = summary.total === 0;
    const headColor = ready ? HEALTH_META.ready.color : attentionCount > 0 ? HEALTH_META['needs-review'].color : HEALTH_META.connected.color;
    const headText = isEmpty ? 'No nodes yet' : ready ? 'Ready to build' : attentionCount > 0 ? `${attentionCount} ${attentionCount === 1 ? 'issue' : 'issues'}` : 'In progress';

    if (collapsed) {
      root.classList.add('collapsed');
      root.appendChild(el('button', { class: 'am-health-pill', title: 'Show connection health', onclick: () => { collapsed = false; render(); } },
        el('span', { style: { color: headColor }, html: icon(ready ? 'checkCircle' : attentionCount > 0 ? 'alertTriangle' : 'activity', 15) }),
        el('span', { style: ready ? { color: headColor } : null, text: headText }),
        el('span', { class: 'am-muted', html: icon('chevronUp', 14) }),
      ));
      return;
    }
    root.classList.remove('collapsed');

    root.appendChild(el('header', { class: 'am-panel-head' },
      el('span', { class: 'am-accent-ico', html: icon('activity', 15) }),
      el('span', { class: 'am-panel-title', text: 'Connection health' }),
      el('div', { class: 'am-panel-actions' },
        el('button', { class: 'am-icon-btn am-sm', title: 'Collapse', onclick: () => { collapsed = true; render(); }, html: icon('chevronUp', 15) }),
        el('button', { class: 'am-icon-btn am-sm', title: 'Hide panel', onclick: () => store.setUi({ showHealth: false }), html: icon('x', 15) }),
      ),
    ));

    const body = el('div', { class: 'am-health-body' });
    body.appendChild(el('div', { class: 'am-health-headline' },
      el('span', { style: { color: headColor }, html: icon(ready ? 'checkCircle' : 'alertTriangle', 18) }),
      el('div', null,
        el('p', { class: 'am-health-h', style: ready ? { color: headColor } : null, text: isEmpty ? 'No nodes yet' : ready ? 'Ready to build' : attentionCount > 0 ? `${attentionCount} ${attentionCount === 1 ? 'node needs' : 'nodes need'} attention` : 'Workflow in progress' }),
        el('p', { class: 'am-muted-note', text: `${summary.total} ${summary.total === 1 ? 'node' : 'nodes'} on canvas` }),
      ),
    ));

    const breakdown = HEALTH_ORDER.filter((l) => summary.counts[l] > 0);
    if (breakdown.length) {
      const bd = el('div', { class: 'am-health-breakdown' });
      for (const l of breakdown) {
        bd.appendChild(el('div', { class: 'am-health-line' },
          el('span', { class: 'am-dot', style: { background: HEALTH_META[l].color } }),
          el('span', { class: 'am-muted', text: HEALTH_META[l].label }),
          el('span', { class: 'am-health-count', text: String(summary.counts[l]) }),
        ));
      }
      body.appendChild(bd);
    }

    if (summary.globalIssues.length) {
      const gi = el('div', { class: 'am-global-issues' });
      for (const issue of summary.globalIssues) {
        gi.appendChild(el('div', { class: 'am-global-issue' },
          el('span', { style: { color: HEALTH_META['needs-review'].color }, html: icon('alertTriangle', 13) }),
          el('span', { text: issue })));
      }
      body.appendChild(gi);
    }

    if (attention.length) {
      const sec = el('div', { class: 'am-attention' }, el('p', { class: 'am-label', text: 'Needs attention' }));
      const ul = el('ul', { class: 'am-attention-list' });
      for (const a of attention.slice(0, MAX_VISIBLE)) {
        ul.appendChild(el('li', null, el('button', {
          class: 'am-attention-item', title: `Jump to ${a.title}`,
          onclick: () => { store.setSelectedNode(a.id); api.focusNode?.(a.id); },
        },
          el('span', { class: 'am-dot', style: { background: HEALTH_META[a.level].color } }),
          el('span', { class: 'am-attention-name', text: a.title }),
          el('span', { class: 'am-attention-tag', style: { color: HEALTH_META[a.level].color }, text: SHORT[a.level] }),
          el('span', { class: 'am-attention-chev', html: icon('chevronRight', 13) }),
        )));
      }
      sec.appendChild(ul);
      const overflow = attention.length - MAX_VISIBLE;
      if (overflow > 0) sec.appendChild(el('p', { class: 'am-muted-note', text: `+${overflow} more` }));
      body.appendChild(sec);
    }

    root.appendChild(body);
  }

  const unsub = store.subscribe(render);
  render();
  return { el: root, destroy() { unsub(); } };
}

/* ====================== Search & filters ====================== */
export function createSearchPanel() {
  const root = el('div', { class: 'am-panel am-search' });
  let collapsed = false;
  let editing = false;

  root.addEventListener('focusin', (e) => { if (e.target.matches('input[type=text], .am-search-input')) editing = true; });
  root.addEventListener('focusout', () => { editing = false; });

  function render() {
    const state = store.getState();
    root.style.display = state.ui.showSearch ? '' : 'none';
    if (!state.ui.showSearch) return;
    clear(root);

    const f = state.filters;
    const health = validateWorkflow(state.nodes, state.edges);
    const allTags = Array.from(new Set(state.nodes.flatMap((n) => n.data.tags.map((t) => t.trim()).filter(Boolean)))).sort((a, b) => a.localeCompare(b));
    const matchCount = state.nodes.reduce((c, n) => nodeMatchesFilters(n, f, state.activeSpace, health[n.id]) ? c + 1 : c, 0);
    const activeCount = (f.search.trim() ? 1 : 0) + f.statuses.length + f.kinds.length + f.tags.length + (f.brokenOnly ? 1 : 0) + (f.unfinishedOnly ? 1 : 0);

    if (collapsed) {
      root.appendChild(el('div', { class: 'am-search-collapsed' },
        el('button', { class: 'am-search-expand', title: 'Expand search & filters', onclick: () => { collapsed = false; render(); } },
          el('span', { class: 'am-muted', html: icon('search', 15) }),
          el('span', { text: activeCount > 0 ? `Filters (${activeCount} active)` : 'Filters' }),
          el('span', { class: 'am-muted', html: icon('chevronDown', 15) }),
        ),
        el('button', { class: 'am-icon-btn', title: 'Hide panel', onclick: () => store.setUi({ showSearch: false }), html: icon('x', 15) }),
      ));
      return;
    }

    root.appendChild(el('div', { class: 'am-panel-head' },
      el('span', { class: 'am-accent-ico', html: icon('filter', 15) }),
      el('span', { class: 'am-panel-title', text: 'Search & filters' }),
      activeCount > 0 ? el('span', { class: 'am-chip am-accent-chip', text: String(activeCount) }) : null,
      el('div', { class: 'am-panel-actions' },
        el('button', { class: 'am-icon-btn am-sm', title: 'Collapse', onclick: () => { collapsed = true; render(); }, html: icon('chevronUp', 15) }),
        el('button', { class: 'am-icon-btn am-sm', title: 'Hide panel', onclick: () => store.setUi({ showSearch: false }), html: icon('x', 15) }),
      ),
    ));

    const body = el('div', { class: 'am-search-body' });

    /* search box */
    const searchInput = el('input', {
      type: 'text', class: 'am-input am-search-input', placeholder: 'Search nodes…', value: f.search,
      oninput: (e) => store.setFilters({ search: e.target.value }),
    });
    const searchWrap = el('div', { class: 'am-search-box' },
      el('span', { class: 'am-search-ico', html: icon('search', 15) }), searchInput);
    if (f.search) searchWrap.appendChild(el('button', { class: 'am-search-clear', title: 'Clear search', onclick: () => store.setFilters({ search: '' }), html: icon('x', 14) }));
    body.appendChild(searchWrap);

    /* status */
    body.appendChild(filterGroup('Status', STATUS_ORDER.map((st) => {
      const m = STATUS_META[st]; const on = f.statuses.includes(st);
      return chip(on, m.color, [el('span', { class: 'am-dot', style: { background: m.color } }), m.label], () => {
        store.setFilters({ statuses: on ? f.statuses.filter((s) => s !== st) : [...f.statuses, st] });
      });
    })));

    /* kind */
    body.appendChild(filterGroup('Type', KIND_ORDER.map((k) => {
      const m = KIND_META[k]; const on = f.kinds.includes(k);
      return chip(on, m.color, [el('span', { style: on ? { color: m.color } : null, html: icon(m.icon, 12) }), m.label], () => {
        store.setFilters({ kinds: on ? f.kinds.filter((x) => x !== k) : [...f.kinds, k] });
      }, m.hint);
    })));

    /* tags */
    if (allTags.length) {
      body.appendChild(filterGroup('Tags', allTags.map((tag) => {
        const on = f.tags.includes(tag);
        return chip(on, null, ['#' + tag], () => store.setFilters({ tags: on ? f.tags.filter((t) => t !== tag) : [...f.tags, tag] }), null, on);
      })));
    }

    /* switches */
    const switches = el('section', { class: 'am-filter-group' }, el('h3', { class: 'am-label', text: 'Quick filters' }),
      toggleSwitch('Only broken connections', f.brokenOnly, (v) => store.setFilters({ brokenOnly: v })),
      toggleSwitch('Only unfinished tasks', f.unfinishedOnly, (v) => store.setFilters({ unfinishedOnly: v })));
    body.appendChild(switches);

    root.appendChild(body);

    /* footer */
    const footer = el('div', { class: 'am-search-foot' },
      el('span', { class: 'am-muted' }, el('b', { text: String(matchCount) }), ` of ${state.nodes.length} node${state.nodes.length === 1 ? '' : 's'}`));
    if (activeCount > 0) footer.appendChild(el('button', { class: 'am-btn am-btn-ghost am-sm', onclick: () => store.resetFilters() }, el('span', { html: icon('x', 13) }), 'Clear all'));
    root.appendChild(footer);
  }

  function filterGroup(title, chips) {
    return el('section', { class: 'am-filter-group' }, el('h3', { class: 'am-label', text: title }), el('div', { class: 'am-chip-row' }, ...chips));
  }
  function chip(on, color, content, onClick, title, accent) {
    return el('button', {
      class: cx('am-chip am-filter-chip', on && (accent ? 'accent-on' : 'on')),
      style: on && color ? { background: color + '22', color } : null,
      title: title || '', onclick: onClick,
    }, ...content);
  }
  function toggleSwitch(label, checked, onChange) {
    return el('button', { class: 'am-switch-row', role: 'switch', 'aria-checked': String(checked), onclick: () => onChange(!checked) },
      el('span', { class: checked ? '' : 'am-muted', text: label }),
      el('span', { class: cx('am-switch', checked && 'on') }, el('span', { class: 'am-switch-knob' })));
  }

  const unsub = store.subscribe(() => { if (!editing) render(); });
  render();
  return { el: root, destroy() { unsub(); } };
}
