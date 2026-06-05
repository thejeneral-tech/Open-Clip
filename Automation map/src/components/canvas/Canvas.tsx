import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react';
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { EdgeKind, FlowEdge, FlowNode, NodeData, NodeKind } from '@/types';
import { useStore } from '@/store/useStore';
import { KIND_META } from '@/lib/nodeRegistry';
import { validateWorkflow } from '@/lib/validation';
import { nodeMatchesFilters } from '@/lib/filtering';
import { WorkflowNode } from '@/components/canvas/WorkflowNode';
import { LabeledEdge } from '@/components/canvas/LabeledEdge';
import { CanvasContextMenu, type CanvasMenu } from '@/components/canvas/CanvasContextMenu';

/* Stable identity at module scope (required by React Flow). */
const nodeTypes: NodeTypes = { workflow: WorkflowNode };
const edgeTypes: EdgeTypes = { labeled: LabeledEdge };

const DRAG_MIME = 'application/cfc-kind';

const EDGE_COLOR: Record<EdgeKind, string> = {
  default: '#22d3ee',
  success: '#22c55e',
  error: '#ef4444',
};

function isNodeKind(value: string): value is NodeKind {
  return value in KIND_META;
}

export function Canvas() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const filters = useStore((s) => s.filters);
  const activeSpace = useStore((s) => s.activeSpace);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const showMiniMap = useStore((s) => s.ui.showMiniMap);
  const snapToGrid = useStore((s) => s.ui.snapToGrid);

  const onNodesChange = useStore((s) => s.onNodesChange);
  const onEdgesChange = useStore((s) => s.onEdgesChange);
  const onConnect = useStore((s) => s.onConnect);
  const setSelectedNode = useStore((s) => s.setSelectedNode);
  const addNode = useStore((s) => s.addNode);
  const deleteNode = useStore((s) => s.deleteNode);
  const snapshot = useStore((s) => s.snapshot);

  const { screenToFlowPosition } = useReactFlow();

  const [menu, setMenu] = useState<CanvasMenu | null>(null);

  /* Validate the whole graph once; reused for filtering + injected per-node. */
  const health = useMemo(() => validateWorkflow(nodes, edges), [nodes, edges]);

  const displayNodes = useMemo<FlowNode[]>(
    () =>
      nodes.map((n) => ({
        ...n,
        selected: n.id === selectedNodeId,
        hidden: !nodeMatchesFilters(n, filters, activeSpace, health[n.id]),
        data: { ...n.data, health: health[n.id] },
      })),
    [nodes, selectedNodeId, filters, activeSpace, health],
  );

  const displayEdges = useMemo(() => {
    const hiddenIds = new Set(displayNodes.filter((n) => n.hidden).map((n) => n.id));
    return edges.map((e) => {
      const kind: EdgeKind = e.data?.kind ?? 'default';
      const color = EDGE_COLOR[kind];
      return {
        ...e,
        className: `cfc-edge-${kind}`,
        animated: true,
        hidden: hiddenIds.has(e.source) || hiddenIds.has(e.target),
        style: { stroke: color },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      };
    });
  }, [edges, displayNodes]);

  const onNodeClick = useCallback(
    (_: unknown, node: FlowNode) => setSelectedNode(node.id),
    [setSelectedNode],
  );

  const onPaneClick = useCallback(() => setSelectedNode(null), [setSelectedNode]);

  /* Snapshot positions once at the start of a drag gesture (for undo). */
  const onNodeDragStart = useCallback(() => snapshot(), [snapshot]);

  /* Delete the selected node with the keyboard (atomic + undoable). */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (selectedNodeId) {
        e.preventDefault();
        deleteNode(selectedNodeId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedNodeId, deleteNode]);

  const onNodesDelete = useCallback(
    (deleted: FlowNode[]) => {
      if (selectedNodeId && deleted.some((n) => n.id === selectedNodeId)) {
        setSelectedNode(null);
      }
    },
    [selectedNodeId, setSelectedNode],
  );

  const onPaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      event.preventDefault();
      setMenu({
        type: 'pane',
        x: event.clientX,
        y: event.clientY,
        flow: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      });
    },
    [screenToFlowPosition],
  );

  const onNodeContextMenu = useCallback((event: ReactMouseEvent, node: FlowNode) => {
    event.preventDefault();
    setMenu({ type: 'node', x: event.clientX, y: event.clientY, id: node.id });
  }, []);

  const onEdgeContextMenu = useCallback((event: ReactMouseEvent, edge: FlowEdge) => {
    event.preventDefault();
    setMenu({ type: 'edge', x: event.clientX, y: event.clientY, id: edge.id });
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData(DRAG_MIME);
      if (!raw || !isNodeKind(raw)) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNode(raw, position);
    },
    [screenToFlowPosition, addNode],
  );

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodesDelete={onNodesDelete}
        onNodeDragStart={onNodeDragStart}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onDragOver={onDragOver}
        onDrop={onDrop}
        colorMode="dark"
        snapToGrid={snapToGrid}
        snapGrid={[16, 16]}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        selectionOnDrag
        panOnScroll
        defaultEdgeOptions={{ type: 'labeled', markerEnd: { type: MarkerType.ArrowClosed } }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1b2233" />
        <Controls />
        {showMiniMap && (
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => KIND_META[(n.data as NodeData).kind].color}
            nodeStrokeWidth={0}
            maskColor="rgba(10,11,16,0.6)"
          />
        )}
      </ReactFlow>
      {menu && <CanvasContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
