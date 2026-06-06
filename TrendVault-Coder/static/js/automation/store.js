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
import { makeNodeData, normalizeNode } from './registry.js';
import { buildSample, buildAgentPipelineSample, DEFAULT_SPACES } from './sample.js';
import { APP_ID } from './io.js';
import * as api from './api.js';

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
  runtime: {}, activeRun: null,
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
    ui: { snapToGrid: false, showMiniMap: true, showHealth: true, showSearch: true, searchCollapsed: false, healthCollapsed: false, ...(p.ui || {}) },
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
  // Server sync (Phase 1). serverSynced flips true once we've talked to the
  // backend; until then we run purely off the localStorage snapshot.
  serverSynced: false,
  _hydrated: false,
  // Runtime execution state (Phase 2+). Kept OUT of the persisted doc — never
  // written to localStorage or the server. Keyed by node id.
  runtime: {},
  activeRun: null,
};

const listeners = new Set();
let persistTimer = 0;
let serverTimer = 0;       // debounced server autosave
let graphDirty = false;    // a graph (nodes/edges/spaces) change awaits autosave

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

/* ------------------------------------------------------------------ */
/* Server sync (SQLite-backed persistence; localStorage = offline cache)*/
/* ------------------------------------------------------------------ */

function activeBoardEntry() {
  return state.boards.find((b) => b.id === state.activeBoardId) || null;
}

/** The live graph as a server doc. */
function liveDoc() {
  return { nodes: state.nodes, edges: state.edges, spaces: state.spaces };
}

function scheduleServerPersist() {
  clearTimeout(serverTimer);
  serverTimer = setTimeout(serverAutosave, 5000);
}

/** PUT the active board's graph to the server (5s debounced via set()). */
async function serverAutosave() {
  if (!state.serverSynced || !graphDirty) return;
  const board = activeBoardEntry();
  if (!board) return;
  graphDirty = false;
  const wid = board.id;
  const rev = board._rev ?? 0;
  try {
    const resp = await api.saveWorkflow(wid, { name: board.name, doc: liveDoc(), rev });
    // Write the new rev onto the SAME board object that lands in state (not a
    // pre-await copy) so the next autosave sends a fresh rev — otherwise a
    // stale rev would 409 and revert the user's in-flight edits.
    set({ boards: state.boards.map((b) => (b.id === wid ? { ...b, _rev: resp.rev, _loaded: true } : b)) });
  } catch (e) {
    if (e && e.status === 409 && e.body?.detail?.current) {
      // A newer save won (e.g. another tab/user) — adopt the server's version.
      const cur = e.body.detail.current;
      const isActive = state.activeBoardId === wid;
      set({
        boards: state.boards.map((b) => (b.id === wid ? { ...b, _rev: cur.rev } : b)),
        ...(isActive ? {
          nodes: (cur.doc.nodes || []).map(normalizeNode),
          edges: cur.doc.edges || [],
          spaces: cur.doc.spaces?.length ? cur.doc.spaces : state.spaces,
        } : {}),
      });
      // We just took the server copy; don't immediately re-save it.
      graphDirty = false;
      clearTimeout(serverTimer);
    } else {
      // Network/server error — fall back to localStorage-only until next open.
      set({ serverSynced: false });
    }
  }
}

/**
 * Immediate, awaitable save of the active board (used by explicit "Save"
 * actions and the empty-state flows). Always writes the localStorage cache;
 * additionally PUTs to the server when synced. Resolves {ok, offline?, rev} on
 * success and THROWS if the server write fails (callers show an error toast).
 */
export async function saveNow() {
  const board = activeBoardEntry();
  if (!board) return { ok: false, offline: true };
  clearTimeout(persistTimer);
  persist();
  if (!state.serverSynced) return { ok: false, offline: true };
  clearTimeout(serverTimer);
  graphDirty = false;
  const resp = await api.saveWorkflow(board.id, { name: board.name, doc: liveDoc(), rev: board._rev ?? 0 });
  set({ boards: state.boards.map((b) => (b.id === board.id ? { ...b, _rev: resp.rev, _loaded: true } : b)) });
  return { ok: true, rev: resp.rev };
}

/**
 * Load boards from the backend on first open. If the user has none yet, seed
 * the server with the current (sample/local) board. On any failure we keep the
 * localStorage-loaded state and stay in offline mode.
 */
