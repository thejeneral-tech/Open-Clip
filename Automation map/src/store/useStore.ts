import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react';
import { nanoid } from 'nanoid';
import type {
  Board,
  EdgeData,
  Filters,
  FlowEdge,
  FlowNode,
  NodeData,
  NodeKind,
  Space,
  WorkflowFile,
} from '@/types';
import { makeNodeData } from '@/lib/nodeRegistry';
import { DEFAULT_SPACES, sampleEdges, sampleNodes } from '@/lib/sampleWorkflow';
import { STORAGE_KEY } from '@/lib/storage';

interface UiState {
  snapToGrid: boolean;
  showMiniMap: boolean;
  showHealth: boolean;
  showSearch: boolean;
}

interface Snapshot {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const HISTORY_LIMIT = 50;

const EMPTY_FILTERS: Filters = {
  search: '',
  statuses: [],
  kinds: [],
  tags: [],
  brokenOnly: false,
  unfinishedOnly: false,
};

export interface AppState {
  /* boards (multi-canvas) */
  boards: Board[];
  activeBoardId: string;

  /* data — live working copy of the active board */
  nodes: FlowNode[];
  edges: FlowEdge[];
  spaces: Space[];
  activeSpace: string; // 'all' | space id
  selectedNodeId: string | null;
  filters: Filters;
  ui: UiState;

  /* transient (not persisted) */
  past: Snapshot[];
  future: Snapshot[];
  _histTag: string | undefined;
  commandOpen: boolean;
  exportOpen: boolean;

  /* history */
  snapshot: (tag?: string) => void;
  undo: () => void;
  redo: () => void;

  /* React Flow handlers */
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void;
  onConnect: (connection: Connection) => void;

  /* selection */
  setSelectedNode: (id: string | null) => void;

  /* nodes */
  addNode: (kind: NodeKind, position?: XYPosition) => string;
  updateNodeData: (id: string, patch: Partial<NodeData>) => void;
  deleteNode: (id: string) => void;
  duplicateNode: (id: string) => void;

  /* edges */
  updateEdgeData: (id: string, patch: Partial<EdgeData>) => void;
  deleteEdge: (id: string) => void;

  /* layout */
  tidyLayout: () => void;

  /* boards */
  switchBoard: (id: string) => void;
  createBoard: (name: string) => void;
  renameBoard: (id: string, name: string) => void;
  duplicateBoard: (id: string) => void;
  deleteBoard: (id: string) => void;

  /* spaces */
  addSpace: (name: string) => void;
  renameSpace: (id: string, name: string) => void;
  deleteSpace: (id: string) => void;
  setActiveSpace: (id: string) => void;

  /* filters */
  setFilters: (patch: Partial<Filters>) => void;
  resetFilters: () => void;

  /* ui */
  setUi: (patch: Partial<UiState>) => void;
  setCommandOpen: (open: boolean) => void;
  setExportOpen: (open: boolean) => void;

  /* persistence */
  exportState: (exportedAt: string) => WorkflowFile;
  importWorkflow: (file: WorkflowFile) => void;
  resetWorkflow: () => void;
  loadSample: () => void;
}

const SPACE_PALETTE = ['#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#22d3ee', '#fbbf24', '#fb923c', '#f87171'];

function edgeKindForHandle(node: FlowNode | undefined, handleId: string | null | undefined): EdgeData['kind'] {
  if (!node || !handleId) return 'default';
  const port = node.data.outputs.find((p) => p.id === handleId);
  return port?.kind ?? 'default';
}

/** Layered (Sugiyama-lite) layout: columns by longest path from roots. */
function computeLayout(nodes: FlowNode[], edges: FlowEdge[]): Record<string, XYPosition> {
  const COL_GAP = 320;
  const ROW_GAP = 168;
  const X0 = 80;
  const Y0 = 80;

  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  nodes.forEach((n) => {
    adj.set(n.id, []);
    indeg.set(n.id, 0);
  });
  edges.forEach((e) => {
    if (adj.has(e.source) && indeg.has(e.target)) {
      adj.get(e.source)!.push(e.target);
      indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    }
  });

  const level = new Map<string, number>();
  nodes.forEach((n) => level.set(n.id, 0));
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const working = new Map(indeg);
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of adj.get(id) ?? []) {
      level.set(next, Math.max(level.get(next) ?? 0, (level.get(id) ?? 0) + 1));
      const d = (working.get(next) ?? 0) - 1;
      working.set(next, d);
      if (d <= 0) queue.push(next);
    }
  }

  const byLevel = new Map<number, string[]>();
  nodes.forEach((n) => {
    const l = level.get(n.id) ?? 0;
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l)!.push(n.id);
  });

  const posY = new Map(nodes.map((n) => [n.id, n.position.y]));
  const result: Record<string, XYPosition> = {};
  [...byLevel.keys()]
    .sort((a, b) => a - b)
    .forEach((l) => {
      const ids = byLevel.get(l)!.sort((a, b) => (posY.get(a) ?? 0) - (posY.get(b) ?? 0));
      ids.forEach((id, i) => {
        result[id] = { x: X0 + l * COL_GAP, y: Y0 + i * ROW_GAP };
      });
    });
  return result;
}

