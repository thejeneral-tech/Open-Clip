import { useMemo, useState } from 'react';
import {
  X,
  Copy,
  Trash2,
  Plus,
  ExternalLink,
  ArrowRight,
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { nanoid } from 'nanoid';
import type { FlowNode, NodeKind, NodeStatus } from '@/types';
import { useStore, useSelectedNode } from '@/store/useStore';
import {
  KIND_META,
  KIND_ORDER,
  STATUS_META,
  STATUS_ORDER,
  HEALTH_META,
} from '@/lib/nodeRegistry';
import { validateNode } from '@/lib/validation';
import { cn } from '@/lib/cn';

const GOOD_COLOR = '#22c55e';

interface ConnectedRef {
  id: string;
  title: string;
}

function nodeTitle(node: FlowNode): string {
  return node.data.title.trim() || `Untitled ${KIND_META[node.data.kind].label}`;
}

/* A labeled section separated from the previous one by a subtle divider. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line px-4 py-4">
      <h3 className="label mb-2.5">{title}</h3>
      {children}
    </section>
  );
}

export function Inspector() {
  const node = useSelectedNode();

  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const spaces = useStore((s) => s.spaces);
  const updateNodeData = useStore((s) => s.updateNodeData);
  const deleteNode = useStore((s) => s.deleteNode);
  const duplicateNode = useStore((s) => s.duplicateNode);
  const setSelectedNode = useStore((s) => s.setSelectedNode);

  const [tagDraft, setTagDraft] = useState('');
  const [checkDraft, setCheckDraft] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [linkUrl, setLinkUrl] = useState('');

  const nodeId = node?.id ?? null;

  const connections = useMemo(() => {
    if (!nodeId) return { incoming: [] as ConnectedRef[], outgoing: [] as ConnectedRef[] };
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const toRef = (id: string): ConnectedRef | null => {
      const other = byId.get(id);
      return other ? { id: other.id, title: nodeTitle(other) } : null;
    };
    const incoming: ConnectedRef[] = [];
    const outgoing: ConnectedRef[] = [];
    for (const e of edges) {
      if (e.target === nodeId) {
        const ref = toRef(e.source);
        if (ref) incoming.push(ref);
      }
      if (e.source === nodeId) {
        const ref = toRef(e.target);
        if (ref) outgoing.push(ref);
      }
    }
    return { incoming, outgoing };
  }, [nodeId, nodes, edges]);

  const health = useMemo(
    () => (node ? validateNode(node, nodes, edges) : null),
    [node, nodes, edges],
  );

  if (!node || !health) return null;

  const data = node.data;
  const kindMeta = KIND_META[data.kind];
  const statusMeta = STATUS_META[data.status];
  const KindIcon = kindMeta.icon;
  const StatusIcon = statusMeta.icon;
  const healthMeta = HEALTH_META[health.level];

  const doneCount = data.checklist.filter((c) => c.done).length;

  const addTag = () => {
    const value = tagDraft.trim();
    if (!value || data.tags.includes(value)) {
      setTagDraft('');
      return;
    }
    updateNodeData(node.id, { tags: [...data.tags, value] });
    setTagDraft('');
  };

  const removeTag = (tag: string) => {
    updateNodeData(node.id, { tags: data.tags.filter((t) => t !== tag) });
  };

  const addChecklistItem = () => {
    const text = checkDraft.trim();
    if (!text) return;
    updateNodeData(node.id, {
      checklist: [...data.checklist, { id: nanoid(6), text, done: false }],
    });
    setCheckDraft('');
  };

  const toggleChecklist = (id: string) => {
    updateNodeData(node.id, {
      checklist: data.checklist.map((c) =>
        c.id === id ? { ...c, done: !c.done } : c,
      ),
    });
  };

  const editChecklist = (id: string, text: string) => {
    updateNodeData(node.id, {
      checklist: data.checklist.map((c) => (c.id === id ? { ...c, text } : c)),
    });
  };

  const removeChecklist = (id: string) => {
    updateNodeData(node.id, {
      checklist: data.checklist.filter((c) => c.id !== id),
    });
  };

  const addLink = () => {
    const label = linkLabel.trim();
    const url = linkUrl.trim();
    if (!label && !url) return;
    updateNodeData(node.id, {
      links: [...data.links, { id: nanoid(6), label: label || url, url }],
    });
    setLinkLabel('');
    setLinkUrl('');
  };

  const removeLink = (id: string) => {
    updateNodeData(node.id, { links: data.links.filter((l) => l.id !== id) });
  };

  const noConnections =
    connections.incoming.length === 0 && connections.outgoing.length === 0;

  return (
    <aside className="absolute top-0 right-0 z-20 flex h-full w-[360px] flex-col border-l border-line bg-surface text-ink animate-slide-in">
      {/* Header */}
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        <span
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: kindMeta.color + '22', color: kindMeta.color }}
        >
          <KindIcon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{kindMeta.label}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs" style={{ color: statusMeta.color }}>
            <StatusIcon size={13} />
            <span className="font-medium">{statusMeta.label}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className="icon-btn"
            title="Duplicate node"
            onClick={() => duplicateNode(node.id)}
          >
            <Copy size={16} />
          </button>
          <button
            type="button"
            className="icon-btn hover:text-red-400"
            title="Delete node"
            onClick={() => deleteNode(node.id)}
          >
            <Trash2 size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Close"
            onClick={() => setSelectedNode(null)}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Title */}
        <section className="px-4 pt-4 pb-1">
          <label className="label mb-2 block">Title</label>
          <input
            className="input"
            value={data.title}
            placeholder="Node title"
            onChange={(e) => updateNodeData(node.id, { title: e.target.value })}
          />
        </section>

        {/* Type + Space */}
        <Section title="Type & Space">
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs text-muted">Type</label>
              <select
                className="input"
                value={data.kind}
                onChange={(e) =>
                  updateNodeData(node.id, { kind: e.target.value as NodeKind })
                }
              >
                {KIND_ORDER.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_META[kind].label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-muted">Space</label>
              <select
                className="input"
                value={data.space}
                onChange={(e) => updateNodeData(node.id, { space: e.target.value })}
              >
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Section>

        {/* Status pills */}
        <Section title="Status">
          <div className="flex flex-wrap gap-1.5">
            {STATUS_ORDER.map((status) => {
              const meta = STATUS_META[status];
              const Icon = meta.icon;
              const active = data.status === status;
              return (
                <button
                  key={status}
                  type="button"
                  className={cn(
                    'chip border transition-colors',
                    active ? 'border-transparent' : 'border-line text-muted hover:text-ink',
                  )}
                  style={
                    active
                      ? { backgroundColor: meta.color + '22', color: meta.color, borderColor: meta.color + '66' }
                      : undefined
                  }
                  onClick={() => updateNodeData(node.id, { status: status as NodeStatus })}
                >
                  <Icon size={12} />
                  {meta.label}
                </button>
              );
            })}
          </div>
        </Section>

        {/* Description */}
        <Section title="Description">
          <textarea
            className="input min-h-[72px] resize-y"
            value={data.description}
            placeholder="What is this node for?"
            onChange={(e) => updateNodeData(node.id, { description: e.target.value })}
          />
        </Section>

        {/* Tags */}
        <Section title="Tags">
          {data.tags.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {data.tags.map((tag) => (
                <span key={tag} className="chip bg-surface2 text-ink">
                  {tag}
                  <button
                    type="button"
                    className="ml-0.5 text-muted hover:text-ink"
                    title={`Remove ${tag}`}
                    onClick={() => removeTag(tag)}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            className="input"
            value={tagDraft}
            placeholder="Add a tag, press Enter"
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
              }
            }}
          />
        </Section>

        {/* Kind-specific fields */}
        {data.kind === 'api' && (
          <Section title="Endpoint">
            <input
              className="input font-mono text-xs"
              value={data.url}
              placeholder="https://api.example.com/v1/resource"
              onChange={(e) => updateNodeData(node.id, { url: e.target.value })}
            />
          </Section>
        )}

        {data.kind === 'database' && (
          <Section title="Data store">
            <textarea
              className="input min-h-[72px] resize-y font-mono text-xs"
              value={data.schema}
              placeholder="users(id, email, created_at)…"
              onChange={(e) => updateNodeData(node.id, { schema: e.target.value })}
            />
            <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-line bg-surface2 accent-brand"
                checked={data.hasCredentials}
                onChange={(e) =>
                  updateNodeData(node.id, { hasCredentials: e.target.checked })
                }
              />
              Has credentials
            </label>
          </Section>
        )}

        {data.kind === 'agent' && (
          <Section title="Prompt">
            <textarea
              className="input min-h-[96px] resize-y font-mono text-xs"
              value={data.prompt}
              placeholder="You are a helpful assistant that…"
              onChange={(e) => updateNodeData(node.id, { prompt: e.target.value })}
            />
          </Section>
        )}

        {data.kind === 'terminal' && (
          <Section title="Command">
            <input
              className="input font-mono text-xs"
              value={data.command}
              placeholder="npm run build"
              onChange={(e) => updateNodeData(node.id, { command: e.target.value })}
            />
          </Section>
        )}

        {data.kind === 'env' && (
          <Section title="Environment variables">
            <textarea
              className="input min-h-[72px] resize-y font-mono text-xs"
              value={data.envVars}
              placeholder={'API_KEY=…\nDATABASE_URL=…'}
              onChange={(e) => updateNodeData(node.id, { envVars: e.target.value })}
            />
          </Section>
        )}

        {/* Code */}
        <Section title="Code">
          <textarea
            className="input min-h-[112px] resize-y font-mono text-xs"
            value={data.code}
            placeholder="// snippet, pseudocode or signature"
            spellCheck={false}
            onChange={(e) => updateNodeData(node.id, { code: e.target.value })}
          />
        </Section>

        {/* Notes */}
        <Section title="Notes">
          <textarea
            className="input min-h-[72px] resize-y"
            value={data.notes}
            placeholder="Anything else worth remembering…"
            onChange={(e) => updateNodeData(node.id, { notes: e.target.value })}
          />
        </Section>

        {/* Checklist */}
        <Section title="Checklist">
          {data.checklist.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {data.checklist.map((item) => (
                <div key={item.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 rounded border-line bg-surface2 accent-brand"
                    checked={item.done}
                    onChange={() => toggleChecklist(item.id)}
                  />
                  <input
                    className={cn(
                      'min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-sm text-ink outline-none transition-colors hover:bg-white/5 focus:bg-surface2',
                      item.done && 'text-muted line-through',
                    )}
                    value={item.text}
                    onChange={(e) => editChecklist(item.id, e.target.value)}
                  />
                  <button
                    type="button"
                    className="shrink-0 text-muted hover:text-ink"
                    title="Remove item"
                    onClick={() => removeChecklist(item.id)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              className="input"
              value={checkDraft}
              placeholder="Add item"
              onChange={(e) => setCheckDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addChecklistItem();
                }
              }}
            />
            <button
              type="button"
              className="icon-btn shrink-0 border border-line"
              title="Add item"
              onClick={addChecklistItem}
            >
              <Plus size={16} />
            </button>
          </div>
          {data.checklist.length > 0 && (
            <p className="mt-2 text-[11px] text-muted">
              {doneCount}/{data.checklist.length} done
            </p>
          )}
        </Section>

        {/* Links */}
        <Section title="Links">
          {data.links.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {data.links.map((link) => (
                <div
                  key={link.id}
                  className="flex items-center gap-2 rounded-lg border border-line bg-surface2 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink">
                      {link.label || link.url || 'Untitled link'}
                    </div>
                    {link.url && (
                      <div className="truncate text-[11px] text-muted">{link.url}</div>
                    )}
                  </div>
                  {link.url && (
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="icon-btn h-7 w-7 shrink-0"
                      title="Open link"
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                  <button
                    type="button"
                    className="shrink-0 text-muted hover:text-ink"
                    title="Remove link"
                    onClick={() => removeLink(link.id)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <input
              className="input"
              value={linkLabel}
              placeholder="Label (e.g. Figma spec)"
              onChange={(e) => setLinkLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addLink();
                }
              }}
            />
            <div className="flex items-center gap-2">
              <input
                className="input font-mono text-xs"
                value={linkUrl}
                placeholder="https://…"
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addLink();
                  }
                }}
              />
              <button
                type="button"
                className="icon-btn shrink-0 border border-line"
                title="Add link"
                onClick={addLink}
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
        </Section>

        {/* Connected nodes */}
        <Section title="Connected nodes">
          {noConnections ? (
            <p className="text-sm text-muted">Not connected yet</p>
          ) : (
            <div className="space-y-1.5">
              {connections.incoming.map((ref, i) => (
                <button
                  key={`in-${ref.id}-${i}`}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-left text-sm text-ink transition-colors hover:border-brand/50 hover:bg-white/5"
                  onClick={() => setSelectedNode(ref.id)}
                >
                  <ArrowLeft size={14} className="shrink-0 text-muted" />
                  <span className="truncate">{ref.title}</span>
                </button>
              ))}
              {connections.outgoing.map((ref, i) => (
                <button
                  key={`out-${ref.id}-${i}`}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-left text-sm text-ink transition-colors hover:border-brand/50 hover:bg-white/5"
                  onClick={() => setSelectedNode(ref.id)}
                >
                  <ArrowRight size={14} className="shrink-0 text-muted" />
                  <span className="truncate">{ref.title}</span>
                </button>
              ))}
            </div>
          )}
        </Section>

        {/* Health */}
        <Section title="Health">
          <span
            className="chip"
            style={{ backgroundColor: healthMeta.color + '22', color: healthMeta.color }}
          >
            {healthMeta.label}
          </span>
          {health.issues.length > 0 ? (
            <ul className="mt-2.5 space-y-1.5">
              {health.issues.map((issue, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-muted">
                  <AlertTriangle
                    size={13}
                    className="mt-0.5 shrink-0"
                    style={{ color: healthMeta.color }}
                  />
                  <span>{issue}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div
              className="mt-2.5 flex items-center gap-2 text-xs"
              style={{ color: GOOD_COLOR }}
            >
              <CheckCircle2 size={14} className="shrink-0" />
              <span>Looks good</span>
            </div>
          )}
        </Section>
      </div>
    </aside>
  );
}
