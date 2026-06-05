# CodeFlow Canvas

A visual canvas for **designing, organizing and understanding coding workflows** — the free movement and whiteboard feel of Miro, the directional node connections of n8n, and the project organization of Linear/Jira, built specifically for developers.

Plan how a project fits together, see what files connect to what features, track what needs building, spot missing pieces *before* you write code, and export the whole thing as a prompt you can hand to Claude or Cursor.

![dark mode](https://img.shields.io/badge/theme-dark-0a0b10) ![stack](https://img.shields.io/badge/React-TS-Vite-6366f1) ![canvas](https://img.shields.io/badge/React%20Flow-v12-22d3ee)

---

## Quick start

```bash
# 1. install dependencies
npm install

# 2. run the dev server (opens http://localhost:5173)
npm run dev
```

Other commands:

```bash
npm run build      # type-check + production build into /dist
npm run preview    # serve the production build locally
npm run typecheck  # type-check only (tsc --noEmit)
```

> Requires Node 18+ (Node 20+ recommended).

The app opens with a small sample "User Authentication" workflow so you can see how everything fits together. Your work is **auto-saved to `localStorage`** — reload and it's still there. Use **Reset** in the toolbar to start blank, or **Sample** to bring the demo back.

---

## What you can do

- **Infinite canvas** — pan, zoom, drag nodes anywhere, box-select multiple, snap-to-grid toggle, mini-map, dark futuristic theme by default.
- **n8n-style connections** — drag from a node's output handle to another node's input. Connections show direction (arrowheads), carry **labels**, and support **success / error** paths (green / red) for branching and loops.
- **14 developer node types** — File, Folder, API endpoint, Function, Database, AI Agent / Prompt, Terminal command, GitHub task, Bug, Feature, Deployment, Test, Documentation, Environment variable.
- **Rich nodes** — every node has a title, description, status, tags, inputs/outputs, notes, a code-snippet area, a checklist, and a links section (edit them in the inspector).
- **Connection health** — live validation warns about missing inputs/outputs, broken chains, API nodes with no URL, databases with no schema/credentials, AI agents with no prompt, and deployments with no test step before them. The **Connection Health** panel summarizes everything and jumps you to problem nodes.
- **Spaces** — organize nodes into Frontend, Backend, Database, AI Agents, APIs, Bugs, Features, Deployment, Documentation… and create your own.
- **Node inspector** — click any node to edit everything in a right-side panel.
- **Search & filters** — search text, filter by status / type / tag, show only broken connections, or only unfinished tasks.
- **AI-ready export** — export the workflow as **JSON**, **Markdown**, a **Claude prompt**, a **Cursor prompt**, or an **implementation checklist**. The Claude/Cursor prompts describe the whole plan (nodes, connections, build order, known gaps) so you can paste them straight into an AI coding tool.
- **Save / load** — auto-save locally, plus import/export `.json` workflow files to share or back up.
- **Undo / redo** — full history for canvas edits (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z).
- **Auto-layout** — one-click "Tidy up" arranges the graph into clean left-to-right topological columns.
- **Command palette** — ⌘/Ctrl+K to add a node, jump to any node, or run any action without hunting through menus.
- **Inline edge editing** — double-click a connection to rename it; select it to switch success/error/default or delete it.
- **Multi-canvas projects** — keep separate **boards** for different projects or areas. Create, rename, duplicate and delete them from the board switcher in the toolbar; each board saves its own nodes, connections and spaces.
- **Right-click context menus** — on the canvas (add a node right where you clicked, tidy, fit), on a node (open, duplicate, set status, delete) and on a connection (change path type, delete).

### Status system

Each node is one of: **Idea · Planned · In Progress · Blocked · Needs Testing · Done** — each with its own color + icon.

### Connection health states

**Connected · Missing input · Missing output · Broken chain · Needs review · Ready to build.**

---

## How to use it

1. **Add nodes** — drag a node type from the left palette onto the canvas, or click it to drop one in. (You can also use the **Add node** button in the toolbar.)
2. **Connect them** — hover a node and drag from a right-side (output) handle to another node's left-side (input) handle. Success/error outputs are color-coded.
3. **Edit a node** — click it to open the inspector on the right; fill in description, code, prompt, checklist, links, etc.
4. **Organize** — assign nodes to spaces in the inspector, or filter by space in the left sidebar.
5. **Check health** — watch the Connection Health panel (bottom-left). Click any flagged node to jump to it and fix it.
6. **Export** — open **Export** in the toolbar, pick **Claude prompt**, copy, and paste into Claude with "build this for me."

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘/Ctrl + K` | Open the command palette |
| `⌘/Ctrl + Z` | Undo |
| `⌘/Ctrl + Shift + Z` | Redo |
| `Delete` / `Backspace` | Delete the selected node |
| Drag from a node handle | Create a connection |
| Double-click a connection | Rename its label |
| Box-drag on empty canvas | Select multiple nodes |

---

## Folder structure

```
codeflow-canvas/
├─ index.html                 # app shell (dark by default)
├─ package.json
├─ vite.config.ts             # Vite + React + "@/" path alias
├─ tailwind.config.js         # custom dark theme tokens
├─ postcss.config.js
├─ tsconfig.json
└─ src/
   ├─ main.tsx                # entry; mounts <ReactFlowProvider><App/>
   ├─ App.tsx                 # layout: Toolbar / Sidebar / Canvas / panels
   ├─ index.css               # Tailwind + design-system classes + RF theming
   ├─ types/
   │  └─ index.ts             # all shared types (NodeData, FlowNode, …)
   ├─ store/
   │  └─ useStore.ts          # Zustand store (state + actions, persisted)
   ├─ lib/
   │  ├─ cn.ts                # className merge helper
   │  ├─ nodeRegistry.ts      # node/status/health metadata + node factory
   │  ├─ validation.ts        # connection-health engine
   │  ├─ filtering.ts         # shared search/filter predicate
   │  ├─ exporters.ts         # JSON / Markdown / Claude / Cursor / checklist
   │  ├─ storage.ts           # download / read-file / clipboard / parse
   │  └─ sampleWorkflow.ts    # seed workflow + default spaces
   └─ components/
      ├─ Toolbar.tsx          # top bar: add node, undo/redo, tidy, import/export
      ├─ Sidebar.tsx          # spaces + draggable node palette
      ├─ Inspector.tsx        # right-side node editor
      ├─ HealthPanel.tsx      # Connection Health summary
      ├─ SearchFilterPanel.tsx# search + filters
      ├─ CommandPalette.tsx   # ⌘K command palette
      ├─ EmptyState.tsx       # first-run / empty-canvas prompt
      ├─ BoardSwitcher.tsx    # multi-canvas project switcher
      └─ canvas/
         ├─ Canvas.tsx        # React Flow surface (pan/zoom/connect/filter)
         ├─ WorkflowNode.tsx  # custom node renderer
         ├─ LabeledEdge.tsx   # labeled, directional, color-coded edge
         └─ CanvasContextMenu.tsx # right-click menus
```

---

## Tech stack

- **React 18 + TypeScript + Vite**
- **[@xyflow/react](https://reactflow.dev) (React Flow v12)** — canvas, nodes, connections, mini-map
- **Zustand** — state management (persisted to `localStorage`)
- **Tailwind CSS** — styling, with a custom dark "developer control panel" theme
- **lucide-react** — icons
- shadcn/ui-style hand-rolled primitives (`.panel`, `.btn`, `.input`, `.chip`…) so there's no extra CLI/setup step

---

## Important notes

- **Local-first storage.** Everything lives in your browser's `localStorage` under the key `codeflow-canvas-v1`. Nothing is sent anywhere. Use **Export → JSON** for portable backups and **Import** to restore.
- **The exports are the point.** The Claude/Cursor prompt exports turn your diagram into an actionable build brief — including the detected gaps — so the plan you draw becomes the plan an AI (or you) executes.
- **Validation is heuristic.** "Connection health" is meant to catch obvious missing pieces (no input, no URL, no test before deploy, …), not to be a compiler. Treat warnings as a checklist, not gospel.
- **Scope.** The MVP (canvas, moveable/connectable nodes, inspector, save/load, exports, health checks, search/filter) is complete, plus two polish passes adding undo/redo, one-click auto-layout, a ⌘K command palette, inline edge editing, an empty-state, **multi-canvas project boards**, and **right-click context menus**. Natural next steps: node templates/presets, group frames, and collaborative/cloud sync.

---

Built as a single-page app — no backend required.
