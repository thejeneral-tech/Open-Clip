import { Boxes, Command, Sparkles } from 'lucide-react';
import { useStore } from '@/store/useStore';

export function EmptyState() {
  const addNode = useStore((s) => s.addNode);
  const loadSample = useStore((s) => s.loadSample);
  const setCommandOpen = useStore((s) => s.setCommandOpen);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
      <div className="panel pointer-events-auto animate-fade-in flex w-[380px] max-w-full flex-col items-center gap-4 p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-brand-600 shadow-glow">
          <Boxes size={26} className="text-white" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-ink">Start your workflow</h2>
          <p className="mt-1 text-sm text-muted">
            Map out files, APIs, databases, prompts and deploy steps — then connect them to see how
            your project fits together.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2">
          <button type="button" className="btn btn-primary w-full" onClick={() => addNode('feature')}>
            <Sparkles size={15} />
            Add a Feature node
          </button>
          <button type="button" className="btn btn-outline w-full" onClick={() => loadSample()}>
            Load the sample workflow
          </button>
          <button type="button" className="btn btn-ghost w-full" onClick={() => setCommandOpen(true)}>
            <Command size={14} />
            Open command palette
          </button>
        </div>
        <p className="text-[11px] text-muted">Tip: drag node types from the left sidebar onto the canvas.</p>
      </div>
    </div>
  );
}
