/**
 * Automation Map — canvas context menu (ported from CanvasContextMenu.tsx).
 * Floating menu for the pane (add node here / tidy / fit), a node
 * (open / duplicate / set status / delete) and an edge (path type / delete).
 */

import * as store from './store.js';
import { el, icon } from './dom.js';
import { KIND_META, KIND_ORDER, STATUS_META, STATUS_ORDER } from './registry.js';

const EDGE_KINDS = [
  { kind: 'default', label: 'Default', color: '#22d3ee' },
  { kind: 'success', label: 'Success', color: '#22c55e' },
  { kind: 'error', label: 'Error', color: '#ef4444' },
];

let current = null; // { el, cleanup }

function close() {
  if (!current) return;
  current.cleanup();
  current.el.remove();
  current = null;
}

function item({ ico, label, danger, onClick }) {
  return el('button', {
    class: 'am-ctx-item' + (danger ? ' danger' : ''),
    onclick: () => { onClick(); close(); },
  }, ico ? el('span', { class: 'am-ctx-ico', html: icon(ico, 14) }) : null, el('span', { class: 'am-ctx-label', text: label }));
}

/** Open a context menu. `api` = { fitView, focusNode } from the canvas. */
export function openContextMenu(menu, api) {
  close();
  const root = el('div', { class: 'am-ctx' });

  if (menu.type === 'pane') {
    root.appendChild(el('div', { class: 'am-ctx-head', text: 'Add a node here' }));
    const list = el('div', { class: 'am-ctx-scroll' });
    for (const kind of KIND_ORDER) {
      const m = KIND_META[kind];
      list.appendChild(el('button', {
        class: 'am-ctx-item',
        onclick: () => { store.addNode(kind, menu.flow); close(); },
      },
        el('span', { class: 'am-ctx-kico', style: { background: m.color + '22', color: m.color }, html: icon(m.icon, 13) }),
        el('span', { class: 'am-ctx-label', text: m.label }),
      ));
    }
    root.appendChild(list);
    root.appendChild(el('div', { class: 'am-ctx-div' }));
    root.appendChild(item({ ico: 'wand', label: 'Tidy up layout', onClick: () => { store.tidyLayout(); setTimeout(() => api.fitView({ padding: 0.25 }), 0); } }));
    root.appendChild(item({ ico: 'maximize', label: 'Fit view', onClick: () => api.fitView({ padding: 0.25 }) }));
  }

  if (menu.type === 'node') {
    const node = store.getState().nodes.find((n) => n.id === menu.id);
    if (!node) return;
    root.appendChild(el('div', { class: 'am-ctx-title', text: node.data.title || KIND_META[node.data.kind].label }));
    root.appendChild(item({ ico: 'panelRight', label: 'Open in inspector', onClick: () => store.setSelectedNode(menu.id) }));
    root.appendChild(item({ ico: 'copy', label: 'Duplicate', onClick: () => store.duplicateNode(menu.id) }));
    root.appendChild(el('div', { class: 'am-ctx-head', text: 'Set status' }));
    const statusWrap = el('div', { class: 'am-ctx-status' });
    for (const st of STATUS_ORDER) {
      const m = STATUS_META[st];
      const on = node.data.status === st;
      statusWrap.appendChild(el('button', {
        class: 'am-ctx-spill', title: m.label,
        style: { background: m.color + (on ? '33' : '1a'), color: m.color },
        onclick: () => { store.updateNodeData(menu.id, { status: st }); close(); },
      }, el('span', { class: 'am-dot', style: { background: m.color } }), m.label));
    }
    root.appendChild(statusWrap);
    root.appendChild(el('div', { class: 'am-ctx-div' }));
    root.appendChild(item({ ico: 'trash', label: 'Delete node', danger: true, onClick: () => store.deleteNode(menu.id) }));
  }

  if (menu.type === 'edge') {
    root.appendChild(el('div', { class: 'am-ctx-title', text: 'Connection' }));
    root.appendChild(el('div', { class: 'am-ctx-head', text: 'Path type' }));
    const row = el('div', { class: 'am-ctx-edgekinds' });
    for (const k of EDGE_KINDS) {
      row.appendChild(el('button', {
        class: 'am-ctx-ekbtn', style: { color: k.color },
        onclick: () => { store.updateEdgeData(menu.id, { kind: k.kind }); close(); },
      }, el('span', { class: 'am-dot', style: { background: k.color } }), k.label));
    }
    root.appendChild(row);
    root.appendChild(el('div', { class: 'am-ctx-hint', text: 'Double-click the line to rename it.' }));
    root.appendChild(el('div', { class: 'am-ctx-div' }));
    root.appendChild(item({ ico: 'trash', label: 'Delete connection', danger: true, onClick: () => store.deleteEdge(menu.id) }));
  }

  document.body.appendChild(root);

  // Clamp into the viewport.
  const r = root.getBoundingClientRect();
  let left = menu.x, top = menu.y;
  if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
  if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
  root.style.left = Math.max(8, left) + 'px';
  root.style.top = Math.max(8, top) + 'px';

  const onDown = (e) => { if (!root.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  // Defer so the opening contextmenu event doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
  }, 0);

  current = {
    el: root,
    cleanup() {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
    },
  };
}

export function closeContextMenu() { close(); }
