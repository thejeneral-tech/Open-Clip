/**
 * Automation Map — state store.
 *
 * A tiny observable store (getState / setState / subscribe) replacing the
 * React app's zustand store (store/useStore.ts). Holds boards, the live
 * working copy of the active board (nodes/edges/spaces), selection, filters,
 * UI flags and an undo/redo history. Persists a partial snapshot to a
 * TrendVault-namespaced localStorage key.
 */

import { nanoid } from './dom.js';
import { makeNodeData } from './registry.js';
import { buildSample, DEFAULT_SPACES } from './sample.js';
import { APP_ID } from './io.js';

const STORAGE_KEY = 'trendvault-ai.automationMap.v1';
const DEFAULT_BOARD_ID = 'board-default';
const HISTORY_LIMIT = 50;
const SPACE_PALETTE = ['#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#22d3ee', '#fbbf24', '#fb923c', '#f87171'];

const EMPTY_FILTERS = {
  search: '', statuses: [], kinds: [], tags: [], brokenOnly: false, unfinishedOnly: false,
};

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

function edgeKindForHandle(node, handleId) {
  if (!node || !handleId) return 'default';
  const port = node.data.outputs.find((p) => p.id === handleId);
  return port?.kind ?? 'default';
}

/** Write the live nodes/edges/spaces back into the active board entry. */
function syncActiveBoard(boards, activeBoardId, nodes, edges, spaces) {
  return boards.map((b) => (b.id === activeBoardId ? { ...b, nodes, edges, spaces } : b));
}

/** Layered (Sugiyama-lite) layout: columns by longest path from roots. */
function computeLayout(nodes, edges) {
  const COL_GAP = 320, ROW_GAP = 168, X0 = 80, Y0 = 80;
  const adj = new Map(), indeg = new Map();
  nodes.forEach((n) => { adj.set(n.id, []); indeg.set(n.id, 0); });
  edges.forEach((e) => {
    if (adj.has(e.source) && indeg.has(e.target)) {
      adj.get(e.source).push(e.target);
      indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    }
  });
  const level = new Map();
  nodes.forEach((n) => level.set(n.id, 0));
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const working = new Map(indeg);
  while (queue.length) {
    const id = queue.shift();
    for (const next of adj.get(id) ?? []) {
      level.set(next, Math.max(level.get(next) ?? 0, (level.get(id) ?? 0) + 1));
      const d = (working.get(next) ?? 0) - 1;
      working.set(next, d);
      if (d <= 0) queue.push(next);
    }
  }
  const byLevel = new Map();
  nodes.forEach((n) => {
    const l = level.get(n.id) ?? 0;
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l).push(n.id);
  });
  const posY = new Map(nodes.map((n) => [n.id, n.position.y]));
  const result = {};
  [...byLevel.keys()].sort((a, b) => a - b).forEach((l) => {
    const ids = byLevel.get(l).sort((a, b) => (posY.get(a) ?? 0) - (posY.get(b) ?? 0));
    ids.forEach((id, i) => { result[id] = { x: X0 + l * COL_GAP, y: Y0 + i * ROW_GAP }; });
  });
  return result;
}

const BOARD_SWITCH_RESET = () => ({
  selectedNodeId: null, activeSpace: 'all', past: [], future: [], _histTag: undefined,
});

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function loadPersisted() {
  let p = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) p = JSON.parse(raw) || {};
  } catch { p = {}; }

  let boards = Array.isArray(p.boards) ? p.boards : undefined;
  let activeBoardId = typeof p.activeBoardId === 'string' ? p.activeBoardId : undefined;

  if (!boards || boards.length === 0) {
    // First run (or legacy single-canvas save) → seed with the sample board.
    const s = buildSample();
    boards = [{
      id: DEFAULT_BOARD_ID,
      name: 'My Project',
      nodes: Array.isArray(p.nodes) ? p.nodes : s.nodes,
      edges: Array.isArray(p.edges) ? p.edges : s.edges,
      spaces: Array.isArray(p.spaces) && p.spaces.length ? p.spaces : s.spaces,
    }];
    activeBoardId = DEFAULT_BOARD_ID;
  }
  if (!activeBoardId || !boards.find((b) => b.id === activeBoardId)) activeBoardId = boards[0].id;
  const active = boards.find((b) => b.id === activeBoardId);

  return {
    boards,
    activeBoardId,
    nodes: active.nodes,
    edges: active.edges,
    spaces: active.spaces?.length ? active.spaces : DEFAULT_SPACES.map((s) => ({ ...s })),
    activeSpace: typeof p.activeSpace === 'string' ? p.activeSpace : 'all',
    ui: { snapToGrid: false, showMiniMap: true, showHealth: true, showSearch: true, ...(p.ui || {}) },
    filters: { ...EMPTY_FILTERS, ...(p.filters || {}) },
  };
}

/* ------------------------------------------------------------------ */
/* Store factory                                                       */
/* ------------------------------------------------------------------ */

const persisted = loadPersisted();

let state = {
  ...persisted,
  selectedNodeId: null,
  past: [],
  future: [],
  _histTag: undefined,
  commandOpen: false,
  exportOpen: false,
};