export async function hydrateFromServer() {
  if (state._hydrated && state.serverSynced) return;
  let list;
  try {
    list = await api.listWorkflows();
  } catch {
    set({ serverSynced: false, _hydrated: true });
    return;
  }

  if (!list.length) {
    const board = activeBoardEntry();
    try {
      const created = await api.createWorkflow({ name: board?.name || 'My Project', doc: liveDoc() });
      const boards = state.boards.map((b) => (b.id === state.activeBoardId
        ? { ...b, id: created.id, name: created.name, _rev: created.rev, _loaded: true }
        : b));
      set({ boards, activeBoardId: created.id, serverSynced: true, _hydrated: true });
    } catch {
      set({ serverSynced: false, _hydrated: true });
    }
    return;
  }

  const boards = list.map((r) => ({
    id: r.id, name: r.name, nodes: [], edges: [], spaces: [], _rev: r.rev, _loaded: false,
  }));
  const activeId = boards.some((b) => b.id === state.activeBoardId) ? state.activeBoardId : boards[0].id;
  try {
    const full = await api.getWorkflow(activeId);
    const ab = boards.find((b) => b.id === activeId);
    ab.nodes = (full.doc.nodes || []).map(normalizeNode);
    ab.edges = full.doc.edges || [];
    ab.spaces = full.doc.spaces?.length ? full.doc.spaces : DEFAULT_SPACES.map((s) => ({ ...s }));
    ab._rev = full.rev;
    ab._loaded = true;
    set({
      boards, activeBoardId: activeId,
      nodes: ab.nodes, edges: ab.edges, spaces: ab.spaces,
      serverSynced: true, _hydrated: true,
      ...BOARD_SWITCH_RESET(),
    });
  } catch {
    set({ serverSynced: false, _hydrated: true });
  }
}

export function getState() { return state; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(patch) {
  const applied = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...applied };
  for (const l of listeners) l(state);
  schedulePersist();
  // Any change to the graph itself marks the active board dirty for the 5s
  // server autosave. Selection / filters / ui / runtime changes don't.
  if (applied && typeof applied === 'object' &&
      ('nodes' in applied || 'edges' in applied || 'spaces' in applied)) {
    graphDirty = true;
    scheduleServerPersist();
  }
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

/** Toggle the human-in-the-loop "Approve" gate on a node (persisted). */
export function approveNode(id, value = true) {
  set({ nodes: state.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, approved: !!value } } : n)) });
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
export async function switchBoard(id) {
  if (id === state.activeBoardId) return;
  let target = state.boards.find((b) => b.id === id);
  if (!target) return;
  // Flush any pending edits on the current board before leaving it.
  if (graphDirty) await serverAutosave();
  // Lazily load the target board's graph from the server.
  if (state.serverSynced && !target._loaded) {
    try {
      const full = await api.getWorkflow(id);
      target = {
        ...target,
        nodes: (full.doc.nodes || []).map(normalizeNode),
        edges: full.doc.edges || [],
        spaces: full.doc.spaces?.length ? full.doc.spaces : DEFAULT_SPACES.map((s) => ({ ...s })),
        _rev: full.rev,
        _loaded: true,
      };
    } catch { /* offline — use whatever we have cached */ }
  }
  set({
    boards: state.boards.map((b) => {
      if (b.id === state.activeBoardId) return { ...b, nodes: state.nodes, edges: state.edges, spaces: state.spaces };
      if (b.id === id) return target;
      return b;
    }),
    activeBoardId: id,
    nodes: target.nodes, edges: target.edges, spaces: target.spaces,
    ...BOARD_SWITCH_RESET(),
  });
}

export async function createBoard(name) {
  const trimmed = (name || '').trim() || 'Untitled board';
  const synced = syncActiveBoard(state.boards, state.activeBoardId, state.nodes, state.edges, state.spaces);
  const spaces = DEFAULT_SPACES.map((s) => ({ ...s }));
  if (state.serverSynced) {
    try {
      const created = await api.createWorkflow({ name: trimmed, doc: { nodes: [], edges: [], spaces } });
      const board = { id: created.id, name: created.name, nodes: [], edges: [], spaces, _rev: created.rev, _loaded: true };
      set({ boards: [...synced, board], activeBoardId: created.id, nodes: [], edges: [], spaces, ...BOARD_SWITCH_RESET() });
      return;
    } catch { /* fall through to local-only */ }
  }
  const id = 'board-' + nanoid(6);
  const board = { id, name: trimmed, nodes: [], edges: [], spaces, _rev: 0, _loaded: true };
  set({ boards: [...synced, board], activeBoardId: id, nodes: [], edges: [], spaces, ...BOARD_SWITCH_RESET() });
}

export function renameBoard(id, name) {
  const nm = (name || '').trim();
  set({ boards: state.boards.map((b) => (b.id === id ? { ...b, name: nm || b.name } : b)) });
  if (state.serverSynced && nm) {
    const board = state.boards.find((b) => b.id === id);
    const body = { name: nm, rev: board?._rev ?? 0 };
    // Including the live doc on the active board keeps rev in lock-step with
    // the pending autosave (avoids a self-inflicted 409).
    if (id === state.activeBoardId) { body.doc = liveDoc(); graphDirty = false; }
    api.saveWorkflow(id, body).then((resp) => { if (board) board._rev = resp.rev; }).catch(() => {});
  }
}

