import { useEffect } from 'react';
import { useStore } from '@/store/useStore';
import { Toolbar } from '@/components/Toolbar';
import { Sidebar } from '@/components/Sidebar';
import { Canvas } from '@/components/canvas/Canvas';
import { Inspector } from '@/components/Inspector';
import { HealthPanel } from '@/components/HealthPanel';
import { SearchFilterPanel } from '@/components/SearchFilterPanel';
import { CommandPalette } from '@/components/CommandPalette';
import { EmptyState } from '@/components/EmptyState';

export default function App() {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const showHealth = useStore((s) => s.ui.showHealth);
  const showSearch = useStore((s) => s.ui.showSearch);
  const nodeCount = useStore((s) => s.nodes.length);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const commandOpen = useStore((s) => s.commandOpen);
  const setCommandOpen = useStore((s) => s.setCommandOpen);

  /* Global keyboard shortcuts: ⌘/Ctrl+K palette, ⌘/Ctrl+Z undo, ⌘/Ctrl+Shift+Z redo. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();

      if (key === 'k') {
        e.preventDefault();
        setCommandOpen(!commandOpen);
        return;
      }

      const t = e.target as HTMLElement | null;
      const editing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (editing) return; // let inputs keep native undo/redo

      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo, commandOpen, setCommandOpen]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-ink">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="relative min-w-0 flex-1">
          <Canvas />
          {nodeCount === 0 && <EmptyState />}
          {showSearch && <SearchFilterPanel />}
          {showHealth && <HealthPanel />}
          {selectedNodeId && <Inspector />}
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
