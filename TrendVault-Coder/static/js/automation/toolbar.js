/**
 * Automation Map — top toolbar (ported from Toolbar.tsx + BoardSwitcher.tsx).
 * Brand, board switcher, add-node menu, command palette, view toggles,
 * undo/redo, sample/reset/import/export (+ export dialog).
 */

import * as store from './store.js';
import { el, clear, cx, icon } from './dom.js';
import { KIND_META, KIND_ORDER } from './registry.js';
import { EXPORTERS, runExport } from './exporters.js';
import { copyToClipboard, parseWorkflowFile, readTextFile, triggerDownload } from './io.js';

export function createToolbar(api = {}) {
  /* ---------- board switcher ---------- */
  const boardBtnLabel = el('span', { class: 'am-board-name', text: '' });
  const boardBtn = el('button', { class: 'am-btn am-btn-ghost am-board-btn', title: 'Switch project board', onclick: toggleBoards },
    el('span', { class: 'am-accent-ico', html: icon('folderKanban', 15) }), boardBtnLabel, el('span', { class: 'am-muted', html: icon('chevronDown', 14) }));
  const boardMenu = el('div', { class: 'am-menu am-board-menu', style: 'display:none' });
  const boardWrap = el('div', { class: 'am-pop' }, boardBtn, boardMenu);
  let boardsOpen = false;
  let boardCreating = false;

  function toggleBoards() { boardsOpen ? closeBoards() : openBoards(); }
  function openBoards() { boardsOpen = true; boardCreating = false; renderBoards(); boardMenu.style.display = ''; document.addEventListener('pointerdown', boardOutside, true); }
  function closeBoards() { boardsOpen = false; boardMenu.style.display = 'none'; document.removeEventListener('pointerdown', boardOutside, true); }
  function boardOutside(e) { if (!boardWrap.contains(e.target)) closeBoards(); }

  function renderBoards() {
    const { boards, activeBoardId } = store.getState();
    clear(boardMenu);
    boardMenu.appendChild(el('div', { class: 'am-label am-menu-label', text: 'Project boards' }));
    const list = el('div', { class: 'am-board-list' });
    for (const b of boards) {
      const isActive = b.id === activeBoardId;
      const row = el('div', { class: cx('am-board-row', isActive && 'active') },
        el('span', { class: 'am-board-check', html: isActive ? icon('check', 14) : '' }),
        el('button', { class: 'am-board-open', title: 'Click to open · double-click to rename', onclick: () => { store.switchBoard(b.id); closeBoards(); }, ondblclick: () => beginRename(b) },
          b.name, el('span', { class: 'am-board-num', text: String(b.nodes.length) })),
        el('div', { class: 'am-board-rowacts' },
          el('button', { class: 'am-icon-btn am-sm', title: 'Duplicate board', onclick: () => { store.duplicateBoard(b.id); renderBoards(); }, html: icon('copy', 13) }),
          el('button', { class: 'am-icon-btn am-sm danger', title: 'Delete board', ...(boards.length <= 1 ? { disabled: true } : {}), onclick: () => { if (confirm(`Delete board "${b.name}"? This cannot be undone.`)) { store.deleteBoard(b.id); renderBoards(); } }, html: icon('trash', 13) }),
        ),
      );
      list.appendChild(row);
    }
    boardMenu.appendChild(list);

    const foot = el('div', { class: 'am-board-foot' });
    if (boardCreating) {
      const input = el('input', { class: 'am-input am-sm', placeholder: 'New board name…',
        onkeydown: (e) => { if (e.key === 'Enter') { commitNewBoard(input.value); } else if (e.key === 'Escape') { boardCreating = false; renderBoards(); } },
        onblur: () => commitNewBoard(input.value) });
      foot.appendChild(input);
      requestAnimationFrame(() => input.focus());
    } else {
      foot.appendChild(el('button', { class: 'am-menu-item', onclick: () => { boardCreating = true; renderBoards(); } }, el('span', { html: icon('plus', 15) }), 'New board'));
    }
    boardMenu.appendChild(foot);
  }
  function beginRename(b) {
    const name = prompt('Rename board', b.name);
    if (name != null) { store.renameBoard(b.id, name); renderBoards(); }
  }
  function commitNewBoard(value) {
    const v = (value || '').trim();
    boardCreating = false;
    if (v) { store.createBoard(v); closeBoards(); } else renderBoards();
  }

  /* ---------- add node menu ---------- */
  const addMenu = el('div', { class: 'am-menu am-add-menu', style: 'display:none' });
  for (const kind of KIND_ORDER) {
    const m = KIND_META[kind];
    addMenu.appendChild(el('button', { class: 'am-menu-item', onclick: () => { store.addNode(kind); closeAdd(); } },
      el('span', { class: 'am-menu-kico', style: { background: m.color + '22', color: m.color }, html: icon(m.icon, 15) }),
      el('span', { class: 'am-menu-itext', text: m.label })));
  }
  const addBtn = el('button', { class: 'am-btn am-btn-primary', onclick: toggleAdd }, el('span', { html: icon('plus', 16) }), 'Add node');
  const addWrap = el('div', { class: 'am-pop' }, addBtn, addMenu);
  let addOpen = false;
  function toggleAdd() { addOpen ? closeAdd() : openAdd(); }
  function openAdd() { addOpen = true; addMenu.style.display = ''; document.addEventListener('pointerdown', addOutside, true); }
  function closeAdd() { addOpen = false; addMenu.style.display = 'none'; document.removeEventListener('pointerdown', addOutside, true); }
  function addOutside(e) { if (!addWrap.contains(e.target)) closeAdd(); }

  /* ---------- toggles + actions ---------- */
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none',
    onchange: async (e) => {
      const file = e.currentTarget.files?.[0];
      if (!file) return;
      try { store.importWorkflow(parseWorkflowFile(await readTextFile(file))); }
      catch (err) { alert('Could not import workflow: ' + (err?.message || 'Unknown error.')); }
      finally { e.currentTarget.value = ''; }
    } });

  const toggle = (iconName, title, key) => el('button', {
    class: 'am-icon-btn am-toggle', title, 'aria-label': title, dataset: { ui: key },
    onclick: () => store.setUi({ [key]: !store.getState().ui[key] }), html: icon(iconName, 16),
  });
  const snapBtn = toggle('grid', 'Snap to grid', 'snapToGrid');
  const mapBtn = toggle('map', 'Mini map', 'showMiniMap');
  const searchBtn = toggle('search', 'Search & filters', 'showSearch');
  const healthBtn = toggle('activity', 'Health panel', 'showHealth');
  const undoBtn = el('button', { class: 'am-icon-btn', title: 'Undo (Ctrl/Cmd+Z)', onclick: () => store.undo(), html: icon('undo', 16) });
  const redoBtn = el('button', { class: 'am-icon-btn', title: 'Redo (Ctrl/Cmd+Shift+Z)', onclick: () => store.redo(), html: icon('redo', 16) });
  const countText = el('div', { class: 'am-brand-sub', text: '' });

  const handleTidy = () => { store.tidyLayout(); setTimeout(() => api.fitView?.({ padding: 0.25 }), 0); };
  const handleReset = () => { if (confirm('Clear the entire workflow? This cannot be undone.')) store.resetWorkflow(); };

  const root = el('header', { class: 'am-toolbar' },
    el('div', { class: 'am-toolbar-left' },
      el('div', { class: 'am-brand' }, el('span', { class: 'am-brand-icon', html: icon('workflow', 18) })),
      el('div', { class: 'am-brand-text' }, el('div', { class: 'am-brand-name', text: 'Automation Map' }), countText),
      el('span', { class: 'am-divider' }),
      boardWrap,
    ),
    el('div', { class: 'am-toolbar-center' },
      addWrap,
      el('button', { class: 'am-btn am-btn-outline', title: 'Command palette (Ctrl/Cmd+K)', onclick: () => store.setCommandOpen(true) },
        el('span', { html: icon('command', 15) }), el('span', { class: 'am-hide-sm', text: 'Commands' })),
    ),
    el('div', { class: 'am-toolbar-right' },
      snapBtn, mapBtn, searchBtn, healthBtn,
      el('button', { class: 'am-icon-btn', title: 'Fit view', onclick: () => api.fitView?.({ padding: 0.2 }), html: icon('maximize', 16) }),
      el('button', { class: 'am-icon-btn', title: 'Auto-layout (tidy up)', onclick: handleTidy, html: icon('wand', 16) }),
      el('span', { class: 'am-divider' }),
      undoBtn, redoBtn,
      el('span', { class: 'am-divider' }),
      el('button', { class: 'am-btn am-btn-ghost', title: 'Load the sample workflow', onclick: () => store.loadSample() }, el('span', { html: icon('feature', 15) }), el('span', { class: 'am-hide-sm', text: 'Sample' })),
      el('button', { class: 'am-btn am-btn-ghost', title: 'Clear the workflow', onclick: handleReset }, el('span', { html: icon('rotateCcw', 15) }), el('span', { class: 'am-hide-sm', text: 'Reset' })),
      el('button', { class: 'am-btn am-btn-outline', title: 'Import a workflow JSON file', onclick: () => fileInput.click() }, el('span', { html: icon('fileUp', 15) }), el('span', { class: 'am-hide-sm', text: 'Import' })),
      el('button', { class: 'am-btn am-btn-primary', title: 'Export the workflow', onclick: () => store.setExportOpen(true) }, el('span', { html: icon('download', 15) }), 'Export'),
      fileInput,
    ),
  );

  /* ---------- export dialog ---------- */
  let exportDialog = null;
  let exportFormat = 'claude';
  function openExport() {
    if (exportDialog) return;
    const overlay = el('div', { class: 'am-modal-overlay', onmousedown: (e) => { if (e.target === overlay) store.setExportOpen(false); } });
    const tabs = el('div', { class: 'am-export-tabs' });
    const desc = el('p', { class: 'am-export-desc' });
    const ta = el('textarea', { class: 'am-input am-mono am-export-text', readonly: true, spellcheck: 'false', onfocus: (e) => e.currentTarget.select() });
    const copyBtn = el('button', { class: 'am-btn am-btn-outline', onclick: doCopy }, el('span', { class: 'am-copy-ico', html: icon('copy', 15) }), el('span', { class: 'am-copy-label', text: 'Copy' }));

    function refresh() {
      clear(tabs);
      for (const exp of EXPORTERS) {
        tabs.appendChild(el('button', { class: cx('am-btn', exportFormat === exp.id ? 'am-btn-primary' : 'am-btn-ghost'), onclick: () => { exportFormat = exp.id; refresh(); } }, exp.label));
      }
      const d = EXPORTERS.find((e) => e.id === exportFormat) || EXPORTERS[0];
      desc.textContent = d.description;
      const s = store.getState();
      ta.value = runExport(exportFormat, s.nodes, s.edges, s.spaces, new Date().toISOString());
      copyBtn.querySelector('.am-copy-label').textContent = 'Copy';
      copyBtn.querySelector('.am-copy-ico').innerHTML = icon('copy', 15);
    }
    async function doCopy() {
      const ok = await copyToClipboard(ta.value);
      if (ok) {
        copyBtn.querySelector('.am-copy-label').textContent = 'Copied!';
        copyBtn.querySelector('.am-copy-ico').innerHTML = icon('check', 15);
        setTimeout(() => { copyBtn.querySelector('.am-copy-label').textContent = 'Copy'; copyBtn.querySelector('.am-copy-ico').innerHTML = icon('copy', 15); }, 1600);
      }
    }
    function doDownload() {
      const d = EXPORTERS.find((e) => e.id === exportFormat) || EXPORTERS[0];
      triggerDownload('automation-map.' + d.extension, ta.value, d.id === 'json' ? 'application/json' : 'text/markdown');
    }

    const panel = el('div', { class: 'am-export-panel', onmousedown: (e) => e.stopPropagation() },
      el('div', { class: 'am-export-head' },
        el('div', { class: 'am-export-title' }, el('span', { class: 'am-accent-ico', html: icon('download', 16) }), el('h2', { text: 'Export workflow' })),
        el('button', { class: 'am-icon-btn', title: 'Close', onclick: () => store.setExportOpen(false), html: icon('x', 16) })),
      tabs, desc, ta,
      el('div', { class: 'am-export-foot' }, copyBtn, el('button', { class: 'am-btn am-btn-primary', onclick: doDownload }, el('span', { html: icon('download', 15) }), 'Download')),
    );
    overlay.appendChild(panel);
    root.appendChild(overlay);
    exportDialog = overlay;
    refresh();
  }
  function closeExport() { if (exportDialog) { exportDialog.remove(); exportDialog = null; } }

  /* ---------- live updates ---------- */
  let lastExportOpen = false;
  function update() {
    const s = store.getState();
    const n = s.nodes.length;
    countText.textContent = `${n} ${n === 1 ? 'node' : 'nodes'}`;
    boardBtnLabel.textContent = (s.boards.find((b) => b.id === s.activeBoardId)?.name) || 'Board';
    snapBtn.classList.toggle('active', s.ui.snapToGrid);
    mapBtn.classList.toggle('active', s.ui.showMiniMap);
    searchBtn.classList.toggle('active', s.ui.showSearch);
    healthBtn.classList.toggle('active', s.ui.showHealth);
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
    if (s.exportOpen !== lastExportOpen) { lastExportOpen = s.exportOpen; s.exportOpen ? openExport() : closeExport(); }
    else if (s.exportOpen && exportDialog) { /* keep open */ }
  }

  const unsub = store.subscribe(update);
  update();

  return { el: root, destroy() { unsub(); closeExport(); } };
}
