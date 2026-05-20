#!/usr/bin/env node
/* ============================================================
   Ollama Chat — zero-dependency Node web server
   ------------------------------------------------------------
   - Serves the static UI (index.html, styles.css, app.js)
   - Proxies /api/* requests to the Ollama server, preserving
     streaming responses so token-by-token chat still works.
   - Because the browser only ever talks to this server,
     OLLAMA_ORIGINS / CORS doesn't matter — the request to
     Ollama happens server-side.

   Usage:
     node server.js                 # default: port 5500, ollama at :11434
     PORT=8080 node server.js
     OLLAMA_HOST=http://localhost:11434 node server.js
   ============================================================ */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT, 10) || 5500;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const ROOT = __dirname;

// Local Code agent works in the parent project (Trend Vault folder).
const CODE_CWD = process.env.CODE_CWD || process.env.CLAUDE_CWD || path.resolve(ROOT, "..");
const IS_WIN = process.platform === "win32";

// Model-name patterns that are known to support Ollama tool calling.
// (Best-effort — Ollama doesn't expose this in /api/tags. Used as a hint only;
//  any model the user selects will still be attempted.)
const TOOL_CAPABLE_PATTERNS = [
  /^llama3\.[12]/i, /^llama3\.3/i,
  /^qwen2\.5/i, /^qwen3/i,
  /^mistral-nemo/i, /^mistral-small/i, /^mistral-large/i,
  /^mixtral/i,
  /^firefunction/i, /^command-r/i,
  /^granite3/i, /^hermes/i,
  /^smollm2/i,
];

// In-flight Local Code agent jobs keyed by jobId. Each entry is { abort: AbortController }.
const codeJobs = new Map();
// In-flight aider subprocess jobs keyed by jobId. Each entry is { child: ChildProcess }.
const aiderJobs = new Map();

// Hard caps so a runaway model loop can't hammer the filesystem forever.
const AGENT_MAX_ITERS = 24;
const AGENT_FILE_READ_BYTES = 256 * 1024;     // 256 KB per read
const AGENT_BASH_TIMEOUT_MS = 60_000;
const AGENT_BASH_OUTPUT_BYTES = 64 * 1024;     // 64 KB per bash output

// File-upload limits.
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;     // 50 MB per file
const UPLOAD_SUBDIR = "uploads";               // <targetRoot>/uploads/...

// Parse the URL once and pin the hostname to an explicit IP if the user
// gave us "localhost", to avoid IPv4/IPv6 DNS surprises on Windows.
function pathnameOf(reqUrl) {
  // Use WHATWG URL; req.url is always a path so anchor it on a dummy origin.
  return new URL(reqUrl, "http://x").pathname;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico":  "image/x-icon",
  ".md":   "text/markdown; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
};

const ollamaUrl = new URL(OLLAMA_HOST);
const proxyAgent = ollamaUrl.protocol === "https:"
  ? require("https")
  : require("http");

/* ----------------------------------------------------------
   Static file serving
   ---------------------------------------------------------- */
function serveStatic(req, res) {
  // Map "/" → "/index.html"
  let pathname = decodeURIComponent(pathnameOf(req.url));
  if (pathname === "/" || pathname === "") pathname = "/index.html";

  // Resolve and lock to ROOT so requests can't escape the folder.
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ----------------------------------------------------------
   Reverse proxy: /api/* → Ollama
   ---------------------------------------------------------- */
function proxyToOllama(req, res) {
  const target = new URL(req.url, OLLAMA_HOST);

  // Build a clean header set. We strip:
  //  - hop-by-hop headers (host, connection)
  //  - Origin and Referer (Ollama's CORS check will reject the
  //    browser's origin; removing them makes this look like a normal
  //    server-to-server request, which is the whole point of the proxy)
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "connection" ||
        lower === "origin" || lower === "referer") continue;
    headers[k] = v;
  }
  headers.host = ollamaUrl.host;

  const options = {
    protocol: ollamaUrl.protocol,
    hostname: ollamaUrl.hostname,
    port: ollamaUrl.port || (ollamaUrl.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    method: req.method,
    headers,
    // Prefer IPv4 first — on Windows, "localhost" can resolve to ::1
    // and Ollama listens on 127.0.0.1 by default, which causes
    // "socket hang up" / ECONNREFUSED.
    family: 4,
  };

  const upstream = proxyAgent.request(options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on("error", (err) => {
    console.error(`[proxy] ${req.method} ${req.url} →`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({
        error:
          `Couldn't reach Ollama at ${OLLAMA_HOST}. ` +
          `Is it running? (${err.code || err.message})`,
      })
    );
  });

  // Forward the request body (POST /api/chat etc.).
  req.pipe(upstream);

  // If the browser disconnects mid-stream, abort the upstream call too.
  // Use 'close' on the *response*, gated on whether the response actually
  // finished — destroying the upstream after a normal completion is a no-op,
  // but destroying it early (e.g. on 'aborted' from the client) frees the
  // upstream connection so Ollama stops generating tokens.
  res.on("close", () => {
    if (!res.writableEnded && !upstream.destroyed) {
      upstream.destroy();
    }
  });
}

/* ----------------------------------------------------------
   Local Code: Ollama tool-calling agent loop
   ---------------------------------------------------------- */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function writeJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isToolCapable(modelName) {
  return TOOL_CAPABLE_PATTERNS.some((re) => re.test(modelName || ""));
}

// Path containment: a path is allowed if, after resolution, it lives inside
// the working directory OR any of the explicitly allowed dirs the user added.
//
// `p` may be relative (resolved against cwd) or absolute. Returns the absolute
// path on success, throws otherwise.
//
// When `unrestricted` is true, the containment check is skipped entirely and
// any resolvable absolute path is returned — the user has opted in to full
// disk access for the agent.
function resolveInsideAllowed(cwd, allowedDirs, p, unrestricted) {
  if (typeof p !== "string" || !p) throw new Error("Path required");
  const abs = path.resolve(cwd, p);
  if (unrestricted) return abs;
  const roots = [cwd, ...(allowedDirs || [])].map((d) => path.resolve(d));
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + path.sep)) return abs;
  }
  throw new Error(
    `Path is outside the allowed directories: ${p}. ` +
    `Allowed roots: ${roots.join(", ")}. ` +
    `(Tip: enable "Full disk access" in Settings to let the agent reach any path, ` +
    `or add the containing folder under "Additional directories".)`
  );
}