const listeners = new Set();
let persistTimer = 0;

function persist() {
  try {
    const payload = {
      boards: syncActiveBoard(state.boards, state.activeBoardId, state.nodes, state.edges, state.spaces),
      activeBoardId: state.activeBoardId,
      activeSpace: state.activeSpace,
      ui: state.ui,
      filters: state.filters,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch { /* quota / private mode — ignore */ }
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}

export function getState() { return state; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l(state);
  schedulePersist();
}

export function canUndo() { return state.past.length > 0; }
export function canRedo() { return state.future.length > 0; }

/* ---- history ---- */
export function snapshot(tag) {
  if (tag !== undefined && tag === state._histTag) return; // coalesce runs of the same edit
  set({
    past: [...state.past, { nodes: state.nodes, edges: state.edges }].slice(-HISTORY_LIMIT),
    future: [],
    _histTag: tag,
  });
}

export function undo() {
  if (state.past.length === 0) return;
  const prev = state.past[state.past.length - 1];
  const { nodes, edges, selectedNodeId } = state;
  set({
    nodes: prev.nodes,
    edges: prev.edges,
    past: state.past.slice(0, -1),
    future: [{ nodes, edges }, ...state.future].slice(0, HISTORY_LIMIT),
    _histTag: undefined,
    selectedNodeId: selectedNodeId && prev.nodes.some((n) => n.id === selectedNodeId) ? selectedNodeId : null,
  });
}

export function redo() {
  if (state.future.length === 0) return;
  const next = state.future[0];
  const { nodes, edges, selectedNodeId } = state;
  set({
    nodes: next.nodes,
    edges: next.edges,
    past: [...state.past, { nodes, edges }].slice(-HISTORY_LIMIT),
    future: state.future.slice(1),
    _histTag: undefined,
    selectedNodeId: selectedNodeId && next.nodes.some((n) => n.id === selectedNodeId) ? selectedNodeId : null,
  });
}

/* ---- selection ---- */
export function setSelectedNode(id) { set({ selectedNodeId: id }); }

/* ---- nodes ---- */
export function addNode(kind, position) {
  snapshot();
  const id = nanoid(8);
  const { activeSpace, spaces, nodes } = state;
  const space = activeSpace !== 'all' ? activeSpace : (spaces[0]?.id ?? 'frontend');
  const pos = position ?? { x: 120 + (nodes.length % 6) * 48, y: 120 + (nodes.length % 6) * 48 };
  const node = { id, type: 'workflow', position: pos, data: makeNodeData(kind, space) };
  set({ nodes: [...nodes, node], selectedNodeId: id });
  return id;
}

export function updateNodeData(id, patch) {
  snapshot('node:' + id);
  set({ nodes: state.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)) });
}

/** Move a node (no history — the canvas snapshots once at drag start). */
export function setNodePosition(id, position) {
  set({ nodes: state.nodes.map((n) => (n.id === id ? { ...n, position } : n)) });
}

export function deleteNode(id) {
  snapshot();
  set({
    nodes: state.nodes.filter((n) => n.id !== id),
    edges: state.edges.filter((e) => e.source !== id && e.target !== id),
    selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
  });
}

export function duplicateNode(id) {
  const original = state.nodes.find((n) => n.id === id);
  if (!original) return;
  snapshot();
  const copy = {
    ...original,
    id: nanoid(8),
    position: { x: original.position.x + 48, y: original.position.y + 48 },
    data: {
      ...original.data,
      title: `${original.data.title} copy`,
      inputs: original.data.inputs.map((p) => ({ ...p, id: nanoid(6) })),
      outputs: original.data.outputs.map((p) => ({ ...p, id: nanoid(6) })),
    },
  };
  set({ nodes: [...state.nodes, copy], selectedNodeId: copy.id });
}

/* ---- edges ---- */
export function onConnect(connection) {
  if (!connection.source || !connection.target) return;
  if (connection.source === connection.target) return;
  // Avoid duplicate identical connections.
  const dup = state.edges.some(
    (e) => e.source === connection.source && e.target === connection.target &&
      e.sourceHandle === connection.sourceHandle && e.targetHandle === connection.targetHandle,
  );
  if (dup) return;
  snapshot();
  const source = state.nodes.find((n) => n.id === connection.source);
  const kind = edgeKindForHandle(source, connection.sourceHandle);
  const newEdge = {
    id: nanoid(8),
    source: connection.source,
    target: connection.target,
    sourceHandle: connection.sourceHandle,
    targetHandle: connection.targetHandle,
    type: 'labeled',
    data: { label: '', kind },
  };
  set({ edges: [...state.edges, newEdge] });
}

export function updateEdgeData(id, patch) {
  snapshot('edge:' + id);
  set({
    edges: state.edges.map((e) =>
      e.id === id ? { ...e, data: { ...(e.data ?? { label: '', kind: 'default' }), ...patch } } : e),
  });
}

export function deleteEdge(id) {
  snapshot();
  set({ edges: state.edges.filter((e) => e.id !== id) });
}

