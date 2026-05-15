# Safe Code Change Rules

Read this before touching any file in the Zodiac Program.

---

## The Core Principle

> Identify the exact broken thing. Touch only that. Leave the rest alone.

Every bug fix should look like a surgeon's cut — small, precise, and only where
it needs to be. Not like a renovation.

---

## Rule 0 — No Scope Declaration = No Changes

If Claude has not written a Scope Declaration (listing what it will and will
not touch), it must do that before making any file changes. This is not
bureaucracy — it forces precision. If Claude cannot name the specific lines
it is changing and why, it is not ready to change them.

---

## Rule 1 — Read the Error, Then the File

Before changing any file, read it. Go to the line number the error points to.
Read 10–20 lines of context. Ask: "Do I understand exactly why this line is
wrong?"

If the answer is no — add a diagnostic log, run it, read the result. Then fix.

---

## Rule 2 — Change the Minimum Lines

Count the lines being changed. For a genuine single-bug fix, this is usually
1–5 lines. If it is growing toward 20+ lines, stop and question whether the
scope has drifted.

**Good:** Fix the one wrong path on line 199.
**Bad:** Refactor the whole `generateScript()` function because "it's cleaner."

---

## Rule 3 — Protected Files (require explicit user permission)

Never change these without explaining the change to the user first and waiting
for a go-ahead:

| File | Why it is protected |
|------|-------------------|
| `sync.config.json` | All folder paths — wrong value breaks every job |
| `package.json` | Dependency versions — changes require `npm install`, may break builds |
| `scripts/zodiac-render.ts` | The `RenderJob` interface — must stay compatible with sync-worker.js |
| `server.ts` | Express routes — changes affect the whole web app |
| `.env` | API keys — a wrong value silently breaks all AI features |
| `src/` (Remotion components) | Video layout — requires `npm run build` to test; visual breakage |

---

## Rule 4 — Never-Touch Subsystems During a Focused Debug

When debugging one specific area, do not open or modify these unless the stack
trace explicitly points to them:

| Subsystem | When to ignore it |
|-----------|------------------|
| TikTok uploader / export workflow | Any bug not in the export step |
| `src/` UI and Remotion compositions | Any bug not in the video layout |
| `scripts/clip.ts` | Any bug not in the clip factory |
| `server.ts` API routes | Any sync worker or render bug |
| `sync-worker.js` | Any bug isolated to the web app |
| `zodiac-generate.ts` | Any bug not in AI script generation |

---

## Rule 5 — Protected Folders (never delete or clear without permission)

| Folder | Risk of deleting |
|--------|-----------------|
| `C:\Zodiac Program\cache\` | Forces a full re-render — very slow |
| `C:\Zodiac Program\working\` | Files from active in-flight jobs live here |
| `C:\Zodiac Program\renders\` | Intermediate render frames |
| `backgrounds/` | Source video files — deleting removes render inputs |
| `music/` | Music tracks — job JSONs reference these by filename |
| `zodiac-output/` | Active and completed render output |

If cleaning one of these is genuinely needed (e.g., a corrupted cache), name
the exact folder, explain what will be lost, and let the user confirm.

---

## Rule 6 — One Fix at a Time

If three things are broken, fix the most critical one first. Verify it works.
Then move to the next. Never bundle multiple fixes in one change.

This matters because: if a bundle of changes breaks something new, you do not
know which fix caused it.

---

## Rule 7 — Always Show Before / After

Every proposed change must show the exact lines being replaced:

```js
// BEFORE (sync-worker.js line 201)
const proc = spawn('npx', ['tsx', '-e', code], { shell: true });

// AFTER
const tmpScript = path.join(PATHS.working, `gen-${Date.now()}.ts`);
fs.writeFileSync(tmpScript, code, 'utf8');
const proc = spawn('npx', ['tsx', tmpScript], { shell: false });
```

Do not paste the entire function when only two lines changed.

---

## Rule 8 — Test After Every Change

| Changed area | Minimum test |
|-------------|-------------|
| `sync-worker.js` | `npm run sync:test` |
| `server.ts` | `npm start` — confirm no startup error |
| `sync.config.json` | `node -e "JSON.parse(require('fs').readFileSync('sync.config.json','utf8')); console.log('valid')"` |
| `zodiac-render.ts` | Drop a `script-only` job (no full render needed) |
| `package.json` | `npm install` then `npm start` |

Never say "that should work" without running something to verify.

---

## Rule 9 — Remove Temporary Debug Logs

If a `console.log` was added to diagnose the problem, remove it after the fix
is confirmed. Mark temporary logs clearly when adding them so they are easy
to find:

```js
// [DEBUG TEMP — remove after fix]
console.log('PATHS.working:', PATHS.working, 'exists:', fs.existsSync(PATHS.working));
```

---

## Rule 10 — Comment Non-Obvious Fixes

If the fix is a workaround or patches an edge case that is not immediately
obvious, add a comment explaining it:

```js
// Write code to a temp file rather than passing it inline via -e.
// /bin/sh rejects parentheses in the TypeScript string when shell:true is set.
const tmpScript = path.join(PATHS.working, `gen-${Date.now()}.ts`);
```

This prevents someone from "simplifying" the workaround and reintroducing the
same bug later.

---

## Rule 11 — Async Bugs Are Sneaky

The sync worker is almost entirely async. The most common async mistakes are:

- Missing `await` — code moves on before a file is written or a process finishes
- Swallowed errors — a `.catch()` logs but does not re-throw, so the job
  silently succeeds while the output is missing
- Race conditions — two jobs write to the same temp file path

When changing async code, verify every `Promise` is either `await`ed or has
a visible `.catch()` that re-throws or calls `reject()`.
