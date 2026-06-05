/**
 * Automation Map — left sidebar (ported from Sidebar.tsx).
 * Spaces list (filter by space, inline create/rename/delete) + a draggable
 * node-type palette (drag onto the canvas or click to add).
 */

import * as store from './store.js';
import { el, clear, cx, icon } from './dom.js';
import { KIND_META, KIND_ORDER } from './registry.js';

const DRAG_MIME = 'application/cfc-kind';

export function createPalette() {
  let creating = false;
  let renamingId = null;
  let editing = false; // suppress re-render while an inline input is focused

  const spacesList = el('div', { class: 'am-spaces-list' });
  const spacesHead = el('div', { class: 'am-side-head' },
    el('span', { class: 'am-label', text: 'Spaces' }),
    el('button', {
      class: 'am-icon-btn am-sm', title: 'New space',
      onclick: () => { creating = !creating; renderSpaces(); if (creating) focusCreate(); },
      html: icon('plus', 14),
    }),
  );
  const spacesSection = el('div', { class: 'am-side-section am-spaces' }, spacesHead, spacesList);

  const paletteGrid = el('div', { class: 'am-palette-grid' });
  const paletteSection = el('div', { class: 'am-side-section am-palette' },
    el('div', { class: 'am-side-head' }, el('span', { class: 'am-label', text: 'Nodes' })),
    paletteGrid,
    el('p', { class: 'am-palette-tip' }, el('span', { html: icon('check', 11) }), 'Drag onto the canvas or click to add'),
  );

  const root = el('aside', { class: 'am-sidebar' }, spacesSection, paletteSection);

  /* node palette is static */
  for (const kind of KIND_ORDER) {
    const meta = KIND_META[kind];
    const btn = el('button', {
      class: 'am-palette-item', title: meta.hint, draggable: 'true',
      ondragstart: (e) => { e.dataTransfer.setData(DRAG_MIME, kind); e.dataTransfer.effectAllowed = 'move'; },
      onclick: () => store.addNode(kind),
    },
      el('span', { class: 'am-palette-ico', style: { background: meta.color + '22', color: meta.color }, html: icon(meta.icon, 14) }),
      el('span', { class: 'am-palette-label', text: meta.label }),
    );
    paletteGrid.appendChild(btn);
  }

  function focusCreate() {
    requestAnimationFrame(() => spacesList.querySelector('.am-space-create input')?.focus());
  }

  function renderSpaces() {
    const state = store.getState();
    const counts = new Map();
    for (const n of state.nodes) counts.set(n.data.space, (counts.get(n.data.space) ?? 0) + 1);
    clear(spacesList);

    if (creating) {
      const input = el('input', {
        class: 'am-input am-sm', placeholder: 'Space name…',
        onfocus: () => { editing = true; }, onblur: () => { commitCreate(input.value); },
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitCreate(input.value); }
          else if (e.key === 'Escape') { e.preventDefault(); creating = false; editing = false; renderSpaces(); }
        },
      });
      spacesList.appendChild(el('div', { class: 'am-space-create' }, input));
    }

    // All nodes
    spacesList.appendChild(el('button', {
      class: cx('am-space-row', state.activeSpace === 'all' && 'active'),
      onclick: () => store.setActiveSpace('all'),
    },
      el('span', { class: 'am-space-ico', html: icon('layers', 14) }),
      el('span', { class: 'am-space-name', text: 'All nodes' }),
      el('span', { class: 'am-space-count', text: String(state.nodes.length) }),
    ));

    for (const space of state.spaces) {
      const isActive = state.activeSpace === space.id;
      const count = counts.get(space.id) ?? 0;
      if (renamingId === space.id) {
        const input = el('input', {
          class: 'am-input am-sm', value: space.name,
          onfocus: () => { editing = true; }, onblur: () => commitRename(space.id, input.value),
          onkeydown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(space.id, input.value); }
            else if (e.key === 'Escape') { e.preventDefault(); renamingId = null; editing = false; renderSpaces(); }
          },
        });
        const row = el('div', { class: 'am-space-row editing' },
          el('span', { class: 'am-space-dot', style: { background: space.color } }), input);
        spacesList.appendChild(row);
        requestAnimationFrame(() => { input.focus(); input.select(); });
      } else {
        const row = el('div', { class: cx('am-space-row', isActive && 'active') },
          el('span', { class: 'am-space-dot', style: { background: space.color } }),
          el('button', {
            class: 'am-space-name am-space-open', title: space.name,
            onclick: () => store.setActiveSpace(space.id),
            ondblclick: () => { renamingId = space.id; renderSpaces(); },
            text: space.name,
          }),
          el('span', { class: 'am-space-count', text: String(count) }),
          el('button', {
            class: 'am-space-del', title: 'Delete space', 'aria-label': `Delete ${space.name}`,
            onclick: () => {
              if (confirm(`Delete space "${space.name}"? Its nodes move to another space.`)) store.deleteSpace(space.id);
            },
            html: icon('x', 13),
          }),
        );
        spacesList.appendChild(row);
      }
    }
  }

  function commitCreate(value) {
    const v = (value || '').trim();
    creating = false; editing = false;
    if (v) store.addSpace(v);
    renderSpaces();
  }
  function commitRename(id, value) {
    const v = (value || '').trim();
    renamingId = null; editing = false;
    if (v) store.renameSpace(id, v);
    renderSpaces();
  }

  const unsub = store.subscribe(() => { if (!editing) renderSpaces(); });
  renderSpaces();

  return { el: root, destroy() { unsub(); } };
}
