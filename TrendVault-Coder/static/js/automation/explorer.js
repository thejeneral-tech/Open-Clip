/**
 * Automation Map — workspace file explorer.
 *
 * Lists the files generated into the active workflow's workspace (by File
 * nodes or agents in "Generate files" mode) and opens any file in a read-only
 * viewer. Toggled via the toolbar (ui.showExplorer). Refreshes when the board
 * changes or a run finishes.
 */

import * as store from './store.js';
import * as api from './api.js';
import { el, clear, icon } from './dom.js';

function fmtSize(n) {
  if (n == null) return '';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function createExplorer() {
  const root = el('aside', { class: 'am-explorer', style: 'display:none' });
  const list = el('div', { class: 'am-explorer-list' });
  const head = el('div', { class: 'am-explorer-head' },
    el('span', { class: 'am-label', text: 'Workspace files' }),
    el('button', { class: 'am-icon-btn am-sm', title: 'Refresh', onclick: () => refresh(), html: icon('rotateCcw', 14) }));
  root.append(head, list);

  let lastBoard = null;
  let lastRun = undefined;

  async function refresh() {
    const wid = store.getState().activeBoardId;
    if (!wid) return;
    try {
      renderList(await api.listFiles(wid));
    } catch {
      renderList(null);
    }
  }

  function renderList(files) {
    clear(list);
    if (!files || !files.length) {
      list.appendChild(el('p', { class: 'am-muted-note',
        text: files ? 'No files yet. Run an agent in “Generate files” mode, or a File node.' : 'Could not load files.' }));
      return;
    }
    for (const f of files) {
      list.appendChild(el('button', { class: 'am-explorer-file', title: f.rel_path, onclick: () => openFile(f.rel_path) },
        el('span', { class: 'am-explorer-ico', html: icon('file', 14) }),
        el('span', { class: 'am-explorer-name', text: f.rel_path }),
        el('span', { class: 'am-explorer-size', text: fmtSize(f.size) })));
    }
  }

  async function openFile(rel) {
    const wid = store.getState().activeBoardId;
    let content = '';
    try { content = (await api.getFileContent(wid, rel)).content; }
    catch { content = '(could not read file)'; }
    showViewer(rel, content);
  }

  function showViewer(rel, content) {
    const overlay = el('div', { class: 'am-modal-overlay', onmousedown: (e) => { if (e.target === overlay) overlay.remove(); } });
    const ta = el('textarea', { class: 'am-input am-mono am-export-text', readonly: true, spellcheck: 'false' });
    ta.value = content;
    const panel = el('div', { class: 'am-export-panel', onmousedown: (e) => e.stopPropagation() },
      el('div', { class: 'am-export-head' },
        el('div', { class: 'am-export-title' }, el('span', { class: 'am-accent-ico', html: icon('file', 16) }), el('h2', { text: rel })),
        el('button', { class: 'am-icon-btn', title: 'Close', onclick: () => overlay.remove(), html: icon('x', 16) })),
      ta);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  const unsub = store.subscribe(() => {
    const s = store.getState();
    const vis = !!s.ui.showExplorer;
    root.style.display = vis ? '' : 'none';
    if (!vis) return;
    const runStatus = s.activeRun ? s.activeRun.status : null;
    if (s.activeBoardId !== lastBoard || runStatus !== lastRun) {
      lastBoard = s.activeBoardId;
      lastRun = runStatus;
      refresh();
    }
  });

  return {
    el: root,
    onShown() { if (store.getState().ui.showExplorer) refresh(); },
    destroy() { unsub(); },
  };
}