const DEFAULT_BOARD_ID = 'board-default';

/** Write the live nodes/edges/spaces back into the active board entry. */
function syncActiveBoard(
  boards: Board[],
  activeBoardId: string,
  nodes: FlowNode[],
  edges: FlowEdge[],
  spaces: Space[],
): Board[] {
  return boards.map((b) => (b.id === activeBoardId ? { ...b, nodes, edges, spaces } : b));
}

/** State reset applied whenever the active board changes. */
const BOARD_SWITCH_RESET = {
  selectedNodeId: null,
  activeSpace: 'all',
  past: [] as Snapshot[],
  future: [] as Snapshot[],
  _histTag: undefined,
};

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      boards: [
        { id: DEFAULT_BOARD_ID, name: 'My Project', nodes: sampleNodes, edges: sampleEdges, spaces: DEFAULT_SPACES },
      ],
      activeBoardId: DEFAULT_BOARD_ID,

      nodes: sampleNodes,
      edges: sampleEdges,
      spaces: DEFAULT_SPACES,
      activeSpace: 'all',
      selectedNodeId: null,
      filters: { ...EMPTY_FILTERS },
      ui: { snapToGrid: false, showMiniMap: true, showHealth: true, showSearch: true },

      past: [],
      future: [],
      _histTag: undefined,
      commandOpen: false,
      exportOpen: false,

      /* ---- history ---- */
      snapshot: (tag) => {
        const { nodes, edges, past, _histTag } = get();
        if (tag !== undefined && tag === _histTag) return; // coalesce runs of the same edit
        set({
          past: [...past, { nodes, edges }].slice(-HISTORY_LIMIT),
          future: [],
          _histTag: tag,
        });
      },

      undo: () => {
        const { past, future, nodes, edges, selectedNodeId } = get();
        if (past.length === 0) return;
        const prev = past[past.length - 1];
        set({
          nodes: prev.nodes,
          edges: prev.edges,
          past: past.slice(0, -1),
          future: [{ nodes, edges }, ...future].slice(0, HISTORY_LIMIT),
          _histTag: undefined,
          selectedNodeId:
            selectedNodeId && prev.nodes.some((n) => n.id === selectedNodeId) ? selectedNodeId : null,
        });
      },

      redo: () => {
        const { past, future, nodes, edges, selectedNodeId } = get();
        if (future.length === 0) return;
        const next = future[0];
        set({
          nodes: next.nodes,
          edges: next.edges,
          past: [...past, { nodes, edges }].slice(-HISTORY_LIMIT),
          future: future.slice(1),
          _histTag: undefined,
          selectedNodeId:
            selectedNodeId && next.nodes.some((n) => n.id === selectedNodeId) ? selectedNodeId : null,
        });
      },

      /* ---- React Flow handlers ---- */
      onNodesChange: (changes) =>
        set({ nodes: applyNodeChanges(changes, get().nodes) }),

      onEdgesChange: (changes) =>
        set({ edges: applyEdgeChanges(changes, get().edges) }),

      onConnect: (connection) => {
        get().snapshot();
        const source = get().nodes.find((n) => n.id === connection.source);
        const kind = edgeKindForHandle(source, connection.sourceHandle);
        const newEdge: FlowEdge = {
          ...connection,
          id: nanoid(8),
          type: 'labeled',
          data: { label: '', kind },
        } as FlowEdge;
        set({ edges: addEdge(newEdge, get().edges) });
      },

      setSelectedNode: (id) => set({ selectedNodeId: id }),

      /* ---- nodes ---- */
      addNode: (kind, position) => {
        get().snapshot();
        const id = nanoid(8);
        const { activeSpace, spaces, nodes } = get();
        const space = activeSpace !== 'all' ? activeSpace : spaces[0]?.id ?? 'frontend';
        const pos: XYPosition =
          position ?? { x: 120 + (nodes.length % 6) * 48, y: 120 + (nodes.length % 6) * 48 };
        const node: FlowNode = {
          id,
          type: 'workflow',
          position: pos,
          data: makeNodeData(kind, space),
        };
        set({ nodes: [...nodes, node], selectedNodeId: id });
        return id;
      },

      updateNodeData: (id, patch) => {
        get().snapshot('node:' + id);
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
          ),
        });
      },

      deleteNode: (id) => {
        get().snapshot();
        set({
          nodes: get().nodes.filter((n) => n.id !== id),
          edges: get().edges.filter((e) => e.source !== id && e.target !== id),
          selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId,
        });
      },

      duplicateNode: (id) => {
        const original = get().nodes.find((n) => n.id === id);
        if (!original) return;
        get().snapshot();
        const copy: FlowNode = {
          ...original,
          id: nanoid(8),
          position: { x: original.position.x + 48, y: original.position.y + 48 },
          selected: false,
          data: {
            ...original.data,
            title: `${original.data.title} copy`,
            inputs: original.data.inputs.map((p) => ({ ...p, id: nanoid(6) })),
            outputs: original.data.outputs.map((p) => ({ ...p, id: nanoid(6) })),
          },
        };
        set({ nodes: [...get().nodes, copy], selectedNodeId: copy.id });
      },

      /* ---- edges ---- */
      updateEdgeData: (id, patch) => {
        get().snapshot('edge:' + id);
        set({
          edges: get().edges.map((e) =>
            e.id === id ? { ...e, data: { ...(e.data ?? { label: '', kind: 'default' }), ...patch } } : e,
          ),
        });
      },

      deleteEdge: (id) => {
        get().snapshot();
        set({ edges: get().edges.filter((e) => e.id !== id) });
      },

      /* ---- layout ---- */
      tidyLayout: () => {
        const { nodes, edges } = get();
        if (nodes.length === 0) return;
        get().snapshot();
        const positions = computeLayout(nodes, edges);
        set({
          nodes: nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)),
        });
      },

      /* ---- boards ---- */
      switchBoard: (id) => {
        const { boards, activeBoardId, nodes, edges, spaces } = get();
        if (id === activeBoardId) return;
        const target = boards.find((b) => b.id === id);
        if (!target) return;
        set({
          boards: syncActiveBoard(boards, activeBoardId, nodes, edges, spaces),
          activeBoardId: id,
          nodes: target.nodes,
          edges: target.edges,
          spaces: target.spaces,
          ...BOARD_SWITCH_RESET,
        });
      },

      createBoard: (name) => {
        const trimmed = name.trim() || 'Untitled board';
        const { boards, activeBoardId, nodes, edges, spaces } = get();
        const id = 'board-' + nanoid(6);
        const board: Board = { id, name: trimmed, nodes: [], edges: [], spaces: DEFAULT_SPACES };
        set({
          boards: [...syncActiveBoard(boards, activeBoardId, nodes, edges, spaces), board],
          activeBoardId: id,
          nodes: [],
          edges: [],
          spaces: DEFAULT_SPACES,
          ...BOARD_SWITCH_RESET,
        });
      },

      renameBoard: (id, name) =>
        set({ boards: get().boards.map((b) => (b.id === id ? { ...b, name: name.trim() || b.name } : b)) }),

      duplicateBoard: (id) => {
        const { boards, activeBoardId, nodes, edges, spaces } = get();
        const synced = syncActiveBoard(boards, activeBoardId, nodes, edges, spaces);
        const src = synced.find((b) => b.id === id);
        if (!src) return;
        const newId = 'board-' + nanoid(6);
        const copy: Board = { id: newId, name: src.name + ' copy', nodes: src.nodes, edges: src.edges, spaces: src.spaces };
        set({
          boards: [...synced, copy],
          activeBoardId: newId,
          nodes: copy.nodes,
          edges: copy.edges,
          spaces: copy.spaces,
          ...BOARD_SWITCH_RESET,
        });
      },

      deleteBoard: (id) => {
        const { boards, activeBoardId, nodes, edges, spaces } = get();
        if (boards.length <= 1) return;
        const synced = syncActiveBoard(boards, activeBoardId, nodes, edges, spaces);
        const remaining = synced.filter((b) => b.id !== id);
        if (id === activeBoardId) {
          const next = remaining[0];
          set({
            boards: remaining,
            activeBoardId: next.id,
            nodes: next.nodes,
            edges: next.edges,
            spaces: next.spaces,
            ...BOARD_SWITCH_RESET,
          });
        } else {
          set({ boards: remaining });
        }
      },

      /* ---- spaces ---- */
      addSpace: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const spaces = get().spaces;
        const id = `${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${nanoid(4)}`;
        const color = SPACE_PALETTE[spaces.length % SPACE_PALETTE.length];
        set({ spaces: [...spaces, { id, name: trimmed, color }] });
      },

      renameSpace: (id, name) =>
        set({
          spaces: get().spaces.map((s) => (s.id === id ? { ...s, name } : s)),
        }),

      deleteSpace: (id) => {
        const spaces = get().spaces.filter((s) => s.id !== id);
        const fallback = spaces[0]?.id ?? 'frontend';
        set({
          spaces,
          nodes: get().nodes.map((n) =>
            n.data.space === id ? { ...n, data: { ...n.data, space: fallback } } : n,
          ),
          activeSpace: get().activeSpace === id ? 'all' : get().activeSpace,
        });
      },

      setActiveSpace: (id) => set({ activeSpace: id }),

      /* ---- filters ---- */
      setFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),
      resetFilters: () => set({ filters: { ...EMPTY_FILTERS } }),

      /* ---- ui ---- */
      setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),
      setCommandOpen: (open) => set({ commandOpen: open }),
      setExportOpen: (open) => set({ exportOpen: open }),

      /* ---- persistence ---- */
      exportState: (exportedAt) => ({
        app: 'codeflow-canvas',
        version: 1,
        exportedAt,
        nodes: get().nodes,
        edges: get().edges,
        spaces: get().spaces,
      }),

      importWorkflow: (file) => {
        get().snapshot();
        set({
          nodes: file.nodes ?? [],
          edges: file.edges ?? [],
          spaces: file.spaces?.length ? file.spaces : DEFAULT_SPACES,
          selectedNodeId: null,
          activeSpace: 'all',
        });
      },

      resetWorkflow: () => {
        get().snapshot();
        set({
          nodes: [],
          edges: [],
          spaces: DEFAULT_SPACES,
          selectedNodeId: null,
          activeSpace: 'all',
          filters: { ...EMPTY_FILTERS },
        });
      },

      loadSample: () => {
        get().snapshot();
        set({ nodes: sampleNodes, edges: sampleEdges, spaces: DEFAULT_SPACES, selectedNodeId: null });
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      partialize: (state) => ({
        boards: syncActiveBoard(state.boards, state.activeBoardId, state.nodes, state.edges, state.spaces),
        activeBoardId: state.activeBoardId,
        activeSpace: state.activeSpace,
        ui: state.ui,
        filters: state.filters,
      }),
      // Load the active board into the live state, and migrate legacy single-canvas saves.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        let boards = p.boards as Board[] | undefined;
        let activeBoardId = p.activeBoardId as string | undefined;

        if (!boards || boards.length === 0) {
          const legacyNodes = p.nodes as FlowNode[] | undefined;
          boards = [
            {
              id: DEFAULT_BOARD_ID,
              name: 'My Project',
              nodes: Array.isArray(legacyNodes) ? legacyNodes : sampleNodes,
              edges: Array.isArray(p.edges) ? (p.edges as FlowEdge[]) : sampleEdges,
              spaces:
                Array.isArray(p.spaces) && (p.spaces as Space[]).length
                  ? (p.spaces as Space[])
                  : DEFAULT_SPACES,
            },
          ];
          activeBoardId = DEFAULT_BOARD_ID;
        }

        if (!activeBoardId || !boards.find((b) => b.id === activeBoardId)) {
          activeBoardId = boards[0].id;
        }
        const active = boards.find((b) => b.id === activeBoardId)!;

        return {
          ...current,
          boards,
          activeBoardId,
          nodes: active.nodes,
          edges: active.edges,
          spaces: active.spaces,
          activeSpace: typeof p.activeSpace === 'string' ? (p.activeSpace as string) : 'all',
          ui: { ...current.ui, ...((p.ui as Partial<UiState>) ?? {}) },
          filters: { ...current.filters, ...((p.filters as Partial<Filters>) ?? {}) },
        } as AppState;
      },
    },
  ),
);

/* Convenience selector for the currently-selected node. */
export const useSelectedNode = (): FlowNode | null => {
  const id = useStore((s) => s.selectedNodeId);
  const nodes = useStore((s) => s.nodes);
  return id ? nodes.find((n) => n.id === id) ?? null : null;
};
