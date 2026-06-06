/**
 * Automation Map — node/status/health registry.
 * Ported from the React app's lib/nodeRegistry.ts. Icons are now icon-name
 * strings resolved through dom.js `icon()` instead of lucide components.
 *
 * @typedef {'idea'|'planned'|'in-progress'|'blocked'|'needs-testing'|'done'} NodeStatus
 * @typedef {'file'|'folder'|'api'|'function'|'database'|'agent'|'terminal'|'github'|'bug'|'feature'|'deployment'|'test'|'documentation'|'env'} NodeKind
 * @typedef {'default'|'success'|'error'} EdgeKind
 * @typedef {'ready'|'connected'|'needs-review'|'missing-input'|'missing-output'|'broken-chain'} HealthLevel
 */

import { nanoid } from './dom.js';

const SINGLE_OUT = [{ label: 'Out', kind: 'default' }];
const BRANCH_OUT = [
  { label: 'Success', kind: 'success' },
  { label: 'Error', kind: 'error' },
];
const SINGLE_IN = [{ label: 'In', kind: 'default' }];

/** Per-kind metadata: label, icon name, semantic color, hint + port templates. */
export const KIND_META = {
  feature: { label: 'Feature', icon: 'feature', color: '#fbbf24', hint: 'A capability or user-facing feature to build.', requiresInput: false, requiresOutput: true, inputs: SINGLE_IN, outputs: SINGLE_OUT },
  file: { label: 'File', icon: 'file', color: '#38bdf8', hint: 'A source file in the project.', requiresInput: false, requiresOutput: false, inputs: SINGLE_IN, outputs: SINGLE_OUT },
  folder: { label: 'Folder', icon: 'folder', color: '#60a5fa', hint: 'A directory grouping related files.', requiresInput: false, requiresOutput: false, inputs: SINGLE_IN, outputs: SINGLE_OUT },
  function: { label: 'Function', icon: 'function', color: '#a78bfa', hint: 'A function, method or module of logic.', requiresInput: true, requiresOutput: true, inputs: SINGLE_IN, outputs: BRANCH_OUT },
  api: { label: 'API Endpoint', icon: 'api', color: '#22d3ee', hint: 'An HTTP endpoint or external API call.', requiresInput: true, requiresOutput: true, inputs: SINGLE_IN, outputs: BRANCH_OUT },
  database: { label: 'Database', icon: 'database', color: '#34d399', hint: 'A database, table or data store.', requiresInput: true, requiresOutput: true, inputs: SINGLE_IN, outputs: SINGLE_OUT },
  agent: { label: 'AI Agent / Prompt', icon: 'agent', color: '#f472b6', hint: 'An AI agent or prompt step.', requiresInput: true, requiresOutput: true, inputs: SINGLE_IN, outputs: BRANCH_OUT },
  terminal: { label: 'Terminal Command', icon: 'terminal', color: '#e2e8f0', hint: 'A shell command or script to run.', requiresInput: true, requiresOutput: true, inputs: SINGLE_IN, outputs: BRANCH_OUT },
  github: { label: 'GitHub Task', icon: 'github', color: '#c084fc', hint: 'A GitHub issue, PR or repo task.', requiresInput: false, requiresOutput: true, inputs: SINGLE_IN, outputs: SINGLE_OUT },
  bug: { label: 'Bug', icon: 'bug', color: '#f87171', hint: 'A defect to investigate and fix.', requiresInput: true, requiresOutput: true, inputs: SINGLE_IN, outputs: SINGLE_OUT },
  test: { label: 'Test', icon: 'test', color: '#4ade80', hint: 'A test suite or verification step.', requiresInput: true, requiresOutput: true, inputs: SINGLE_IN, outputs: BRANCH_OUT },
  deployment: { label: 'Deployment', icon: 'deployment', color: '#fb923c', hint: 'A build, release or deployment step.', requiresInput: true, requiresOutput: false, inputs: SINGLE_IN, outputs: BRANCH_OUT },
  documentation: { label: 'Documentation', icon: 'documentation', color: '#94a3b8', hint: 'Notes, specs or docs.', requiresInput: false, requiresOutput: false, inputs: SINGLE_IN, outputs: SINGLE_OUT },
  env: { label: 'Environment Variable', icon: 'env', color: '#fcd34d', hint: 'A secret, config value or env variable.', requiresInput: false, requiresOutput: true, inputs: SINGLE_IN, outputs: SINGLE_OUT },
};

/** Display order for palettes / pickers. */
export const KIND_ORDER = [
  'feature', 'file', 'folder', 'function', 'api', 'database', 'agent',
  'terminal', 'github', 'bug', 'test', 'deployment', 'documentation', 'env',
];

export const STATUS_META = {
  idea: { label: 'Idea', color: '#8b93a7', icon: 'idea' },
  planned: { label: 'Planned', color: '#38bdf8', icon: 'planned' },
  'in-progress': { label: 'In Progress', color: '#f59e0b', icon: 'in-progress' },
  blocked: { label: 'Blocked', color: '#ef4444', icon: 'blocked' },
  'needs-testing': { label: 'Needs Testing', color: '#a855f7', icon: 'needs-testing' },
  done: { label: 'Done', color: '#22c55e', icon: 'done' },
};

