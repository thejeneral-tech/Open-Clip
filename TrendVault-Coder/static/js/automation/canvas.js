/**
 * Automation Map — canvas engine (vanilla replacement for React Flow).
 *
 * Renders nodes + bezier edges in a pan/zoom "world" layer, and handles all
 * canvas interaction: pan, zoom, node drag, connection drag, selection,
 * delete, drag-drop add, context menu, minimap and zoom controls.
 */

import * as store from './store.js';
import { el, svg, clear, cx, icon, getBezierPath } from './dom.js';
import { KIND_META, STATUS_META, HEALTH_META } from './registry.js';
import { validateWorkflow } from './validation.js';
import { nodeMatchesFilters } from './filtering.js';
import { createEmptyState } from './emptyState.js';

const NODE_WIDTH = 248;
const FALLBACK_H = 132;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const GRID = 16;
const DOT_GAP = 22;
const DRAG_MIME = 'application/cfc-kind';

const EDGE_COLOR = { default: '#22d3ee', success: '#22c55e', error: '#ef4444' };

export function createCanvas() {
  /* ---- view state (local, not persisted — matches React Flow) ---- */
  const view = { x: 0, y: 0, k: 1 };
  const nodeHeights = new Map(); // id -> measured px height
  const nodeEls = new Map();     // id -> card element
  let selectedEdgeId = null;
  let editingEdgeId = null;
  let ctxHandler = null;
  let didInitialFit = false;

  /* ---- DOM ---- */
  const dots = el('div', { class: 'am-canvas-dots' });
  const edgesSvg = svg('svg', { class: 'am-edges' },
    svg('defs', null,
      arrowMarker('am-arrow-default', EDGE_COLOR.default),
      arrowMarker('am-arrow-success', EDGE_COLOR.success),
      arrowMarker('am-arrow-error', EDGE_COLOR.error),
      arrowMarker('am-arrow-selected', null), // fill set via CSS so it follows --accent
    ),
  );
  const edgesGroup = svg('g', { class: 'am-edges-group' });
  const tempPath = svg('path', { class: 'am-edge-temp', d: '', style: 'display:none' });
  edgesSvg.append(edgesGroup, tempPath);

  const labelsLayer = el('div', { class: 'am-edge-labels' });
  const nodesLayer = el('div', { class: 'am-nodes' });
  const world = el('div', { class: 'am-world' }, edgesSvg, labelsLayer, nodesLayer);

  const controls = buildControls();
  const minimap = el('div', { class: 'am-minimap' });
  const emptyUI = createEmptyState({ worldCenter, fitView, focusNode });
  const emptyState = emptyUI.el;

  const canvas = el('div', { class: 'am-canvas' }, dots, world, emptyState, controls.el, minimap);

  /* ================= viewport ================= */
  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    dots.style.backgroundSize = `${DOT_GAP * view.k}px ${DOT_GAP * view.k}px`;
    dots.style.backgroundPosition = `${view.x}px ${view.y}px`;
    controls.setZoom(view.k);
    drawMinimap();
  }

  function rect() { return canvas.getBoundingClientRect(); }

  function screenToFlow(clientX, clientY) {
    const r = rect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  }

  function zoomAround(clientX, clientY, nextK) {
    const r = rect();
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextK));
    const fx = (clientX - r.left - view.x) / view.k;
    const fy = (clientY - r.top - view.y) / view.k;
    view.x = clientX - r.left - fx * k;
    view.y = clientY - r.top - fy * k;
    view.k = k;
    applyView();
  }

  function nodeSize(id) {
    return { w: NODE_WIDTH, h: nodeHeights.get(id) ?? FALLBACK_H };
  }

  function fitView(opts = {}) {
    const padding = opts.padding ?? 0.2;
    const maxZoom = opts.maxZoom ?? 1;
    const ns = store.getState().nodes;
    const r = rect();
    if (!ns.length || r.width === 0) { applyView(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) {
      const { w, h } = nodeSize(n.id);
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }
    const bw = maxX - minX, bh = maxY - minY;
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, maxZoom,
      Math.min(r.width / (bw * (1 + padding)), r.height / (bh * (1 + padding)))));
    view.k = k;
    view.x = (r.width - bw * k) / 2 - minX * k;
    view.y = (r.height - bh * k) / 2 - minY * k;
    applyView();
  }

  function focusNode(id, zoom = 1.1) {
    const n = store.getState().nodes.find((x) => x.id === id);
    if (!n) return;
    const r = rect();
    const { w, h } = nodeSize(id);
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    view.k = k;
    view.x = r.width / 2 - (n.position.x + w / 2) * k;
    view.y = r.height / 2 - (n.position.y + h / 2) * k;
    applyView();
  }

  /* ================= rendering ================= */
  function handlePos(node, type, portId) {
    const ports = type === 'source' ? node.data.outputs : node.data.inputs;
    const idx = ports.findIndex((p) => p.id === portId);
    const count = ports.length || 1;
    const i = idx < 0 ? 0 : idx;
    const { w, h } = nodeSize(node.id);
    return {
      x: node.position.x + (type === 'source' ? w : 0),
      y: node.position.y + h * ((i + 1) / (count + 1)),
    };
  }

  function render() {
    const state = store.getState();
    const health = validateWorkflow(state.nodes, state.edges);
    const ids = new Set(state.nodes.map((n) => n.id));

    // Remove stale node elements.
    for (const [id, elem] of nodeEls) {
      if (!ids.has(id)) { elem.remove(); nodeEls.delete(id); nodeHeights.delete(id); }
    }

    // Upsert nodes.
    for (const node of state.nodes) {
      const hidden = !nodeMatchesFilters(node, state.filters, state.activeSpace, health[node.id]);
      let elem = nodeEls.get(node.id);
      if (!elem) {
        elem = el('div', { class: 'am-node', dataset: { nodeId: node.id } });
        nodesLayer.appendChild(elem);
        nodeEls.set(node.id, elem);
      }
      elem.innerHTML = nodeInner(node, health[node.id]);
      elem.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
      elem.classList.toggle('selected', node.id === state.selectedNodeId);
      elem.classList.toggle('am-hidden', hidden);
      nodeHeights.set(node.id, elem.offsetHeight || FALLBACK_H);
    }

    emptyUI.setEmpty(state.nodes.length === 0);

    drawEdges();
    if (!didInitialFit && state.nodes.length) { didInitialFit = true; fitView({ padding: 0.25, maxZoom: 1 }); }
    else applyView();
  }

  function drawEdges(override) {
    const state = store.getState();
    const health = validateWorkflow(state.nodes, state.edges);
    const byId = new Map(state.nodes.map((n) => [n.id, n]));
    const hiddenIds = new Set(state.nodes
      .filter((n) => !nodeMatchesFilters(n, state.filters, state.activeSpace, health[n.id]))
      .map((n) => n.id));

    clear(edgesGroup);
    clear(labelsLayer);

    for (const edge of state.edges) {
      const s = byId.get(edge.source);
      const t = byId.get(edge.target);
      if (!s || !t) continue;
      if (hiddenIds.has(edge.source) || hiddenIds.has(edge.target)) continue;

      const sNode = override && override.id === s.id ? { ...s, position: override.position } : s;
      const tNode = override && override.id === t.id ? { ...t, position: override.position } : t;
      const a = handlePos(sNode, 'source', edge.sourceHandle);
      const b = handlePos(tNode, 'target', edge.targetHandle);
      const { path, labelX, labelY } = getBezierPath(a.x, a.y, b.x, b.y);
      const kind = edge.data?.kind ?? 'default';
      const selected = edge.id === selectedEdgeId;

      // Wide invisible hit path for easy clicking.
      edgesGroup.appendChild(svg('path', {
        class: 'am-edge-hit', d: path, dataset: { edgeId: edge.id },
      }));
      // Visible path.
      edgesGroup.appendChild(svg('path', {
        class: cx('am-edge', kind, selected && 'selected'),
        d: path,
        'marker-end': `url(#am-arrow-${selected ? 'selected' : kind})`,
        dataset: { edgeId: edge.id },
      }));

      const label = edge.data?.label ?? '';
      if (label.trim() || selected || editingEdgeId === edge.id) {
        labelsLayer.appendChild(buildEdgeLabel(edge, kind, selected, labelX, labelY));
      }
    }
  }

  /** World-space coordinates of the current viewport centre (for centred adds). */
  function worldCenter() {
    const r = rect();
    return screenToFlow(r.left + r.width / 2, r.top + r.height / 2);
  }

  /* ================= node card markup ================= */
  const RUN_STATUS = {
    waiting: { c: '#8b93a7', l: 'Waiting', w: '12%' },
    running: { c: '#38bdf8', l: 'Running', w: '45%' },
    success: { c: '#22c55e', l: 'Success', w: '100%' },
    failed: { c: '#ef4444', l: 'Failed', w: '100%' },
    cancelled: { c: '#f59e0b', l: 'Cancelled', w: '100%' },
    skipped: { c: '#64748b', l: 'Skipped', w: '100%' },
  };

  /** A thin run-progress bar at the foot of a node card (indeterminate while
   *  running, full + colored once settled). */
  function progressHtml(rt) {
    if (!rt || !rt.status) return '';
    const s = RUN_STATUS[rt.status];
    if (!s) return '';
    const ind = rt.status === 'running' ? ' indeterminate' : '';
    return `<div class="am-node-progress${ind}"><div class="am-node-progress-fill" style="width:${s.w};background:${s.c}"></div></div>`;
  }

  function nodeInner(node, health) {
    const d = node.data;
    const meta = KIND_META[d.kind];
    const status = STATUS_META[d.status];
    const rt = (store.getState().runtime || {})[node.id];
    const rs = rt && rt.status ? RUN_STATUS[rt.status] : null;
    const hMeta = health ? HEALTH_META[health.level] : null;
    const hColor = hMeta?.color ?? '#8b93a7';
    const hLabel = hMeta?.label ?? 'Unverified';
    const hTitle = health?.issues.length ? esc(health.issues.join('\n')) : esc(hLabel);

    const handles = (ports, type) => ports.map((p, i) => {
      const pct = ((i + 1) / (ports.length + 1)) * 100;
      const col = p.kind === 'success' ? '#22c55e' : p.kind === 'error' ? '#ef4444' : '';
      return `<div class="am-handle ${type === 'source' ? 'out' : 'in'}" style="top:${pct}%${col ? `;border-color:${col}` : ''}" title="${esc(p.label)}" data-node-id="${node.id}" data-port-id="${p.id}" data-handle-type="${type}"></div>`;
    }).join('');

    const tags = d.tags.slice(0, 3);
    const overflow = d.tags.length - tags.length;
    const hint = kindHint(d);
    const hasBody = !!d.description.trim() || d.tags.length > 0 || !!hint;

    return `
      <div class="am-node-accent" style="background:${meta.color}"></div>
      ${handles(d.inputs, 'target')}
      ${handles(d.outputs, 'source')}
      <div class="am-node-pad">
        <div class="am-node-head">
          <div class="am-node-icon" style="background:${meta.color}2e;color:${meta.color}">${icon(meta.icon, 15)}</div>
          <div class="am-node-titles">
            <div class="am-node-title" title="${esc(d.title)}">${esc(d.title || 'New ' + meta.label)}</div>
            <div class="am-node-kind">${esc(meta.label)}</div>
          </div>
          <span class="am-node-status" style="background:${status.color};box-shadow:0 0 8px ${status.color}66" title="${esc(status.label)}"></span>
          ${d.approved ? `<span class="am-node-approved" title="Approved">${icon('check', 12)}</span>` : ''}
          ${rs ? `<span class="am-node-run ${rt.status === 'running' ? 'am-run-spin' : ''}" style="color:${rs.c};border-color:${rs.c}66;background:${rs.c}1f" title="${esc(rs.l)}${rt.error ? ': ' + esc(rt.error) : ''}">${rt.status === 'running' ? '<span class="am-run-dot"></span>' : ''}${esc(rs.l)}</span>` : ''}
        </div>
        ${hasBody ? `<div class="am-node-body">
          ${d.description.trim() ? `<p class="am-node-desc">${esc(d.description)}</p>` : ''}
          ${d.tags.length ? `<div class="am-tags">${tags.map((t) => `<span class="am-chip">${esc(t)}</span>`).join('')}${overflow > 0 ? `<span class="am-chip">+${overflow}</span>` : ''}</div>` : ''}
          ${hint ? `<div class="am-node-hint" title="${esc(hint)}">${esc(hint)}</div>` : ''}
        </div>` : ''}
        <div class="am-node-health" title="${hTitle}">
          <span class="am-dot" style="background:${hColor}"></span>
          <span style="color:${hColor}">${esc(hLabel)}</span>
        </div>
        ${progressHtml(rt)}
      </div>`;
  }

  /* ================= edge label ================= */
  function buildEdgeLabel(edge, kind, selected, lx, ly) {
    const wrap = el('div', { class: 'am-edge-label-wrap', style: { transform: `translate(-50%,-50%) translate(${lx}px, ${ly}px)` } });
    const label = edge.data?.label ?? '';

    if (editingEdgeId === edge.id) {
      const input = el('input', {
        class: 'am-edge-input', value: label, placeholder: 'label',
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitEdgeLabel(edge.id, input.value); }
          else if (e.key === 'Escape') { e.preventDefault(); editingEdgeId = null; drawEdges(); }
          e.stopPropagation();
        },
        onblur: () => commitEdgeLabel(edge.id, input.value),
      });
      wrap.appendChild(input);
      requestAnimationFrame(() => { input.focus(); input.select(); });
    } else {
      const pill = el('button', {
        class: cx('am-edge-pill', selected && 'selected', !label.trim() && 'empty'),
        style: { color: EDGE_COLOR[kind] },
        title: 'Double-click to rename',
        ondblclick: (e) => { e.stopPropagation(); editingEdgeId = edge.id; selectedEdgeId = edge.id; drawEdges(); },
        onclick: (e) => { e.stopPropagation(); selectEdge(edge.id); },
        text: label.trim() || 'label',
      });
      wrap.appendChild(pill);

      if (selected) {
        const bar = el('div', { class: 'am-edge-toolbar' });
        for (const k of ['default', 'success', 'error']) {
          bar.appendChild(el('button', {
            class: 'am-edge-kbtn', title: k, style: { color: EDGE_COLOR[k] },
            onclick: (e) => { e.stopPropagation(); store.updateEdgeData(edge.id, { kind: k }); drawEdges(); },
            html: kind === k ? icon('check', 12) : `<span class="am-edge-kdot" style="background:${EDGE_COLOR[k]}"></span>`,
          }));
        }
        bar.appendChild(el('span', { class: 'am-edge-tdiv' }));
        bar.appendChild(el('button', {
          class: 'am-edge-kbtn danger', title: 'Delete connection',
          onclick: (e) => { e.stopPropagation(); store.deleteEdge(edge.id); selectedEdgeId = null; },
          html: icon('trash', 12),
        }));
        wrap.appendChild(bar);
      }
    }
    return wrap;
  }

  function commitEdgeLabel(id, value) {
    store.updateEdgeData(id, { label: value.trim() });
    editingEdgeId = null;
    drawEdges();
  }

  function selectEdge(id) {
    selectedEdgeId = id;
    if (store.getState().selectedNodeId) store.setSelectedNode(null);
    else drawEdges();
  }

  /* ================= interaction ================= */
  let mode = null;            // 'pan' | 'node' | 'connect'
  let start = null;           // gesture start data

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 1) return; // ignore middle for now
    const handle = e.target.closest('.am-handle.out');
    const nodeEl = e.target.closest('.am-node');
    if (e.target.closest('.am-minimap') || e.target.closest('.am-controls') ||
        e.target.closest('.am-edge-label-wrap')) return;

    if (handle) {
      startConnect(handle, e);
    } else if (nodeEl) {
      startNodeDrag(nodeEl, e);
    } else {
      // empty pane → pan + clear selection
      startPan(e);
    }
  });

  function startPan(e) {
    mode = 'pan';
    start = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y, moved: false };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('am-panning');
  }

  function startNodeDrag(nodeEl, e) {
    const id = nodeEl.dataset.nodeId;
    const node = store.getState().nodes.find((n) => n.id === id);
    if (!node) return;
    store.snapshot();
    mode = 'node';
    start = { px: e.clientX, py: e.clientY, ox: node.position.x, oy: node.position.y, id, moved: false, pos: { ...node.position } };
    canvas.setPointerCapture(e.pointerId);
    nodeEl.classList.add('am-dragging');
  }

  function startConnect(handle, e) {
    mode = 'connect';
    const r = rect();
    start = {
      source: handle.dataset.nodeId,
      sourceHandle: handle.dataset.portId,
      from: anchorOf(handle),
    };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('am-connecting');
    tempPath.style.display = '';
    updateTemp(e.clientX - r.left, e.clientY - r.top);
  }

  function anchorOf(handle) {
    const node = store.getState().nodes.find((n) => n.id === handle.dataset.nodeId);
    return handlePos(node, 'source', handle.dataset.portId);
  }

  function updateTemp(sx, sy) {
    const a = start.from;
    const bx = (sx - view.x) / view.k;
    const by = (sy - view.y) / view.k;
    const { path } = getBezierPath(a.x, a.y, bx, by);
    tempPath.setAttribute('d', path);
  }

  canvas.addEventListener('pointermove', (e) => {
    if (!mode) return;
    if (mode === 'pan') {
      const dx = e.clientX - start.px, dy = e.clientY - start.py;
      if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
      view.x = start.vx + dx;
      view.y = start.vy + dy;
      applyView();
    } else if (mode === 'node') {
      const dx = (e.clientX - start.px) / view.k;
      const dy = (e.clientY - start.py) / view.k;
      if (Math.abs(e.clientX - start.px) + Math.abs(e.clientY - start.py) > 3) start.moved = true;
      let nx = start.ox + dx, ny = start.oy + dy;
      if (store.getState().ui.snapToGrid) { nx = Math.round(nx / GRID) * GRID; ny = Math.round(ny / GRID) * GRID; }
      start.pos = { x: nx, y: ny };
      const elem = nodeEls.get(start.id);
      if (elem) elem.style.transform = `translate(${nx}px, ${ny}px)`;
      drawEdges({ id: start.id, position: start.pos });
    } else if (mode === 'connect') {
      const r = rect();
      updateTemp(e.clientX - r.left, e.clientY - r.top);
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.am-handle.in');
      canvas.querySelectorAll('.am-handle.over').forEach((h) => h.classList.remove('over'));
      if (over && over.dataset.nodeId !== start.source) over.classList.add('over');
    }
  });

  function endGesture(e) {
    if (!mode) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    if (mode === 'pan') {
      canvas.classList.remove('am-panning');
      if (!start.moved) { // click on empty → clear selection
        if (store.getState().selectedNodeId) store.setSelectedNode(null);
        if (selectedEdgeId) { selectedEdgeId = null; drawEdges(); }
      }
    } else if (mode === 'node') {
      const elem = nodeEls.get(start.id);
      if (elem) elem.classList.remove('am-dragging');
      if (start.moved) {
        store.setNodePosition(start.id, start.pos);
      } else {
        selectedEdgeId = null;
        store.setSelectedNode(start.id);
      }
    } else if (mode === 'connect') {
      canvas.classList.remove('am-connecting');
      tempPath.style.display = 'none';
      tempPath.setAttribute('d', '');
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.am-handle.in');
      canvas.querySelectorAll('.am-handle.over').forEach((h) => h.classList.remove('over'));
      if (over && over.dataset.nodeId !== start.source) {
        store.onConnect({
          source: start.source, sourceHandle: start.sourceHandle,
          target: over.dataset.nodeId, targetHandle: over.dataset.portId,
        });
      }
    }
    mode = null; start = null;
  }
  canvas.addEventListener('pointerup', endGesture);
  canvas.addEventListener('pointercancel', endGesture);

  /* wheel: pan, or zoom with ctrl/meta */
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAround(e.clientX, e.clientY, view.k * factor);
    } else {
      view.x -= e.deltaX;
      view.y -= e.deltaY;
      applyView();
    }
  }, { passive: false });

  /* edge click / dblclick / context selection */
  canvas.addEventListener('click', (e) => {
    const hit = e.target.closest('.am-edge-hit, .am-edge');
    if (hit) { selectEdge(hit.dataset.edgeId); }
  });
  canvas.addEventListener('dblclick', (e) => {
    const hit = e.target.closest('.am-edge-hit, .am-edge');
    if (hit) { editingEdgeId = hit.dataset.edgeId; selectedEdgeId = hit.dataset.edgeId; drawEdges(); }
  });

  /* context menu */
  canvas.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.am-minimap') || e.target.closest('.am-controls')) return;
    e.preventDefault();
    const nodeEl = e.target.closest('.am-node');
    const edgeHit = e.target.closest('.am-edge-hit, .am-edge');
    let menu;
    if (nodeEl) menu = { type: 'node', x: e.clientX, y: e.clientY, id: nodeEl.dataset.nodeId };
    else if (edgeHit) menu = { type: 'edge', x: e.clientX, y: e.clientY, id: edgeHit.dataset.edgeId };
    else menu = { type: 'pane', x: e.clientX, y: e.clientY, flow: screenToFlow(e.clientX, e.clientY) };
    ctxHandler?.(menu);
  });

  /* drag-drop from the palette */
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData(DRAG_MIME);
    if (!kind || !KIND_META[kind]) return;
    store.addNode(kind, screenToFlow(e.clientX, e.clientY));
  });

  /* ================= zoom controls ================= */
  function buildControls() {
    const zoomLabel = el('button', { class: 'am-control-btn am-zoom-label', title: 'Reset zoom', onclick: () => { view.k = 1; applyView(); } }, '100%');
    const root = el('div', { class: 'am-controls' },
      el('button', { class: 'am-control-btn', title: 'Zoom in', onclick: () => zoomCenter(1.2), html: icon('zoomIn', 16) }),
      zoomLabel,
      el('button', { class: 'am-control-btn', title: 'Zoom out', onclick: () => zoomCenter(1 / 1.2), html: icon('zoomOut', 16) }),
      el('button', { class: 'am-control-btn', title: 'Fit view', onclick: () => fitView({ padding: 0.2 }), html: icon('maximize', 16) }),
    );
    return { el: root, setZoom: (k) => { zoomLabel.textContent = Math.round(k * 100) + '%'; } };
  }
  function zoomCenter(factor) {
    const r = rect();
    zoomAround(r.left + r.width / 2, r.top + r.height / 2, view.k * factor);
  }

  /* ================= minimap ================= */
  function drawMinimap() {
    const state = store.getState();
    if (!state.ui.showMiniMap) { minimap.style.display = 'none'; return; }
    minimap.style.display = '';
    const W = 200, H = 140, PAD = 10;
    const ns = state.nodes;
    clear(minimap);
    const s = svg('svg', { class: 'am-minimap-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    if (!ns.length) { minimap.appendChild(s); return; }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) {
      const { w, h } = nodeSize(n.id);
      minX = Math.min(minX, n.position.x); minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w); maxY = Math.max(maxY, n.position.y + h);
    }
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const scale = Math.min((W - PAD * 2) / bw, (H - PAD * 2) / bh);
    const offX = (W - bw * scale) / 2, offY = (H - bh * scale) / 2;
    const mx = (wx) => offX + (wx - minX) * scale;
    const my = (wy) => offY + (wy - minY) * scale;

    for (const n of ns) {
      const { w, h } = nodeSize(n.id);
      s.appendChild(svg('rect', {
        x: mx(n.position.x), y: my(n.position.y), width: w * scale, height: h * scale, rx: 2,
        fill: KIND_META[n.data.kind].color, 'fill-opacity': '0.85',
      }));
    }
    // viewport rectangle
    const r = rect();
    const vx = -view.x / view.k, vy = -view.y / view.k;
    const vw = r.width / view.k, vh = r.height / view.k;
    s.appendChild(svg('rect', {
      class: 'am-minimap-view',
      x: mx(vx), y: my(vy), width: vw * scale, height: vh * scale,
    }));
    minimap.appendChild(s);

    // click to recenter
    s.addEventListener('pointerdown', (e) => {
      const b = s.getBoundingClientRect();
      const wx = minX + (e.clientX - b.left - offX) / scale;
      const wy = minY + (e.clientY - b.top - offY) / scale;
      const cr = rect();
      view.x = cr.width / 2 - wx * view.k;
      view.y = cr.height / 2 - wy * view.k;
      applyView();
      e.stopPropagation();
    });
  }

  /* ================= lifecycle ================= */
  const unsub = store.subscribe(() => render());
  render();

  return {
    el: canvas,
    fitView,
    focusNode,
    setContextMenuHandler(fn) { ctxHandler = fn; },
    onShown() {
      // The modal-body has zero size while hidden, so node heights measured at
      // mount are fallbacks. Re-render (re-measures offsetHeight) then fit.
      render();
      requestAnimationFrame(() => fitView({ padding: 0.25, maxZoom: 1 }));
    },
    refresh() { render(); },
    destroy() { unsub(); },
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function arrowMarker(id, color) {
  // When `color` is null the fill is left to CSS (used for the selected marker,
  // which follows the theme --accent var via a stylesheet rule).
  const path = svg('path', color
    ? { d: 'M0,0 L0,6 L6,3 z', fill: color }
    : { d: 'M0,0 L0,6 L6,3 z' });
  return svg('marker', {
    id, viewBox: '0 0 6 6', markerWidth: 6, markerHeight: 6,
    refX: 5.5, refY: 3, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse',
  }, path);
}

function kindHint(d) {
  switch (d.kind) {
    case 'api': return d.url.trim() || null;
    case 'terminal': return d.command.trim() || null;
    case 'database': return d.schema.trim() ? d.schema.trim() : (d.hasCredentials ? 'credentials set' : null);
    case 'agent': return d.prompt.trim() || null;
    case 'env': return d.envVars.trim() ? d.envVars.split('\n')[0].trim() : null;
    default: return null;
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
