/**
 * Automation Map — command palette (ported from CommandPalette.tsx).
 * Ctrl/Cmd+K overlay: run actions, create any node type, or jump to a node.
 */

import * as store from './store.js';
import * as exec from './exec.js';
import { el, clear, cx, icon } from './dom.js';
import { KIND_META, KIND_ORDER } from './registry.js';
import { toast } from './toast.js';

export function createCommandPalette(api = {}) {
  const overlay = el('div', { class: 'am-cmdk-overlay', style: 'display:none', onmousedown: (e) => { if (e.target === overlay) store.setCommandOpen(false); } });
  const input = el('input', { class: 'am-cmdk-input', placeholder: 'Type a command or search nodes…', oninput: () => { active = 0; renderList(); }, onkeydown: onKey });
  const list = el('div', { class: 'am-cmdk-list' });
  const panel = el('div', { class: 'am-cmdk-panel', onmousedown: (e) => e.stopPropagation() },
    el('div', { class: 'am-cmdk-head' }, el('span', { class: 'am-muted', html: icon('search', 16) }), input, el('kbd', { class: 'am-cmdk-esc', text: 'ESC' })),
    list);
  overlay.appendChild(panel);

  let active = 0;
  let commands = [];
  let filtered = [];

  function buildCommands() {
    const ui = store.getState().ui;
    const dismiss = () => store.setCommandOpen(false);
    const cmds = [
      { id: 'tidy', label: 'Auto-layout (tidy up)', group: 'Actions', icon: 'wand', keywords: 'arrange layout organize align', run: () => { store.tidyLayout(); setTimeout(() => api.fitView?.({ padding: 0.25 }), 0); dismiss(); } },
      { id: 'fit', label: 'Fit view', group: 'Actions', icon: 'maximize', keywords: 'zoom center frame', run: () => { api.fitView?.({ padding: 0.25 }); dismiss(); } },
      { id: 'undo', label: 'Undo', group: 'Actions', icon: 'undo', run: () => { store.undo(); dismiss(); } },
      { id: 'redo', label: 'Redo', group: 'Actions', icon: 'redo', run: () => { store.redo(); dismiss(); } },
      { id: 'search', label: `${ui.showSearch ? 'Hide' : 'Show'} search & filters`, group: 'Actions', icon: 'search', run: () => { store.setUi({ showSearch: !ui.showSearch }); dismiss(); } },
      { id: 'health', label: `${ui.showHealth ? 'Hide' : 'Show'} connection health`, group: 'Actions', icon: 'activity', run: () => { store.setUi({ showHealth: !ui.showHealth }); dismiss(); } },
      { id: 'minimap', label: `${ui.showMiniMap ? 'Hide' : 'Show'} mini map`, group: 'Actions', icon: 'map', run: () => { store.setUi({ showMiniMap: !ui.showMiniMap }); dismiss(); } },
      { id: 'snap', label: `${ui.snapToGrid ? 'Disable' : 'Enable'} snap to grid`, group: 'Actions', icon: 'grid', run: () => { store.setUi({ snapToGrid: !ui.snapToGrid }); dismiss(); } },
      { id: 'run', label: 'Run workflow', group: 'Actions', icon: 'activity', keywords: 'run execute start play', run: () => { dismiss(); exec.runWorkflow(); } },
      { id: 'syscheck', label: 'Run Full System Check', group: 'Actions', icon: 'activity', keywords: 'test diagnostic check health verify report', run: () => { dismiss(); api.openSystemCheck?.(); } },
      { id: 'export', label: 'Export workflow…', group: 'Actions', icon: 'download', keywords: 'claude cursor json markdown checklist prompt', run: () => { store.setExportOpen(true); dismiss(); } },
      { id: 'save', label: 'Save project', group: 'Actions', icon: 'check', keywords: 'save persist sqlite store', run: async () => { dismiss(); try { const r = await store.saveNow(); toast(r && r.offline ? 'Saved locally (server offline)' : 'Project saved', { type: 'success' }); } catch (e) { toast('Save failed: ' + ((e && e.message) || e), { type: 'error' }); } } },
      { id: 'sample', label: 'Load sample workflow', group: 'Actions', icon: 'feature', keywords: 'sample example pipeline agents demo', run: () => { store.loadSample(); dismiss(); } },
      { id: 'reset', label: 'Clear canvas…', group: 'Actions', icon: 'rotateCcw', keywords: 'reset clear empty delete all', run: () => { if (confirm('Clear the entire workflow? This cannot be undone.')) store.resetWorkflow(); dismiss(); } },
    ];
    for (const kind of KIND_ORDER) {
      const m = KIND_META[kind];
      cmds.push({ id: 'add-' + kind, label: 'Add ' + m.label, group: 'Create node', icon: m.icon, color: m.color, keywords: 'new create ' + kind, run: () => { store.addNode(kind); dismiss(); } });
    }
    for (const n of store.getState().nodes) {
      const m = KIND_META[n.data.kind];
      cmds.push({
        id: 'go-' + n.id, label: 'Go to: ' + (n.data.title || m.label), group: 'Navigate', icon: m.icon, color: m.color,
        keywords: m.label + ' ' + n.data.tags.join(' '),
        run: () => { store.setSelectedNode(n.id); api.focusNode?.(n.id, 1.1); dismiss(); },
      });
    }
    return cmds;
  }

  function renderList() {
    const q = input.value.trim().toLowerCase();
    filtered = q ? commands.filter((c) => `${c.label} ${c.group} ${c.keywords || ''}`.toLowerCase().includes(q)) : commands;
    if (active >= filtered.length) active = Math.max(0, filtered.length - 1);
    clear(list);
    if (!filtered.length) { list.appendChild(el('div', { class: 'am-cmdk-empty', text: 'No matches.' })); return; }
    filtered.forEach((c, i) => {
      if (i === 0 || filtered[i - 1].group !== c.group) list.appendChild(el('div', { class: 'am-label am-cmdk-group', text: c.group }));
      list.appendChild(el('button', {
        class: cx('am-cmdk-item', i === active && 'active'), dataset: { idx: String(i) },
        onmouseenter: () => { active = i; highlight(); }, onclick: () => c.run(),
      },
        el('span', { class: 'am-cmdk-ico', style: c.color ? { color: c.color } : null, html: icon(c.icon, 15) }),
        el('span', { class: 'am-cmdk-label', text: c.label }),
        i === active ? el('span', { class: 'am-muted', html: icon('cornerDownLeft', 13) }) : null,
      ));
    });
  }
  function highlight() {
    list.querySelectorAll('.am-cmdk-item').forEach((it) => it.classList.toggle('active', Number(it.dataset.idx) === active));
    const cur = list.querySelector(`.am-cmdk-item[data-idx="${active}"]`);
    cur?.scrollIntoView({ block: 'nearest' });
  }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); filtered[active]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); store.setCommandOpen(false); }
    e.stopPropagation();
  }

  let wasOpen = false;
  function update() {
    const open = store.getState().commandOpen;
    if (open === wasOpen) return;
    wasOpen = open;
    if (open) {
      commands = buildCommands();
      input.value = '';
      active = 0;
      renderList();
      overlay.style.display = '';
      requestAnimationFrame(() => input.focus());
    } else {
      overlay.style.display = 'none';
    }
  }

  const unsub = store.subscribe(update);
  update();
  return { el: overlay, destroy() { unsub(); } };
}