export async function duplicateBoard(id) {
  const synced = syncActiveBoard(state.boards, state.activeBoardId, state.nodes, state.edges, state.spaces);
  const src = synced.find((b) => b.id === id);
  if (!src) return;
  let doc = { nodes: src.nodes, edges: src.edges, spaces: src.spaces };
  if (state.serverSynced && !src._loaded) {
    try { doc = (await api.getWorkflow(id)).doc; } catch { /* use cached */ }
  }
  if (state.serverSynced) {
    try {
      const created = await api.createWorkflow({ name: src.name + ' copy', doc });
      const board = { id: created.id, name: created.name, nodes: doc.nodes || [], edges: doc.edges || [], spaces: doc.spaces || [], _rev: created.rev, _loaded: true };
      set({ boards: [...synced, board], activeBoardId: created.id, nodes: board.nodes, edges: board.edges, spaces: board.spaces, ...BOARD_SWITCH_RESET() });
      return;
    } catch { /* fall through */ }
  }
  const newId = 'board-' + nanoid(6);
  const copy = { id: newId, name: src.name + ' copy', nodes: doc.nodes || [], edges: doc.edges || [], spaces: doc.spaces || [], _rev: 0, _loaded: true };
  set({ boards: [...synced, copy], activeBoardId: newId, nodes: copy.nodes, edges: copy.edges, spaces: copy.spaces, ...BOARD_SWITCH_RESET() });
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
  if (state.serverSynced) api.deleteWorkflow(id).catch(() => {});
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

/* ---- runtime execution state (live; never persisted) ---- */
export function getNodeRuntime(id) { return state.runtime[id] || null; }
export function setNodeRuntime(id, patch) {
  set({ runtime: { ...state.runtime, [id]: { ...(state.runtime[id] || {}), ...patch } } });
}
/** Append streamed text deltas (batched by the caller) to runtime fields. */
export function appendNodeRuntimeBatch(id, patch) {
  const cur = state.runtime[id] || {};
  const next = { ...cur };
  for (const k of Object.keys(patch)) next[k] = (cur[k] || '') + patch[k];
  set({ runtime: { ...state.runtime, [id]: next } });
}
export function clearNodeRuntime(id) {
  const r = { ...state.runtime };
  delete r[id];
  set({ runtime: r });
}
export function resetRuntime() { set({ runtime: {}, activeRun: null }); }
/** Replace the whole runtime map in one update (e.g. seed all nodes 'waiting'). */
export function setRuntimeAll(map) { set({ runtime: map || {} }); }
export function setActiveRun(run) { set({ activeRun: run }); }

/* ---- persistence / import-export ---- */
export function exportState(exportedAt) {
  return { app: APP_ID, version: 1, exportedAt, nodes: state.nodes, edges: state.edges, spaces: state.spaces };
}

export function importWorkflow(file) {
  snapshot();
  set({
    nodes: (file.nodes ?? []).map(normalizeNode),
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
  const s = buildAgentPipelineSample();
  set({
    nodes: s.nodes, edges: s.edges, spaces: s.spaces,
    selectedNodeId: null, activeSpace: 'all', runtime: {}, activeRun: null,
  });
}

/* ---- snapshot / restore (used by the Full System Check to run real
   operations on the live graph and then put everything back exactly) ---- */
export function snapshotGraph() {
  return JSON.parse(JSON.stringify({
    nodes: state.nodes, edges: state.edges, spaces: state.spaces,
    selectedNodeId: state.selectedNodeId, activeSpace: state.activeSpace,
    filters: state.filters, runtime: state.runtime,
  }));
}
/** Restore a snapshot from snapshotGraph(). Clears the undo history so the
 *  check's scratch operations don't pollute it. */
export function restoreGraph(snap) {
  if (!snap) return;
  set({
    nodes: snap.nodes || [], edges: snap.edges || [], spaces: snap.spaces || [],
    selectedNodeId: snap.selectedNodeId ?? null,
    activeSpace: snap.activeSpace ?? 'all',
    filters: snap.filters || { ...EMPTY_FILTERS },
    runtime: snap.runtime || {},
    past: [], future: [], _histTag: undefined,
  });
}

/** Convenience: the currently-selected node (or null). */
export function selectedNode() {
  const id = state.selectedNodeId;
  return id ? state.nodes.find((n) => n.id === id) ?? null : null;
}