/* ----------------------------------------------------------
   Tool definitions (OpenAI/Ollama tool-call schema)
   ---------------------------------------------------------- */
const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a text file inside the working directory. " +
        "Returns up to 256 KB. Use `offset`/`limit` for big files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the working directory." },
          offset: { type: "integer", description: "0-based line offset to start reading from.", minimum: 0 },
          limit: { type: "integer", description: "Maximum number of lines to return.", minimum: 1 },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file inside the working directory with the given content. " +
        "Parent directories must already exist.",
      parameters: {
        type: "object",
        properties: {
          path:    { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact substring in a file with a new substring. `old_string` must occur " +
        "exactly once in the file and match including whitespace.",
      parameters: {
        type: "object",
        properties: {
          path:       { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries of a directory inside the working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path; '.' for the working directory." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files matching a glob pattern (e.g. `**/*.ts`, `src/*.js`). Returns up to 200 paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents for a regular-expression pattern. Returns matching lines " +
        "with file:line prefixes (max 200 hits).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regex pattern (no leading/trailing slashes)." },
          path:    { type: "string", description: "File or directory to search; default is the working directory." },
          glob:    { type: "string", description: "Optional file glob to restrict the search (e.g. '*.ts')." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command inside the working directory. Times out after 60s. " +
        "stdout and stderr are returned together with the exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
];

/* ----------------------------------------------------------
   Tool implementations
   ---------------------------------------------------------- */
function trimOutput(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…\n[truncated, ${text.length} chars total]`;
}

async function tool_read_file(ctx, args) {
  const abs = resolveInsideAllowed(ctx.cwd, ctx.allowedDirs, args.path, ctx.unrestricted);
  const stat = await fs.promises.stat(abs);
  if (!stat.isFile()) throw new Error("Not a file");
  let content = await fs.promises.readFile(abs, "utf8");
  if (typeof args.offset === "number" || typeof args.limit === "number") {
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, args.offset || 0);
    const end = typeof args.limit === "number" ? start + args.limit : lines.length;
    content = lines.slice(start, end).join("\n");
  }
  return { content: trimOutput(content, AGENT_FILE_READ_BYTES), bytes: stat.size };
}

async function tool_write_file(ctx, args) {
  const abs = resolveInsideAllowed(ctx.cwd, ctx.allowedDirs, args.path, ctx.unrestricted);
  // Ensure the parent directory exists in unrestricted mode where the user
  // might be writing somewhere new outside their primary root.
  if (ctx.unrestricted) {
    try { await fs.promises.mkdir(path.dirname(abs), { recursive: true }); } catch {}
  }
  await fs.promises.writeFile(abs, String(args.content ?? ""), "utf8");
  const stat = await fs.promises.stat(abs);
  return { ok: true, path: args.path, bytes: stat.size };
}

async function tool_edit_file(ctx, args) {
  const abs = resolveInsideAllowed(ctx.cwd, ctx.allowedDirs, args.path, ctx.unrestricted);
  const original = await fs.promises.readFile(abs, "utf8");
  const oldStr = String(args.old_string ?? "");
  const newStr = String(args.new_string ?? "");
  if (!oldStr) throw new Error("old_string is required");
  const first = original.indexOf(oldStr);
  if (first === -1) throw new Error("old_string not found in file");
  const second = original.indexOf(oldStr, first + 1);
  if (second !== -1) throw new Error("old_string is not unique — appears multiple times; include more context");
  const updated = original.slice(0, first) + newStr + original.slice(first + oldStr.length);
  await fs.promises.writeFile(abs, updated, "utf8");
  return { ok: true, path: args.path, replacedAt: first };
}

async function tool_list_dir(ctx, args) {
  const abs = resolveInsideAllowed(ctx.cwd, ctx.allowedDirs, args.path || ".", ctx.unrestricted);
  const entries = await fs.promises.readdir(abs, { withFileTypes: true });
  return {
    path: args.path || ".",
    entries: entries.slice(0, 500).map((d) => ({
      name: d.name,
      type: d.isDirectory() ? "dir" : (d.isSymbolicLink() ? "symlink" : "file"),
    })),
  };
}

// Tiny glob → regex (supports **, *, ?). Good enough for source-tree lookups.
function globToRegex(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") { re += ".*"; i++; }
      else { re += "[^/\\\\]*"; }
    } else if (ch === "?") {
      re += "[^/\\\\]";
    } else if ("/\\.^$+(){}[]|".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

async function walkFiles(root, max, filter) {
  const out = [];
  const stack = [root];
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "out", ".cache"]);
  while (stack.length && out.length < max) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const d of entries) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (SKIP.has(d.name)) continue;
        stack.push(full);
      } else if (d.isFile()) {
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (!filter || filter(rel)) {
          out.push({ root, rel, full });
          if (out.length >= max) break;
        }
      }
    }
  }
  return out;
}

// Tag a relative path with its root so the model can tell two unrelated trees apart.
// Files inside the primary cwd render without a root prefix (the common case);
// files inside an extra allowed dir get a `«root»/...` prefix.
function tagPath(ctx, rootAbs, rel) {
  if (rootAbs === path.resolve(ctx.cwd)) return rel;
  const label = path.basename(rootAbs) || rootAbs;
  return `«${label}»/${rel}`;
}

async function tool_glob(ctx, args) {
  const re = globToRegex(args.pattern);
  const roots = [ctx.cwd, ...(ctx.allowedDirs || [])].map((d) => path.resolve(d));
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    const found = await walkFiles(root, 200 - out.length, ({ rel }) => re.test(rel));
    for (const f of found) {
      out.push(tagPath(ctx, root, f.rel));
      if (out.length >= 200) break;
    }
    if (out.length >= 200) break;
  }
  return { pattern: args.pattern, count: out.length, paths: out, rootsSearched: roots };
}

async function tool_grep(ctx, args) {
  const pattern = String(args.pattern || "");
  if (!pattern) throw new Error("pattern is required");
  let re;
  try { re = new RegExp(pattern); }
  catch (e) { throw new Error(`Bad regex: ${e.message}`); }

  const fileFilter = args.glob ? globToRegex(args.glob) : null;
  const hits = [];

  if (args.path) {
    // Explicit path → resolve & validate once, scan only it.
    const searchRoot = resolveInsideAllowed(ctx.cwd, ctx.allowedDirs, args.path, ctx.unrestricted);
    const stat = await fs.promises.stat(searchRoot);
    const files = stat.isFile()
      ? [{ root: path.dirname(searchRoot), rel: path.basename(searchRoot), full: searchRoot }]
      : await walkFiles(searchRoot, 2000, ({ rel }) => !fileFilter || fileFilter(path.basename(rel)));
    for (const { full, rel } of files) {
      const display = stat.isFile() ? args.path : path.posix.join(args.path, rel);
      let content;
      try { content = await fs.promises.readFile(full, "utf8"); }
      catch { continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${display}:${i + 1}: ${lines[i]}`);
          if (hits.length >= 200) return { pattern, count: hits.length, hits };
        }
      }
    }
  } else {
    // No path → scan across all allowed roots.
    const roots = [ctx.cwd, ...(ctx.allowedDirs || [])].map((d) => path.resolve(d));
    const seen = new Set();
    for (const root of roots) {
      if (seen.has(root)) continue;
      seen.add(root);
      const files = await walkFiles(root, 2000, ({ rel }) => !fileFilter || fileFilter(path.basename(rel)));
      for (const { full, rel } of files) {
        const display = tagPath(ctx, root, rel);
        let content;
        try { content = await fs.promises.readFile(full, "utf8"); }
        catch { continue; }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${display}:${i + 1}: ${lines[i]}`);
            if (hits.length >= 200) return { pattern, count: hits.length, hits };
          }
        }
      }
    }
  }
  return { pattern, count: hits.length, hits };
}

function tool_bash(ctx, args, signal) {
  return new Promise((resolve) => {
    const command = String(args.command || "");
    if (!command.trim()) return resolve({ ok: false, error: "Empty command" });

    const child = spawn(command, {
      cwd: ctx.cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(IS_WIN ? undefined : "SIGTERM"); } catch {}
    }, AGENT_BASH_TIMEOUT_MS);

    if (signal) {
      const onAbort = () => { try { child.kill(IS_WIN ? undefined : "SIGTERM"); } catch {} };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (b) => {
      if (stdout.length < AGENT_BASH_OUTPUT_BYTES) stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b) => {
      if (stderr.length < AGENT_BASH_OUTPUT_BYTES) stderr += b.toString("utf8");
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code,
        signal: sig,
        stdout: trimOutput(stdout, AGENT_BASH_OUTPUT_BYTES),
        stderr: trimOutput(stderr, AGENT_BASH_OUTPUT_BYTES),
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

async function executeTool(name, args, ctx, signal) {
  const safeArgs = args && typeof args === "object" ? args : {};
  switch (name) {
    case "read_file": return tool_read_file(ctx, safeArgs);
    case "write_file": return tool_write_file(ctx, safeArgs);
    case "edit_file": return tool_edit_file(ctx, safeArgs);
    case "list_dir": return tool_list_dir(ctx, safeArgs);
    case "glob": return tool_glob(ctx, safeArgs);
    case "grep": return tool_grep(ctx, safeArgs);
    case "bash": return tool_bash(ctx, safeArgs, signal);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

/* ----------------------------------------------------------
   Ollama wire helpers
   ---------------------------------------------------------- */
function ollamaPost(pathname, body, signal) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, OLLAMA_HOST);
    const opts = {
      protocol: ollamaUrl.protocol,
      hostname: ollamaUrl.hostname,
      port: ollamaUrl.port || (ollamaUrl.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: "POST",
      family: 4,
      headers: { "Content-Type": "application/json" },
    };
    const req = proxyAgent.request(opts, (resp) => {
      let buf = "";
      resp.setEncoding("utf8");
      resp.on("data", (c) => { buf += c; });
      resp.on("end", () => {
        try {
          const obj = JSON.parse(buf);
          if (resp.statusCode >= 400) reject(new Error(obj.error || `HTTP ${resp.statusCode}`));
          else resolve(obj);
        } catch (e) {
          reject(new Error(`Ollama returned non-JSON (${resp.statusCode}): ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (signal) {
      const onAbort = () => req.destroy(new Error("aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    req.end(JSON.stringify(body));
  });
}

// Streaming variant of /api/chat. Consumes the ndjson stream Ollama sends
// back, fires `onChunk(piece)` for every non-empty content fragment, then
// resolves with the same shape ollamaPost would have returned (so the
// agent loop can keep reading `resp.message` and `resp.eval_count`).
function ollamaChatStream(body, signal, onChunk) {
  return new Promise((resolve, reject) => {
    const target = new URL("/api/chat", OLLAMA_HOST);
    const opts = {
      protocol: ollamaUrl.protocol,
      hostname: ollamaUrl.hostname,
      port: ollamaUrl.port || (ollamaUrl.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: "POST",
      family: 4,
      headers: { "Content-Type": "application/json" },
    };
    const req = proxyAgent.request(opts, (resp) => {
      let buf = "";
      let accumContent = "";
      let accumThinking = "";
      let toolCalls = [];
      let role = "assistant";
      const final = {};
      let httpErr = null;
      let chunkCount = 0;
      const tStart = Date.now();
      resp.setEncoding("utf8");
      resp.on("data", (c) => {
        buf += c;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (resp.statusCode >= 400) {
            httpErr = obj.error || `HTTP ${resp.statusCode}`;
            continue;
          }
          const msg = obj.message || {};
          if (msg.role) role = msg.role;

          // Reasoning models (Qwen3, DeepSeek-R1, etc.) on recent Ollama
          // versions emit their chain-of-thought in `message.thinking`,
          // separate from `message.content`. Count BOTH as live tokens so
          // the in-flight counter ticks during the thinking phase, not
          // just once the model starts producing the final answer.
          const content  = typeof msg.content  === "string" ? msg.content  : "";
          const thinking = typeof msg.thinking === "string" ? msg.thinking : "";
          if (content)  accumContent  += content;
          if (thinking) accumThinking += thinking;
          const piece = content || thinking;
          if (piece) {
            chunkCount++;
            try { onChunk && onChunk(piece); } catch { /* listener errors are not fatal */ }
          }
          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            // Some backends fragment tool_calls into multiple chunks; just collect.
            toolCalls = toolCalls.concat(msg.tool_calls);
            // A tool-call decision is "work" too — bump the counter so the
            // user sees something move on tool-only turns.
            chunkCount += msg.tool_calls.length;
            try { onChunk && onChunk(""); } catch { /* */ }
          }
          if (obj.done) {
            final.eval_count = obj.eval_count || 0;
            final.eval_duration = obj.eval_duration || 0;
            final.prompt_eval_count = obj.prompt_eval_count || 0;
            final.prompt_eval_duration = obj.prompt_eval_duration || 0;
            final.total_duration = obj.total_duration || 0;
            final.load_duration = obj.load_duration || 0;
            const ms = Date.now() - tStart;
            console.log(
              `[ollama-stream] done in ${ms}ms — chunks=${chunkCount} ` +
              `content=${accumContent.length}B thinking=${accumThinking.length}B ` +
              `tool_calls=${toolCalls.length} eval_count=${final.eval_count}`
            );
          }
        }
      });
      resp.on("end", () => {
        if (httpErr) return reject(new Error(httpErr));
        resolve({
          message: {
            role,
            content: accumContent,
            tool_calls: toolCalls.length ? toolCalls : undefined,
          },
          ...final,
        });
      });
      resp.on("error", reject);
    });
    req.on("error", reject);
    if (signal) {
      const onAbort = () => req.destroy(new Error("aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    req.end(JSON.stringify({ ...body, stream: true }));
  });
}

function ollamaGet(pathname, signal) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, OLLAMA_HOST);
    const opts = {
      protocol: ollamaUrl.protocol,
      hostname: ollamaUrl.hostname,
      port: ollamaUrl.port || (ollamaUrl.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: "GET",
      family: 4,
    };
    const req = proxyAgent.request(opts, (resp) => {
      let buf = "";
      resp.setEncoding("utf8");
      resp.on("data", (c) => { buf += c; });
      resp.on("end", () => {
        try {
          const obj = JSON.parse(buf);
          if (resp.statusCode >= 400) reject(new Error(obj.error || `HTTP ${resp.statusCode}`));
          else resolve(obj);
        } catch (e) {
          reject(new Error(`Ollama returned non-JSON (${resp.statusCode}): ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (signal) {
      const onAbort = () => req.destroy(new Error("aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    req.end();
  });
}

/* ----------------------------------------------------------
   Handlers: /local-code/*
   ---------------------------------------------------------- */
async function handleLocalCodeCheck(req, res) {
  try {
    const tags = await ollamaGet("/api/tags");
    const models = (tags.models || []).map((m) => m.name);
    const toolModels = models.filter(isToolCapable);
    writeJson(res, 200, {
      available: true,
      ollamaHost: OLLAMA_HOST,
      cwd: CODE_CWD,
      models,
      toolCapableModels: toolModels,
      platform: process.platform,
    });
  } catch (err) {
    writeJson(res, 200, {
      available: false,
      error: err.message,
      ollamaHost: OLLAMA_HOST,
      cwd: CODE_CWD,
      models: [],
      toolCapableModels: [],
      platform: process.platform,
    });
  }
}

// Small / quantised llama-family models often "describe" a tool call in plain
// text (e.g. `{"name": "list_dir", "parameters": {"path": "."}}`) instead of
// emitting it in the `tool_calls` field that Ollama exposes. Scan the assistant
// text for such embedded JSON-shaped calls and lift them out so the agent loop
// can still execute them.
const KNOWN_TOOL_NAMES = new Set([
  "read_file", "write_file", "edit_file", "list_dir", "glob", "grep", "bash",
]);

function extractEmbeddedToolCalls(text) {
  if (!text || typeof text !== "string") return { calls: [], cleanedText: text || "" };
  const out = [];
  const ranges = [];

  // Find candidate starts: any `"name"` key whose value is a known tool name.
  const startRe = /\{\s*"name"\s*:\s*"([a-z_]+)"/g;
  let m;
  while ((m = startRe.exec(text)) !== null) {
    if (!KNOWN_TOOL_NAMES.has(m[1])) continue;
    // Brace-match forward from this `{` until depth hits zero, respecting
    // strings + escapes so internal `}` inside string values don't fool us.
    let depth = 0, i = m.index, inStr = false, esc = false, end = -1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) continue;
    const blob = text.slice(m.index, end);
    let parsed;
    try { parsed = JSON.parse(blob); } catch { continue; }
    if (!parsed || typeof parsed.name !== "string") continue;
    const args = parsed.parameters || parsed.arguments || parsed.input || {};
    out.push({ function: { name: parsed.name, arguments: args } });
    ranges.push([m.index, end]);
    startRe.lastIndex = end;
  }

  if (ranges.length === 0) return { calls: out, cleanedText: text };

  // Strip the extracted blobs to produce a cleaner narrative for the UI.
  ranges.sort((a, b) => a[0] - b[0]);
  let cleaned = "";
  let pos = 0;
  for (const [s, e] of ranges) {
    cleaned += text.slice(pos, s);
    pos = e;
  }
  cleaned += text.slice(pos);
  cleaned = cleaned
    .replace(/```(?:json)?\s*```/g, "")         // empty fences left behind
    .replace(/^[ \t]+|[ \t]+$/gm, "")           // trim trailing/leading spaces per line
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { calls: out, cleanedText: cleaned };
}

function defaultCodeSystemPrompt(cwd, allowedDirs, unrestricted) {
  const lines = [
    "You are a coding agent operating across one or more local directories the user has authorised.",
    `Primary working directory (relative paths resolve here, and bash runs here):`,
    `  ${cwd}`,
  ];
  if (allowedDirs && allowedDirs.length) {
    lines.push("Additional read/write directories (use absolute paths to reach them):");
    for (const d of allowedDirs) lines.push(`  ${d}`);
    lines.push(
      "When glob/grep run without an explicit `path`, they search across ALL of the above roots. " +
      "Results from non-primary roots are prefixed «<root-basename>»/… so you can tell them apart."
    );
  }
  if (unrestricted) {
    lines.push("");
    lines.push("⚠ FULL DISK ACCESS is enabled. You may pass any absolute path on this");
    lines.push("computer to read_file, write_file, edit_file, list_dir, glob, and grep");
    lines.push("— the usual containment check is off. Stay inside the user's intent and");
    lines.push("only touch files relevant to the requested task.");
  }
  lines.push("");
  lines.push("Tools available:");
  lines.push("  • read_file(path, offset?, limit?)  — read a text file");
  lines.push("  • write_file(path, content)         — create or overwrite a file");
  lines.push("  • edit_file(path, old_string, new_string) — replace one unique substring");
  lines.push("  • list_dir(path)                    — list a directory");
  lines.push("  • glob(pattern)                     — find files (e.g. '**/*.ts')");
  lines.push("  • grep(pattern, path?, glob?)       — regex search file contents");
  lines.push("  • bash(command)                     — run a shell command (60s timeout)");
  lines.push("");
  lines.push("Guidelines:");
  lines.push("  – Prefer reading a file before editing it.");
  lines.push("  – edit_file requires old_string to be unique; include surrounding context.");
  lines.push("  – Any path you give must resolve inside the primary cwd or one of the additional roots.");
  lines.push("  – Keep responses concise. After completing the task, summarise what changed in one sentence.");
  lines.push("  – If the user's request is ambiguous, ask one clarifying question instead of guessing.");
  return lines.join("\n");
}

async function handleLocalCodeChat(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return writeJson(res, 400, { error: `Bad JSON: ${e.message}` }); }

  const prompt = (body.prompt || "").toString();
  const model = (body.model || "").toString();
  const cwd = body.cwd ? String(body.cwd) : CODE_CWD;
  const history = Array.isArray(body.history) ? body.history : [];

  // Validate cwd + optional allowedDirs (extra roots the agent can touch).
  if (!prompt.trim()) return writeJson(res, 400, { error: "Empty prompt" });
  if (!model) return writeJson(res, 400, { error: "model is required" });
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) throw new Error("cwd is not a directory");
  } catch (e) {
    return writeJson(res, 400, { error: `cwd not usable: ${e.message}` });
  }

  const rawAllowed = Array.isArray(body.allowedDirs) ? body.allowedDirs : [];
  const allowedDirs = [];
  for (const d of rawAllowed) {
    const s = typeof d === "string" ? d.trim() : "";
    if (!s) continue;
    let abs;
    try {
      abs = path.resolve(s);
      const stat = fs.statSync(abs);
      if (!stat.isDirectory()) {
        return writeJson(res, 400, { error: `allowedDirs entry is not a directory: ${s}` });
      }
    } catch (e) {
      return writeJson(res, 400, { error: `allowedDirs entry not usable: ${s} (${e.message})` });
    }
    // Don't duplicate the primary cwd.
    if (abs !== path.resolve(cwd) && !allowedDirs.includes(abs)) allowedDirs.push(abs);
  }

  const unrestrictedFs = body.unrestrictedFs === true;
  const ctx = { cwd, allowedDirs, unrestricted: unrestrictedFs };
  const systemPrompt =
    (body.systemPrompt || "").trim() || defaultCodeSystemPrompt(cwd, allowedDirs, unrestrictedFs);

  const jobId = crypto.randomBytes(8).toString("hex");
  const abort = new AbortController();
  codeJobs.set(jobId, { abort });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "X-Code-Job": jobId,
  });
  const emit = (obj) => res.write(JSON.stringify(obj) + "\n");
  emit({
    kind: "meta", jobId, cwd, allowedDirs, model,
    toolCapable: isToolCapable(model), unrestrictedFs,
  });

  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
    codeJobs.delete(jobId);
  });

  // Build the message list: system + prior turns + new user prompt.
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  for (const m of history) {
    if (!m || !m.role) continue;
    messages.push(m);
  }
  messages.push({ role: "user", content: prompt });

  try {
    let iters = 0;
    while (iters < AGENT_MAX_ITERS) {
      if (abort.signal.aborted) break;
      iters++;

      let resp;
      try {
        // Stream from Ollama so we can forward each text chunk to the client
        // (powers the live tokens/seconds/t-s counter while the model is
        // still generating, instead of going dark until the turn finishes).
        resp = await ollamaChatStream({
          model,
          messages,
          tools: AGENT_TOOLS,
          options: body.options || {},
        }, abort.signal, (piece) => {
          emit({ kind: "live_token", text: piece });
        });
      } catch (err) {
        emit({ kind: "error", message: `Ollama request failed: ${err.message}` });
        break;
      }

      const msg = resp.message || {};

      // Surface Ollama's perf counters for this turn so the client can
      // tally an LM-Studio-style stats bar after the agent loop finishes.
      // Numbers are nanoseconds for *_duration, plain ints for counts.
      emit({
        kind: "turn_stats",
        evalCount: resp.eval_count || 0,
        evalDuration: resp.eval_duration || 0,
        promptEvalCount: resp.prompt_eval_count || 0,
        promptEvalDuration: resp.prompt_eval_duration || 0,
        totalDuration: resp.total_duration || 0,
        loadDuration: resp.load_duration || 0,
      });

      // Real Ollama tool_calls field if the model used it natively.
      let calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      let displayText = msg.content || "";

      // Fallback: small llamas often emit JSON-shaped tool calls in plain text.
      // Lift those out and execute them as if they were native tool_calls.
      if (calls.length === 0 && displayText) {
        const ex = extractEmbeddedToolCalls(displayText);
        if (ex.calls.length > 0) {
          calls = ex.calls;
          displayText = ex.cleanedText;
          emit({
            kind: "warning",
            message:
              `Model emitted ${ex.calls.length} tool call${ex.calls.length === 1 ? "" : "s"} ` +
              `as text — running them anyway. (For better behaviour, try a larger model: ` +
              `qwen2.5-coder, llama3.1, mistral-nemo.)`,
          });
        }
      }

      // Record the (possibly-rewritten) assistant turn in history so the next
      // round-trip sees the correct shape.
      messages.push({
        role: "assistant",
        content: displayText,
        tool_calls: calls.length ? calls : undefined,
      });

      if (displayText) emit({ kind: "assistant_text", text: displayText });

      if (calls.length === 0) {
        emit({ kind: "done", iters });
        break;
      }

      for (const call of calls) {
        if (abort.signal.aborted) break;
        const name = call.function?.name || "(unknown)";
        let toolArgs = call.function?.arguments || {};
        // Some Ollama backends return arguments as a JSON string; parse if so.
        if (typeof toolArgs === "string") {
          try { toolArgs = JSON.parse(toolArgs); } catch { toolArgs = { _raw: toolArgs }; }
        }
        const callId = crypto.randomBytes(6).toString("hex");
        emit({ kind: "tool_use", id: callId, name, input: toolArgs });

        let result, isError = false;
        try {
          result = await executeTool(name, toolArgs, ctx, abort.signal);
        } catch (err) {
          result = { error: err.message };
          isError = true;
        }
        emit({ kind: "tool_result", id: callId, name, output: result, isError });

        // Feed the result back to the model on the next turn.
        messages.push({
          role: "tool",
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }

      if (iters === AGENT_MAX_ITERS) {
        emit({ kind: "warning", message: `Stopped after ${AGENT_MAX_ITERS} iterations.` });
      }
    }
  } catch (err) {
    emit({ kind: "error", message: err.message });
  } finally {
    codeJobs.delete(jobId);
    if (!res.writableEnded) {
      emit({ kind: "exit" });
      res.end();
    }
  }
}

async function handleLocalCodeVerifyDirs(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return writeJson(res, 400, { error: `Bad JSON: ${e.message}` }); }

  const raw = Array.isArray(body.dirs) ? body.dirs : [];
  const results = raw.map((d) => {
    const input = typeof d === "string" ? d.trim() : "";
    if (!input) return { input, ok: false, reason: "empty" };
    let abs;
    try { abs = path.resolve(input); }
    catch (e) { return { input, ok: false, reason: `resolve failed: ${e.message}` }; }
    try {
      const stat = fs.statSync(abs);
      if (!stat.isDirectory()) return { input, abs, ok: false, reason: "not a directory" };
      return { input, abs, ok: true };
    } catch (e) {
      return { input, abs, ok: false, reason: e.code === "ENOENT" ? "does not exist" : e.message };
    }
  });
  writeJson(res, 200, { results });
}

/* ----------------------------------------------------------
   Aider backend — wraps the `aider` CLI as a subprocess and
   streams its stdout/stderr back to the client as text events.
   ----------------------------------------------------------
   Aider is an independent project (pip install aider-chat). We
   spawn it per message in --message mode so each turn is a one-
   shot from the CLI's perspective; aider keeps its own
   .aider.chat.history.md inside the project cwd, which provides
   conversation continuity automatically across our spawns.
   ---------------------------------------------------------- */
function resolveAider() {
  // 1. PATH.
  const fromPath = (() => {
    const r = spawnSync(IS_WIN ? "where" : "which", ["aider"], { encoding: "utf8" });
    if (r.status === 0) {
      const first = (r.stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      if (first) return first;
    }
    return null;
  })();
  if (fromPath) return fromPath;

  const home = process.env.USERPROFILE || process.env.HOME;

  // 2. ~/.local/bin/aider — where the official aider-install + uv land it.
  if (home) {
    const uvGuesses = IS_WIN
      ? [
          path.join(home, ".local", "bin", "aider.exe"),
          path.join(home, ".local", "bin", "aider"),
        ]
      : [path.join(home, ".local", "bin", "aider")];
    for (const g of uvGuesses) {
      try { if (fs.statSync(g).isFile()) return g; } catch { /* skip */ }
    }
  }

  // 3. Project-local venv maintained by the launcher (fallback install).
  //    server.js lives at <projectRoot>/Ollama web ui/server.js, so the venv
  //    is one level up.
  const venvBin = IS_WIN
    ? path.join(ROOT, "..", ".venv-aider", "Scripts", "aider.exe")
    : path.join(ROOT, "..", ".venv-aider", "bin", "aider");
  try {
    if (fs.statSync(venvBin).isFile()) return venvBin;
  } catch { /* not present */ }

  // 4. Plain pip --user locations.
  if (home) {
    const guesses = IS_WIN
      ? [path.join(home, "AppData", "Roaming", "Python", "Scripts", "aider.exe")]
      : ["/usr/local/bin/aider"];
    for (const g of guesses) {
      try { if (fs.statSync(g).isFile()) return g; } catch { /* skip */ }
    }
  }
  return null;
}

async function handleAiderCheck(req, res) {
  const bin = resolveAider();
  if (!bin) {
    return writeJson(res, 200, {
      available: false,
      error: "aider not found on PATH. Install with: pip install aider-chat",
    });
  }
  // Run `aider --version` quickly; tolerate odd exit codes.
  const proc = spawn(bin, ["--version"], { windowsHide: true });
  let out = "", err = "";
  proc.stdout.on("data", b => { out += b.toString("utf8"); });
  proc.stderr.on("data", b => { err += b.toString("utf8"); });
  const done = new Promise((resolve) => {
    const t = setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 6000);
    proc.on("close", () => { clearTimeout(t); resolve(null); });
    proc.on("error", () => { clearTimeout(t); resolve(null); });
  });
  await done;
  const version = (out + err).trim().split(/\r?\n/, 1)[0] || "(unknown)";
  writeJson(res, 200, { available: true, bin, version });
}

// Build the aider command. Returns { cmd, args } for spawn().
//
// We always pass:
//   --message "<prompt>"        one-shot (don't open the REPL)
//   --yes-always                auto-accept any "edit this file?" prompts
//   --no-auto-commits           don't `git commit` automatically
//   --no-stream                 buffered output is easier to parse
//   --no-pretty                 strip ANSI colours
//   --no-fancy-input            avoids prompt_toolkit init issues
//   --model <model>             explicit model identifier
//
// Custom user flags from settings.aiderFlags are split by whitespace and
// appended last so they win.
function buildAiderArgs({ model, prompt, files, extraFlags }) {
  const args = [
    "--message", prompt,
    "--yes-always",
    "--no-auto-commits",
    "--no-stream",
    "--no-pretty",
    "--no-fancy-input",
  ];
  if (model) {
    args.push("--model", model);
  }
  if (Array.isArray(files) && files.length) {
    for (const f of files) {
      if (typeof f === "string" && f.trim()) args.push(f.trim());
    }
  }
  if (extraFlags && typeof extraFlags === "string") {
    // Naive but adequate: split on whitespace, keep non-empty.
    for (const tok of extraFlags.split(/\s+/)) {
      if (tok) args.push(tok);
    }
  }
  return args;
}

async function handleAiderChat(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return writeJson(res, 400, { error: `Bad JSON: ${e.message}` }); }

  const prompt = (body.prompt || "").toString();
  if (!prompt.trim()) return writeJson(res, 400, { error: "Empty prompt" });

  const cwd = body.cwd ? String(body.cwd) : CODE_CWD;
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) throw new Error("cwd is not a directory");
  } catch (e) {
    return writeJson(res, 400, { error: `cwd not usable: ${e.message}` });
  }

  const bin = resolveAider();
  if (!bin) {
    return writeJson(res, 400, {
      error: "aider not installed. Install: pip install aider-chat",
    });
  }

  const model = (body.model || "").toString();
  const files = Array.isArray(body.files) ? body.files : [];
  const extraFlags = (body.extraFlags || "").toString();
  const args = buildAiderArgs({ model, prompt, files, extraFlags });

  const jobId = crypto.randomBytes(8).toString("hex");
  const abort = new AbortController();

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "X-Code-Job": jobId,
  });
  const emit = (obj) => res.write(JSON.stringify(obj) + "\n");
  emit({ kind: "meta", jobId, cwd, model, backend: "aider", bin, args });

  const child = spawn(bin, args, {
    cwd,
    env: {
      ...process.env,
      // Ensure aider sees Ollama if we're using a local model.
      OLLAMA_API_BASE: process.env.OLLAMA_API_BASE || OLLAMA_HOST,
      // Stable output (no progress spinners that confuse line-buffering).
      PYTHONUNBUFFERED: "1",
      NO_COLOR: "1",
      TERM: "dumb",
    },
    windowsHide: true,
  });
  aiderJobs.set(jobId, { child, abort });

  const killChild = () => {
    if (child.exitCode !== null) return;
    try { child.kill(IS_WIN ? undefined : "SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500).unref();
  };

  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
    if (child.exitCode === null) killChild();
    aiderJobs.delete(jobId);
  });
  abort.signal.addEventListener("abort", () => killChild(), { once: true });

  // Strip ANSI escape sequences just in case --no-pretty leaks something.
  const stripAnsi = (s) => s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "");

  // Forward each line as an assistant_text event so the existing chat
  // renderer shows it inline; aider doesn't speak tool-call JSON.
  const forward = (stream, kind) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += stripAnsi(chunk);
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== "" || kind === "assistant_text") {
          emit({ kind: "assistant_text", text: line + "\n" });
        }
      }
    });
    stream.on("end", () => {
      if (buf.length) emit({ kind: "assistant_text", text: buf });
    });
  };
  forward(child.stdout, "assistant_text");
  forward(child.stderr, "assistant_text");

  child.on("close", (code, sig) => {
    aiderJobs.delete(jobId);
    emit({
      kind: code === 0 ? "done" : "warning",
      message: code === 0
        ? `aider finished (exit 0)`
        : `aider exited with code ${code}${sig ? ` (signal ${sig})` : ""}`,
    });
    if (!res.writableEnded) {
      emit({ kind: "exit" });
      res.end();
    }
  });
  child.on("error", (err) => {
    aiderJobs.delete(jobId);
    emit({ kind: "error", message: `aider failed to launch: ${err.message}` });
    if (!res.writableEnded) {
      emit({ kind: "exit" });
      res.end();
    }
  });
}

async function handleAiderStop(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return writeJson(res, 400, { error: `Bad JSON: ${e.message}` }); }
  const jobId = (body.jobId || "").toString();
  const job = aiderJobs.get(jobId);
  if (!job) return writeJson(res, 404, { stopped: false, error: "Unknown jobId" });
  try { job.abort.abort(); }
  catch (e) { return writeJson(res, 500, { stopped: false, error: e.message }); }
  aiderJobs.delete(jobId);
  writeJson(res, 200, { stopped: true });
}

/* ----------------------------------------------------------
   FS browse: list a directory (or drives on Windows root)
   ---------------------------------------------------------- */
function listWindowsDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const root = `${letter}:\\`;
    try {
      // statSync is cheap on existing drives and throws on non-existent ones.
      fs.statSync(root);
      drives.push({ name: `${letter}:`, path: root, type: "drive" });
    } catch { /* skip */ }
  }
  return drives;
}

async function handleLocalCodeFsList(req, res) {
  const u = new URL(req.url, "http://x");
  const reqPath = u.searchParams.get("path") || "";
  const includeFiles = u.searchParams.get("files") === "1";
  const showHidden = u.searchParams.get("hidden") === "1";

  try {
    // Windows root: show drives instead of trying to list "/".
    if (IS_WIN && !reqPath) {
      const drives = listWindowsDrives();
      return writeJson(res, 200, {
        path: "",
        parent: null,
        isRoot: true,
        platform: process.platform,
        entries: drives,
      });
    }

    // Non-Windows or absolute path supplied.
    const abs = reqPath ? path.resolve(reqPath) : (IS_WIN ? "C:\\" : "/");
    let stat;
    try { stat = await fs.promises.stat(abs); }
    catch (e) {
      return writeJson(res, 200, {
        path: abs, parent: null, isRoot: false, platform: process.platform,
        entries: [], error: e.code === "ENOENT" ? "Path does not exist" : e.message,
      });
    }
    if (!stat.isDirectory()) {
      return writeJson(res, 400, { error: "Path is not a directory", path: abs });
    }

    let entries;
    try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); }
    catch (e) {
      return writeJson(res, 200, {
        path: abs, parent: null, isRoot: false, platform: process.platform,
        entries: [], error: e.code === "EACCES" ? "Permission denied" : e.message,
      });
    }

    const dirs = [];
    const files = [];
    for (const d of entries) {
      if (!showHidden && d.name.startsWith(".")) continue;
      const isDir = d.isDirectory();
      if (!isDir && !includeFiles) continue;
      const item = {
        name: d.name,
        path: path.join(abs, d.name),
        type: isDir ? "dir" : (d.isSymbolicLink() ? "symlink" : "file"),
      };
      if (!isDir) {
        try { item.size = (await fs.promises.stat(item.path)).size; }
        catch { /* skip size */ }
      }
      (isDir ? dirs : files).push(item);
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    // Parent: one level up; null if we're at a drive root on Windows.
    const parent = (() => {
      const up = path.dirname(abs);
      if (up === abs) return IS_WIN ? "" : null; // Windows: bubble to drive list
      return up;
    })();

    writeJson(res, 200, {
      path: abs,
      parent,
      isRoot: false,
      platform: process.platform,
      entries: [...dirs, ...files],
    });
  } catch (err) {
    writeJson(res, 500, { error: err.message });
  }
}

/* ----------------------------------------------------------
   Uploads: stream raw POST body into <targetRoot>/uploads/<safeName>
   ---------------------------------------------------------- */
function safeUploadFilename(raw) {
  let name = String(raw || "").trim();
  // Strip any path component the browser might have sent (some send full paths).
  name = name.replace(/^.*[\\/]/, "");
  // Disallow ".." just in case.
  if (!name || name === "." || name === "..") name = "upload";
  // Allow letters, digits, dot, dash, underscore, space, parentheses, brackets.
  name = name.replace(/[^\w.\-()\[\] ]+/g, "_");
  if (name.length > 200) name = name.slice(0, 200);
  return name;
}

async function ensureUniquePath(dir, baseName) {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  let candidate = baseName;
  let n = 1;
  while (true) {
    const full = path.join(dir, candidate);
    try {
      await fs.promises.stat(full);
      candidate = `${stem}-${n}${ext}`;
      n++;
    } catch { return full; }
  }
}

async function handleLocalCodeUpload(req, res) {
  const u = new URL(req.url, "http://x");
  const filenameRaw = u.searchParams.get("filename") || "upload.bin";
  const targetParam = u.searchParams.get("target") || "primary";
  // The client tells us which of its known roots to drop the file under.
  // We re-validate against the actual cwd + the user-supplied allowedDirs JSON
  // header to avoid trusting the query string alone for path containment.
  let cwd = CODE_CWD;
  let allowedDirs = [];
  let unrestrictedFs = false;
  try {
    const ctxJson = req.headers["x-code-context"];
    if (ctxJson) {
      const parsed = JSON.parse(Buffer.from(ctxJson, "base64").toString("utf8"));
      if (typeof parsed.cwd === "string" && parsed.cwd.trim()) cwd = parsed.cwd;
      if (Array.isArray(parsed.allowedDirs)) allowedDirs = parsed.allowedDirs.filter(s => typeof s === "string");
      if (parsed.unrestrictedFs === true) unrestrictedFs = true;
    }
  } catch { /* malformed header → fall back to defaults */ }

  // Resolve and validate cwd.
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) return writeJson(res, 400, { error: "cwd is not a directory" });
  } catch (e) { return writeJson(res, 400, { error: `cwd not usable: ${e.message}` }); }

  // Pick the target root: "primary" → cwd, "N" → allowedDirs[N], or an
  // absolute path that must match one of the roots.
  const roots = [path.resolve(cwd), ...allowedDirs.map(d => path.resolve(d))];
  let targetRoot;
  if (targetParam === "primary") {
    targetRoot = roots[0];
  } else if (/^\d+$/.test(targetParam)) {
    const idx = parseInt(targetParam, 10);
    if (idx < 0 || idx >= roots.length) return writeJson(res, 400, { error: `target index out of range: ${idx}` });
    targetRoot = roots[idx];
  } else {
    const abs = path.resolve(targetParam);
    // In unrestricted mode, any resolvable absolute path is OK as a target.
    if (!unrestrictedFs && !roots.some(r => abs === r || abs.startsWith(r + path.sep))) {
      return writeJson(res, 400, { error: "target is not inside an allowed root" });
    }
    targetRoot = abs;
  }

  // Ensure <targetRoot>/uploads/ exists.
  const uploadsDir = path.join(targetRoot, UPLOAD_SUBDIR);
  try { await fs.promises.mkdir(uploadsDir, { recursive: true }); }
  catch (e) { return writeJson(res, 500, { error: `mkdir failed: ${e.message}` }); }

  const safeName = safeUploadFilename(filenameRaw);
  const finalPath = await ensureUniquePath(uploadsDir, safeName);

  // Stream the raw body into the target file with a hard size cap.
  let total = 0;
  let aborted = false;
  const writeStream = fs.createWriteStream(finalPath);

  await new Promise((resolve) => {
    req.on("data", (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > UPLOAD_MAX_BYTES) {
        aborted = true;
        writeStream.destroy();
        // Drop the partial file.
        fs.promises.unlink(finalPath).catch(() => {});
        if (!res.headersSent) {
          writeJson(res, 413, { error: `Upload too large (>${UPLOAD_MAX_BYTES} bytes)` });
        }
        try { req.destroy(); } catch {}
        return resolve();
      }
      writeStream.write(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      writeStream.end(() => {
        const rel = path.relative(targetRoot, finalPath).replace(/\\/g, "/");
        writeJson(res, 200, {
          ok: true,
          name: path.basename(finalPath),
          path: finalPath,
          relPath: rel,
          targetRoot,
          bytes: total,
        });
        resolve();
      });
    });
    req.on("error", (err) => {
      if (aborted) return;
      aborted = true;
      writeStream.destroy();
      fs.promises.unlink(finalPath).catch(() => {});
      if (!res.headersSent) writeJson(res, 500, { error: `Upload failed: ${err.message}` });
      resolve();
    });
  });
}

async function handleLocalCodeStop(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return writeJson(res, 400, { error: `Bad JSON: ${e.message}` }); }
  const jobId = (body.jobId || "").toString();
  const job = codeJobs.get(jobId);
  if (!job) return writeJson(res, 404, { stopped: false, error: "Unknown jobId" });
  try { job.abort.abort(); }
  catch (e) { return writeJson(res, 500, { stopped: false, error: e.message }); }
  codeJobs.delete(jobId);
  writeJson(res, 200, { stopped: true });
}

/* ----------------------------------------------------------
   Router
   ---------------------------------------------------------- */
const server = http.createServer((req, res) => {
  const pathname = pathnameOf(req.url) || "/";

  // Tiny access log.
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(
      `${req.method.padEnd(4)} ${pathname.padEnd(28)} ${res.statusCode} ${ms}ms`
    );
  });

  if (pathname === "/local-code/check" && req.method === "GET") {
    handleLocalCodeCheck(req, res);
  } else if (pathname === "/local-code/chat" && req.method === "POST") {
    handleLocalCodeChat(req, res);
  } else if (pathname === "/local-code/stop" && req.method === "POST") {
    handleLocalCodeStop(req, res);
  } else if (pathname === "/local-code/verify-dirs" && req.method === "POST") {
    handleLocalCodeVerifyDirs(req, res);
  } else if (pathname === "/local-code/fs/list" && req.method === "GET") {
    handleLocalCodeFsList(req, res);
  } else if (pathname === "/local-code/upload" && req.method === "POST") {
    handleLocalCodeUpload(req, res);
  } else if (pathname === "/local-code/aider/check" && req.method === "GET") {
    handleAiderCheck(req, res);
  } else if (pathname === "/local-code/aider/chat" && req.method === "POST") {
    handleAiderChat(req, res);
  } else if (pathname === "/local-code/aider/stop" && req.method === "POST") {
    handleAiderStop(req, res);
  } else if (pathname.startsWith("/api/")) {
    proxyToOllama(req, res);
  } else if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
  } else {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
  }
});

server.listen(PORT, () => {
  console.log("");
  console.log("  Ollama Studio");
  console.log("  ─────────────");
  console.log(`  UI:     http://localhost:${PORT}`);
  console.log(`  Proxy:  /api/* → ${OLLAMA_HOST}`);
  console.log(`  Agent:  /local-code/* (cwd: ${CODE_CWD})`);
  console.log("");
  console.log("  Press Ctrl+C to stop.");
  console.log("");
});

// Graceful shutdown.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\nShutting down (${sig})…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