export const STATUS_ORDER = ['idea', 'planned', 'in-progress', 'blocked', 'needs-testing', 'done'];

export const HEALTH_META = {
  ready: { label: 'Ready to build', color: '#22c55e' },
  connected: { label: 'Connected', color: '#38bdf8' },
  'needs-review': { label: 'Needs review', color: '#f59e0b' },
  'missing-input': { label: 'Missing input', color: '#fb923c' },
  'missing-output': { label: 'Missing output', color: '#fb923c' },
  'broken-chain': { label: 'Broken chain', color: '#ef4444' },
};

export const HEALTH_ORDER = [
  'ready', 'connected', 'needs-review', 'missing-input', 'missing-output', 'broken-chain',
];

function clonePorts(templates) {
  return templates.map((t) => ({ id: nanoid(6), label: t.label, kind: t.kind }));
}

/** Build a fresh, fully-populated data object for a new node of `kind`. */
export function makeNodeData(kind, space) {
  const meta = KIND_META[kind] || KIND_META.feature;
  return {
    title: `New ${meta.label}`,
    description: '',
    kind: KIND_META[kind] ? kind : 'feature',
    status: 'idea',
    tags: [],
    notes: '',
    approved: false,      // human-in-the-loop "Approve" gate (persisted)
    code: '',
    prompt: '',
    command: '',
    url: '',
    schema: '',
    hasCredentials: false,
    envVars: '',
    checklist: [],
    links: [],
    // Identity / metadata
    createdAt: new Date().toISOString(),
    version: 1,
    settings: {},
    // Agent execution (Phase 2): model selection, layered prompts, sampling.
    model: '',
    endpointId: '',
    systemPrompt: '',
    contextPrompt: '',
    taskPrompt: '',
    temperature: 0.7,
    contextWindow: 0,
    outputMode: 'text',   // 'text' | 'files' (prompt-to-code, Phase 5)
    language: 'python',   // function node runtime: python | javascript | typescript
    path: '',             // file node target path (relative to the workspace)
    inputs: clonePorts(meta.inputs),
    outputs: clonePorts(meta.outputs),
    space,
  };
}

const _STRING_FIELDS = [
  'title', 'description', 'notes', 'code', 'prompt', 'command', 'url', 'schema', 'envVars',
  'model', 'endpointId', 'systemPrompt', 'contextPrompt', 'taskPrompt', 'language', 'path',
];

/**
 * Coerce a possibly-partial node `data` (from a server load, an import, or an
 * AI-generated node) into the full, render-safe shape. Existing values win;
 * missing/invalid fields fall back to the kind defaults. Ports are preserved
 * when present (edges reference their ids) and only regenerated when absent.
 */
export function normalizeNodeData(data) {
  const d = data || {};
  const kind = KIND_META[d.kind] ? d.kind : 'feature';
  const base = makeNodeData(kind, d.space || 'frontend');
  const merged = { ...base, ...d, kind };
  for (const k of _STRING_FIELDS) {
    if (typeof merged[k] !== 'string') merged[k] = base[k] ?? '';
  }
  if (!Array.isArray(merged.tags)) merged.tags = [];
  if (!Array.isArray(merged.checklist)) merged.checklist = [];
  if (!Array.isArray(merged.links)) merged.links = [];
  if (!Array.isArray(merged.inputs) || merged.inputs.length === 0) merged.inputs = base.inputs;
  if (!Array.isArray(merged.outputs) || merged.outputs.length === 0) merged.outputs = base.outputs;
  if (typeof merged.hasCredentials !== 'boolean') merged.hasCredentials = false;
  if (typeof merged.approved !== 'boolean') merged.approved = false;
  if (typeof merged.temperature !== 'number' || Number.isNaN(merged.temperature)) merged.temperature = 0.7;
  if (typeof merged.contextWindow !== 'number' || Number.isNaN(merged.contextWindow)) merged.contextWindow = 0;
  merged.outputMode = merged.outputMode === 'files' ? 'files' : 'text';
  if (!['python', 'javascript', 'typescript'].includes(merged.language)) merged.language = 'python';
  if (typeof merged.createdAt !== 'string') merged.createdAt = base.createdAt;
  if (typeof merged.version !== 'number') merged.version = 1;
  if (typeof merged.settings !== 'object' || merged.settings === null || Array.isArray(merged.settings)) merged.settings = {};
  if (!merged.space) merged.space = base.space;
  return merged;
}

/** Coerce a whole node (id/type/position/data) into a render-safe shape. */
export function normalizeNode(node) {
  const n = node || {};
  return {
    ...n,
    id: n.id,
    type: n.type || 'workflow',
    position: (n.position && typeof n.position.x === 'number' && typeof n.position.y === 'number')
      ? n.position : { x: 120, y: 120 },
    data: normalizeNodeData(n.data),
  };
}