/* ---- layout ---- */
export function tidyLayout() {
  if (state.nodes.length === 0) return;
  snapshot();
  const positions = computeLayout(state.nodes, state.edges);
  set({ nodes: state.nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)) });
}

/* ---- boards ---- */
export function switchBoard(id) {
  if (id === state.activeBoardId) return;
  const target = state.boards.find((b) => b.id === id);
  if (!target) return;
  set({
    boards: syncActiveBoard(state.boards, state.activeBoardId, state.nodes, state.edges, state.spaces),
    activeBoardId: id,
    nodes: target.nodes, edges: target.edges, spaces: target.spaces,
    ...BOARD_SWITCH_RESET(),
  });
}

export function createBoard(name) {
  const trimmed = (name || '').trim() || 'Untitled board';
  const id = 'board-' + nanoid(6);
  const board = { id, name: trimmed, nodes: [], edges: [], spaces: DEFAULT_SPACES.map((s) => ({ ...s })) };
  set({
    boards: [...syncActiveBoard(state.boards, state.activeBoardId, state.nodes, state.edges, state.spaces), board],
    activeBoardId: id,
    nodes: [], edges: [], spaces: board.spaces,
    ...BOARD_SWITCH_RESET(),
  });
}

export function renameBoard(id, name) {
  set({ boards: state.boards.map((b) => (b.id === id ? { ...b, name: (name || '').trim() || b.name } : b)) });
}

export function duplicateBoard(id) {
  const synced = syncActiveBoard(state.boards, state.activeBoardId, state.nodes, state.edges, state.spaces);
  const src = synced.find((b) => b.id === id);
  if (!src) return;
  const newId = 'board-' + nanoid(6);
  const copy = { id: newId, name: src.name + ' copy', nodes: src.nodes, edges: src.edges, spaces: src.spaces };
  set({
    boards: [...synced, copy],
    activeBoardId: newId,
    nodes: copy.nodes, edges: copy.edges, spaces: copy.spaces,
    ...BOARD_SWITCH_RESET(),
  });
}

export function deleteBoard(id) {
  if (state.boards.length <= 1) return;
  const synced = syncActiveBoard(state.boards, state.activeBoardId, state.nodes, state.edges, state.spaces);
  const remaining = synced.filter((b) => b.id !== id);
  if (id === state.activeBoardId) {
    const next = remaining[0];
    set({
      boards: remaining, activeBoardId: next.id,
      nodes: next.nodes, edges: next.edges, spaces: next.spaces,
      ...BOARD_SWITCH_RESET(),
    });
  } else {
    set({ boards: remaining });
  }
}

/* ---- spaces ---- */
export function addSpace(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  const id = `${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${nanoid(4)}`;
  const color = SPACE_PALETTE[state.spaces.length % SPACE_PALETTE.length];
  set({ spaces: [...state.spaces, { id, name: trimmed, color }] });
}

export function renameSpace(id, name) {
  set({ spaces: state.spaces.map((s) => (s.id === id ? { ...s, name } : s)) });
}

export function deleteSpace(id) {
  const spaces = state.spaces.filter((s) => s.id !== id);
  const fallback = spaces[0]?.id ?? 'frontend';
  set({
    spaces,
    nodes: state.nodes.map((n) => (n.data.space === id ? { ...n, data: { ...n.data, space: fallback } } : n)),
    activeSpace: state.activeSpace === id ? 'all' : state.activeSpace,
  });
}

export function setActiveSpace(id) { set({ activeSpace: id }); }

/* ---- filters / ui ---- */
export function setFilters(patch) { set({ filters: { ...state.filters, ...patch } }); }
export function resetFilters() { set({ filters: { ...EMPTY_FILTERS } }); }
export function setUi(patch) { set({ ui: { ...state.ui, ...patch } }); }
export function setCommandOpen(open) { set({ commandOpen: open }); }
export function setExportOpen(open) { set({ exportOpen: open }); }

/* ---- persistence / import-export ---- */
export function exportState(exportedAt) {
  return { app: APP_ID, version: 1, exportedAt, nodes: state.nodes, edges: state.edges, spaces: state.spaces };
}

export function importWorkflow(file) {
  snapshot();
  set({
    nodes: file.nodes ?? [],
    edges: file.edges ?? [],
    spaces: file.spaces?.length ? file.spaces : DEFAULT_SPACES.map((s) => ({ ...s })),
    selectedNodeId: null,
    activeSpace: 'all',
  });
}

export function resetWorkflow() {
  snapshot();
  set({
    nodes: [], edges: [], spaces: DEFAULT_SPACES.map((s) => ({ ...s })),
    selectedNodeId: null, activeSpace: 'all', filters: { ...EMPTY_FILTERS },
  });
}

export function loadSample() {
  snapshot();
  const s = buildSample();
  set({ nodes: s.nodes, edges: s.edges, spaces: s.spaces, selectedNodeId: null });
}

/** Convenience: the currently-selected node (or null). */
export function selectedNode() {
  const id = state.selectedNodeId;
  return id ? state.nodes.find((n) => n.id === id) ?? null : null;
}
