import {
  FileCode,
  FolderTree,
  Globe,
  Braces,
  Database,
  Bot,
  SquareTerminal,
  Github,
  Bug,
  Sparkles,
  Rocket,
  FlaskConical,
  BookOpen,
  KeyRound,
  Lightbulb,
  ClipboardList,
  LoaderCircle,
  Ban,
  TestTube,
  CheckCircle2,
  type LucideIcon,
} from 'lucide-react';
import { nanoid } from 'nanoid';
import type {
  EdgeKind,
  HealthLevel,
  NodeData,
  NodeKind,
  NodeStatus,
  Port,
} from '@/types';

/* ------------------------------------------------------------------ */
/* Node kinds                                                          */
/* ------------------------------------------------------------------ */

interface PortTemplate {
  label: string;
  kind: EdgeKind;
}

export interface KindMeta {
  label: string;
  icon: LucideIcon;
  color: string;
  hint: string;
  /** Validation: should this node receive an incoming connection? */
  requiresInput: boolean;
  /** Validation: should this node feed something downstream? */
  requiresOutput: boolean;
  inputs: PortTemplate[];
  outputs: PortTemplate[];
}

const SINGLE_OUT: PortTemplate[] = [{ label: 'Out', kind: 'default' }];
const BRANCH_OUT: PortTemplate[] = [
  { label: 'Success', kind: 'success' },
  { label: 'Error', kind: 'error' },
];
const SINGLE_IN: PortTemplate[] = [{ label: 'In', kind: 'default' }];

export const KIND_META: Record<NodeKind, KindMeta> = {
  feature: {
    label: 'Feature',
    icon: Sparkles,
    color: '#fbbf24',
    hint: 'A capability or user-facing feature to build.',
    requiresInput: false,
    requiresOutput: true,
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  file: {
    label: 'File',
    icon: FileCode,
    color: '#38bdf8',
    hint: 'A source file in the project.',
    requiresInput: false,
    requiresOutput: false,
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  folder: {
    label: 'Folder',
    icon: FolderTree,
    color: '#60a5fa',
    hint: 'A directory grouping related files.',
    requiresInput: false,
    requiresOutput: false,
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  function: {
    label: 'Function',
    icon: Braces,
    color: '#a78bfa',
    hint: 'A function, method or module of logic.',
    requiresInput: true,
    requiresOutput: true,
    inputs: SINGLE_IN,
    outputs: BRANCH_OUT,
  },
  api: {
    label: 'API Endpoint',
    icon: Globe,
    color: '#22d3ee',
    hint: 'An HTTP endpoint or external API call.',
    requiresInput: true,
    requiresOutput: true,
    inputs: SINGLE_IN,
    outputs: BRANCH_OUT,
  },
  database: {
    label: 'Database',
    icon: Database,
    color: '#34d399',
    hint: 'A database, table or data store.',
    requiresInput: true,
    requiresOutput: true,
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  agent: {
    label: 'AI Agent / Prompt',
    icon: Bot,
    color: '#f472b6',
    hint: 'An AI agent or prompt step.',
    requiresInput: true,
    requiresOutput: true,
    inputs: SINGLE_IN,
    outputs: BRANCH_OUT,
  },
  terminal: {
    label: 'Terminal Command',
    icon: SquareTerminal,
    color: '#e2e8f0',
    hint: 'A shell command or script to run.',
    requiresInput: true,
    requiresOutput: true,
    inputs: SINGLE_IN,
    outputs: BRANCH_OUT,
  },
  github: {
    label: 'GitHub Task',
    icon: Github,
    color: '#c084fc',
    hint: 'A GitHub issue, PR or repo task.',
    requiresInput: false,
    requiresOutput: true,
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  bug: {
    label: 'Bug',
    icon: Bug,
    color: '#f87171',
    hint: 'A defect to investigate and fix.',
    requiresInput: true,
    requiresOutput: true,
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  test: {
    label: 'Test',
    icon: FlaskConical,
    color: '#4ade80',
    hint: 'A test suite or verification step.',
    requiresInput: true,
    requiresOutput: true,
    inputs: SINGLE_IN,
    outputs: BRANCH_OUT,
  },
  deployment: {
    label: 'Deployment',
    icon: Rocket,
    color: '#fb923c',
    hint: 'A build, release or deployment step.',
    requiresInput: true,
    requiresOutput: false,
    inputs: SINGLE_IN,
    outputs: BRANCH_OUT,
  },
  documentation: {
    label: 'Documentation',
    icon: BookOpen,
    color: '#94a3b8',
    hint: 'Notes, specs or docs.',
    requiresInput: false,
    requiresOutput: false,
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  env: {
    label: 'Environment Variable',
    icon: KeyRound,
    color: '#fcd34d',
    hint: 'A secret, config value or env variable.',
    requiresInput: false,
    requiresOutput: true,
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
};

/** Display order for palettes / pickers. */
export const KIND_ORDER: NodeKind[] = [
  'feature',
  'file',
  'folder',
  'function',
  'api',
  'database',
  'agent',
  'terminal',
  'github',
  'bug',
  'test',
  'deployment',
  'documentation',
  'env',
];

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

export const STATUS_META: Record<
  NodeStatus,
  { label: string; color: string; icon: LucideIcon }
> = {
  idea: { label: 'Idea', color: '#8b93a7', icon: Lightbulb },
  planned: { label: 'Planned', color: '#38bdf8', icon: ClipboardList },
  'in-progress': { label: 'In Progress', color: '#f59e0b', icon: LoaderCircle },
  blocked: { label: 'Blocked', color: '#ef4444', icon: Ban },
  'needs-testing': { label: 'Needs Testing', color: '#a855f7', icon: TestTube },
  done: { label: 'Done', color: '#22c55e', icon: CheckCircle2 },
};

export const STATUS_ORDER: NodeStatus[] = [
  'idea',
  'planned',
  'in-progress',
  'blocked',
  'needs-testing',
  'done',
];

/* ------------------------------------------------------------------ */
/* Health levels                                                       */
/* ------------------------------------------------------------------ */

export const HEALTH_META: Record<HealthLevel, { label: string; color: string }> = {
  ready: { label: 'Ready to build', color: '#22c55e' },
  connected: { label: 'Connected', color: '#38bdf8' },
  'needs-review': { label: 'Needs review', color: '#f59e0b' },
  'missing-input': { label: 'Missing input', color: '#fb923c' },
  'missing-output': { label: 'Missing output', color: '#fb923c' },
  'broken-chain': { label: 'Broken chain', color: '#ef4444' },
};

export const HEALTH_ORDER: HealthLevel[] = [
  'ready',
  'connected',
  'needs-review',
  'missing-input',
  'missing-output',
  'broken-chain',
];

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

function clonePorts(templates: PortTemplate[]): Port[] {
  return templates.map((t) => ({ id: nanoid(6), label: t.label, kind: t.kind }));
}

/** Build a fresh, fully-populated data object for a new node of `kind`. */
export function makeNodeData(kind: NodeKind, space: string): NodeData {
  const meta = KIND_META[kind];
  return {
    title: `New ${meta.label}`,
    description: '',
    kind,
    status: 'idea',
    tags: [],
    notes: '',
    code: '',
    prompt: '',
    command: '',
    url: '',
    schema: '',
    hasCredentials: false,
    envVars: '',
    checklist: [],
    links: [],
    inputs: clonePorts(meta.inputs),
    outputs: clonePorts(meta.outputs),
    space,
  };
}
