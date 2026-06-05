import type { Node, Edge } from '@xyflow/react';

/* ------------------------------------------------------------------ */
/* Domain primitives                                                   */
/* ------------------------------------------------------------------ */

export type NodeStatus =
  | 'idea'
  | 'planned'
  | 'in-progress'
  | 'blocked'
  | 'needs-testing'
  | 'done';

export type NodeKind =
  | 'file'
  | 'folder'
  | 'api'
  | 'function'
  | 'database'
  | 'agent'
  | 'terminal'
  | 'github'
  | 'bug'
  | 'feature'
  | 'deployment'
  | 'test'
  | 'documentation'
  | 'env';

/** Direction/semantics of a connection. */
export type EdgeKind = 'default' | 'success' | 'error';

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface LinkItem {
  id: string;
  label: string;
  url: string;
}

/** A connection point on a node (drives React Flow handles). */
export interface Port {
  id: string;
  label: string;
  kind: EdgeKind;
}

/**
 * Domain data carried by every canvas node.
 * NOTE: declared as a `type` intersected with `Record<string, unknown>` so it
 * satisfies the React Flow v12 `Node<T>` generic constraint.
 */
export type NodeData = {
  title: string;
  description: string;
  kind: NodeKind;
  status: NodeStatus;
  tags: string[];
  notes: string;
  code: string;
  /** AI agent / prompt node */
  prompt: string;
  /** Terminal command node */
  command: string;
  /** API endpoint node */
  url: string;
  /** Database node */
  schema: string;
  hasCredentials: boolean;
  /** Environment variable node */
  envVars: string;
  checklist: ChecklistItem[];
  links: LinkItem[];
  inputs: Port[];
  outputs: Port[];
  /** Space / folder this node belongs to. */
  space: string;
} & Record<string, unknown>;

export type FlowNode = Node<NodeData>;

export type EdgeData = {
  label: string;
  kind: EdgeKind;
} & Record<string, unknown>;

export type FlowEdge = Edge<EdgeData>;

/* ------------------------------------------------------------------ */
/* Spaces & filters                                                    */
/* ------------------------------------------------------------------ */

export interface Space {
  id: string;
  name: string;
  color: string;
}

export interface Filters {
  search: string;
  statuses: NodeStatus[];
  kinds: NodeKind[];
  tags: string[];
  brokenOnly: boolean;
  unfinishedOnly: boolean;
}

/* ------------------------------------------------------------------ */
/* Workflow validation                                                 */
/* ------------------------------------------------------------------ */

export type HealthLevel =
  | 'ready'
  | 'connected'
  | 'needs-review'
  | 'missing-input'
  | 'missing-output'
  | 'broken-chain';

export interface NodeHealth {
  level: HealthLevel;
  issues: string[];
}

export interface WorkflowSummary {
  total: number;
  counts: Record<HealthLevel, number>;
  globalIssues: string[];
  readyToBuild: boolean;
}

/* ------------------------------------------------------------------ */
/* Persistence / import-export                                         */
/* ------------------------------------------------------------------ */

export interface WorkflowFile {
  app: 'codeflow-canvas';
  version: number;
  exportedAt: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  spaces: Space[];
}

/** A self-contained canvas/project. The app holds many; one is active. */
export interface Board {
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  spaces: Space[];
}
