import type { FlowEdge, FlowNode, Space, WorkflowFile } from '@/types';
import { KIND_META, STATUS_META } from '@/lib/nodeRegistry';
import { validateWorkflow, summarizeWorkflow } from '@/lib/validation';

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function nodeTitle(n: FlowNode): string {
  return n.data.title?.trim() || `Untitled ${KIND_META[n.data.kind].label}`;
}

function spaceName(id: string, spaces: Space[]): string {
  return spaces.find((s) => s.id === id)?.name ?? 'Unsorted';
}

/** Connections described in plain language: "A --(label)--> B [error]". */
function describeConnections(nodes: FlowNode[], edges: FlowEdge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges.map((e) => {
    const from = byId.get(e.source);
    const to = byId.get(e.target);
    const label = e.data?.label ? ` (${e.data.label})` : '';
    const kind = e.data?.kind && e.data.kind !== 'default' ? ` [${e.data.kind}]` : '';
    return `${from ? nodeTitle(from) : '?'}${label} -> ${to ? nodeTitle(to) : '?'}${kind}`;
  });
}

/** Topological build order (Kahn's algorithm; falls back to input order on cycles). */
export function buildOrder(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  const indegree = new Map<string, number>();
  nodes.forEach((n) => indegree.set(n.id, 0));
  edges.forEach((e) => {
    if (indegree.has(e.target)) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  });

  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const ordered: string[] = [];
  const seen = new Set<string>();

  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
    edges
      .filter((e) => e.source === id)
      .forEach((e) => {
        const next = (indegree.get(e.target) ?? 0) - 1;
        indegree.set(e.target, next);
        if (next <= 0 && !seen.has(e.target)) queue.push(e.target);
      });
  }

  // append any nodes left out by cycles
  nodes.forEach((n) => {
    if (!seen.has(n.id)) ordered.push(n.id);
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  return ordered.map((id) => byId.get(id)!).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

export function toWorkflowFile(
  nodes: FlowNode[],
  edges: FlowEdge[],
  spaces: Space[],
  exportedAt: string,
): WorkflowFile {
  return { app: 'codeflow-canvas', version: 1, exportedAt, nodes, edges, spaces };
}

export function exportJSON(
  nodes: FlowNode[],
  edges: FlowEdge[],
  spaces: Space[],
  exportedAt: string,
): string {
  return JSON.stringify(toWorkflowFile(nodes, edges, spaces, exportedAt), null, 2);
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

export function exportMarkdown(
  nodes: FlowNode[],
  edges: FlowEdge[],
  spaces: Space[],
): string {
  const lines: string[] = ['# CodeFlow Canvas Workflow', ''];

  const grouped = new Map<string, FlowNode[]>();
  nodes.forEach((n) => {
    const key = spaceName(n.data.space, spaces);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(n);
  });

  for (const [space, group] of grouped) {
    lines.push(`## ${space}`, '');
    for (const n of group) {
      const meta = KIND_META[n.data.kind];
      lines.push(`### ${nodeTitle(n)}  \`${meta.label}\``);
      lines.push(`- **Status:** ${STATUS_META[n.data.status].label}`);
      if (n.data.description) lines.push(`- **Description:** ${n.data.description}`);
      if (n.data.tags.length) lines.push(`- **Tags:** ${n.data.tags.join(', ')}`);
      if (n.data.url) lines.push(`- **URL:** ${n.data.url}`);
      if (n.data.command) lines.push(`- **Command:** \`${n.data.command}\``);
      if (n.data.schema) lines.push(`- **Schema:** ${n.data.schema}`);
      if (n.data.prompt) lines.push(`- **Prompt:** ${n.data.prompt}`);
      if (n.data.notes) lines.push(`- **Notes:** ${n.data.notes}`);
      if (n.data.checklist.length) {
        lines.push('- **Checklist:**');
        n.data.checklist.forEach((c) =>
          lines.push(`  - [${c.done ? 'x' : ' '}] ${c.text}`),
        );
      }
      if (n.data.code.trim()) {
        lines.push('', '```', n.data.code, '```');
      }
      lines.push('');
    }
  }

  const connections = describeConnections(nodes, edges);
  lines.push('## Connections', '');
  if (connections.length) connections.forEach((c) => lines.push(`- ${c}`));
  else lines.push('- _No connections yet._');
  lines.push('');

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Claude prompt                                                       */
/* ------------------------------------------------------------------ */

export function exportClaudePrompt(
  nodes: FlowNode[],
  edges: FlowEdge[],
  spaces: Space[],
): string {
  const health = validateWorkflow(nodes, edges);
  const summary = summarizeWorkflow(nodes, edges, health);
  const ordered = buildOrder(nodes, edges);
  const out: string[] = [];

  out.push(
    'You are an expert software engineer. Below is a coding project described as a visual workflow of connected nodes. Read it carefully, then help me build (or fix) the project. Ask clarifying questions only if something is blocking.',
    '',
    '## Project overview',
    `This workflow has ${nodes.length} nodes across ${spaces.length} areas: ${spaces
      .map((s) => s.name)
      .join(', ')}.`,
    '',
    '## Nodes',
  );

  for (const n of nodes) {
    const meta = KIND_META[n.data.kind];
    out.push(
      `- **${nodeTitle(n)}** (${meta.label}, status: ${STATUS_META[n.data.status].label}, area: ${spaceName(
        n.data.space,
        spaces,
      )})`,
    );
    if (n.data.description) out.push(`  - ${n.data.description}`);
    if (n.data.url) out.push(`  - URL: ${n.data.url}`);
    if (n.data.command) out.push(`  - Command: \`${n.data.command}\``);
    if (n.data.schema) out.push(`  - Schema: ${n.data.schema}`);
    if (n.data.prompt) out.push(`  - Prompt: ${n.data.prompt}`);
    if (n.data.envVars) out.push(`  - Env: ${n.data.envVars}`);
    if (n.data.code.trim()) out.push(`  - Code:\n\`\`\`\n${n.data.code}\n\`\`\``);
  }

  out.push('', '## How the nodes connect');
  const connections = describeConnections(nodes, edges);
  if (connections.length) connections.forEach((c) => out.push(`- ${c}`));
  else out.push('- (nothing connected yet)');

  out.push('', '## Suggested build order');
  ordered.forEach((n, i) => out.push(`${i + 1}. ${nodeTitle(n)} — ${KIND_META[n.data.kind].label}`));

  const allIssues = [
    ...summary.globalIssues,
    ...Object.entries(health).flatMap(([id, h]) =>
      h.issues.map((issue) => {
        const n = nodes.find((node) => node.id === id);
        return `${n ? nodeTitle(n) : id}: ${issue}`;
      }),
    ),
  ];
  out.push('', '## Known gaps to resolve');
  if (allIssues.length) allIssues.forEach((i) => out.push(`- ${i}`));
  else out.push('- None detected — the workflow looks complete.');

  out.push(
    '',
    '## Your task',
    'Implement this workflow step by step in the suggested build order. For each node, produce the necessary code, configuration and tests. Call out any assumptions, and flag any node where the description is too vague to implement.',
  );

  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Cursor prompt                                                       */
/* ------------------------------------------------------------------ */

export function exportCursorPrompt(
  nodes: FlowNode[],
  edges: FlowEdge[],
  spaces: Space[],
): string {
  const ordered = buildOrder(nodes, edges);
  const out: string[] = [
    '# Implementation plan for Cursor',
    '',
    'Build the following project. Work top-to-bottom; create files exactly as listed and wire them together as described.',
    '',
    '## Files & components',
  ];

  const files = nodes.filter((n) => n.data.kind === 'file' || n.data.kind === 'folder');
  if (files.length) {
    files.forEach((n) => out.push(`- \`${nodeTitle(n)}\` — ${n.data.description || 'no description'}`));
  } else {
    out.push('- (no explicit files listed)');
  }

  out.push('', '## Build steps');
  ordered.forEach((n, i) => {
    const meta = KIND_META[n.data.kind];
    const detail = n.data.description ? ` — ${n.data.description}` : '';
    out.push(`${i + 1}. [${meta.label}] ${nodeTitle(n)}${detail}`);
    if (n.data.command) out.push(`   run: ${n.data.command}`);
    if (n.data.url) out.push(`   endpoint: ${n.data.url}`);
  });

  out.push(
    '',
    '## Connections',
    ...describeConnections(nodes, edges).map((c) => `- ${c}`),
    '',
    'Keep changes minimal and typed. After each step, make sure the project still builds.',
  );

  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Implementation checklist                                            */
/* ------------------------------------------------------------------ */

export function exportChecklist(
  nodes: FlowNode[],
  edges: FlowEdge[],
  spaces: Space[],
): string {
  const ordered = buildOrder(nodes, edges);
  const out: string[] = ['# Implementation checklist', ''];

  ordered.forEach((n) => {
    const done = n.data.status === 'done';
    out.push(`- [${done ? 'x' : ' '}] **${nodeTitle(n)}** (${KIND_META[n.data.kind].label})`);
    n.data.checklist.forEach((c) =>
      out.push(`  - [${c.done ? 'x' : ' '}] ${c.text}`),
    );
  });

  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Registry of exporters (used by the toolbar export menu)             */
/* ------------------------------------------------------------------ */

export type ExportFormat = 'json' | 'markdown' | 'claude' | 'cursor' | 'checklist';

export interface ExportDescriptor {
  id: ExportFormat;
  label: string;
  description: string;
  extension: string;
  language: string;
}

export const EXPORTERS: ExportDescriptor[] = [
  { id: 'json', label: 'JSON', description: 'Raw workflow data (re-importable).', extension: 'json', language: 'json' },
  { id: 'markdown', label: 'Markdown', description: 'Readable document of the whole workflow.', extension: 'md', language: 'markdown' },
  { id: 'claude', label: 'Claude prompt', description: 'Paste into Claude to build or fix the project.', extension: 'md', language: 'markdown' },
  { id: 'cursor', label: 'Cursor prompt', description: 'File-focused implementation plan for Cursor.', extension: 'md', language: 'markdown' },
  { id: 'checklist', label: 'Checklist', description: 'Ordered implementation checklist.', extension: 'md', language: 'markdown' },
];

export function runExport(
  format: ExportFormat,
  nodes: FlowNode[],
  edges: FlowEdge[],
  spaces: Space[],
  exportedAt: string,
): string {
  switch (format) {
    case 'json':
      return exportJSON(nodes, edges, spaces, exportedAt);
    case 'markdown':
      return exportMarkdown(nodes, edges, spaces);
    case 'claude':
      return exportClaudePrompt(nodes, edges, spaces);
    case 'cursor':
      return exportCursorPrompt(nodes, edges, spaces);
    case 'checklist':
      return exportChecklist(nodes, edges, spaces);
  }
}
