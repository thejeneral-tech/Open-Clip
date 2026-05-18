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

// Hard caps so a runaway model loop can't hammer the filesystem forever.
const AGENT_MAX_ITERS = 24;
const AGENT_FILE_READ_BYTES = 256 * 1024;     // 256 KB per read
const AGENT_BASH_TIMEOUT_MS = 60_000;
const AGENT_BASH_OUTPUT_BYTES = 64 * 1024;     // 64 KB per bash output

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

// Path containment: resolve `p` relative to cwd and refuse if it escapes.
function resolveInside(cwd, p) {
  if (typeof p !== "string" || !p) throw new Error("Path required");
  const abs = path.resolve(cwd, p);
  const cwdAbs = path.resolve(cwd);
  // Ensure abs === cwdAbs or starts with cwdAbs + sep.
  if (abs !== cwdAbs && !abs.startsWith(cwdAbs + path.sep)) {
    throw new Error(`Path escapes working directory: ${p}`);
  }
  return abs;
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

async function tool_read_file(cwd, args) {
  const abs = resolveInside(cwd, args.path);
  const stat = await fs.promises.stat(abs);
  if (!stat.isFile()) throw new Error("Not a file");
  if (stat.size > AGENT_FILE_READ_BYTES * 8) {
    // Even reading a 2 MB file fully into memory is OK, but warn the model.
  }
  let content = await fs.promises.readFile(abs, "utf8");
  if (typeof args.offset === "number" || typeof args.limit === "number") {
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, args.offset || 0);
    const end = typeof args.limit === "number" ? start + args.limit : lines.length;
    content = lines.slice(start, end).join("\n");
  }
  return { content: trimOutput(content, AGENT_FILE_READ_BYTES), bytes: stat.size };
}

async function tool_write_file(cwd, args) {
  const abs = resolveInside(cwd, args.path);
  await fs.promises.writeFile(abs, String(args.content ?? ""), "utf8");
  const stat = await fs.promises.stat(abs);
  return { ok: true, path: args.path, bytes: stat.size };
}

async function tool_edit_file(cwd, args) {
  const abs = resolveInside(cwd, args.path);
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

async function tool_list_dir(cwd, args) {
  const abs = resolveInside(cwd, args.path || ".");
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

async function walkFiles(cwd, max, filter) {
  const out = [];
  const stack = [cwd];
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
        const rel = path.relative(cwd, full).replace(/\\/g, "/");
        if (!filter || filter(rel)) {
          out.push(rel);
          if (out.length >= max) break;
        }
      }
    }
  }
  return out;
}

async function tool_glob(cwd, args) {
  const re = globToRegex(args.pattern);
  const matches = await walkFiles(cwd, 200, (rel) => re.test(rel));
  return { pattern: args.pattern, count: matches.length, paths: matches };
}

async function tool_grep(cwd, args) {
  const pattern = String(args.pattern || "");
  if (!pattern) throw new Error("pattern is required");
  let re;
  try { re = new RegExp(pattern); }
  catch (e) { throw new Error(`Bad regex: ${e.message}`); }

  const searchRoot = args.path ? resolveInside(cwd, args.path) : cwd;
  const stat = await fs.promises.stat(searchRoot);
  const fileFilter = args.glob ? globToRegex(args.glob) : null;

  let files;
  if (stat.isFile()) {
    files = [path.relative(cwd, searchRoot).replace(/\\/g, "/")];
  } else {
    files = await walkFiles(searchRoot, 2000, (rel) => !fileFilter || fileFilter(path.basename(rel)));
  }

  const hits = [];
  for (const rel of files) {
    const abs = path.join(stat.isFile() ? cwd : searchRoot, rel);
    let content;
    try { content = await fs.promises.readFile(abs, "utf8"); }
    catch { continue; }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push(`${rel}:${i + 1}: ${lines[i]}`);
        if (hits.length >= 200) break;
      }
    }
    if (hits.length >= 200) break;
  }
  return { pattern, count: hits.length, hits };
}

function tool_bash(cwd, args, signal) {
  return new Promise((resolve) => {
    const command = String(args.command || "");
    if (!command.trim()) return resolve({ ok: false, error: "Empty command" });

    const child = spawn(command, {
      cwd,
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

async function executeTool(name, args, cwd, signal) {
  const safeArgs = args && typeof args === "object" ? args : {};
  switch (name) {
    case "read_file": return tool_read_file(cwd, safeArgs);
    case "write_file": return tool_write_file(cwd, safeArgs);
    case "edit_file": return tool_edit_file(cwd, safeArgs);
    case "list_dir": return tool_list_dir(cwd, safeArgs);
    case "glob": return tool_glob(cwd, safeArgs);
    case "grep": return tool_grep(cwd, safeArgs);
    case "bash": return tool_bash(cwd, safeArgs, signal);
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

function defaultCodeSystemPrompt(cwd) {
  return [
    "You are a coding agent operating inside a local project directory.",
    `Working directory: ${cwd}`,
    "",
    "You have these tools available:",
    "  • read_file(path, offset?, limit?)  — read a text file",
    "  • write_file(path, content)         — create or overwrite a file",
    "  • edit_file(path, old_string, new_string) — replace one unique substring",
    "  • list_dir(path)                    — list a directory",
    "  • glob(pattern)                     — find files (e.g. '**/*.ts')",
    "  • grep(pattern, path?, glob?)       — regex search file contents",
    "  • bash(command)                     — run a shell command (60s timeout)",
    "",
    "Guidelines:",
    "  – Prefer reading a file before editing it.",
    "  – edit_file requires old_string to be unique; include surrounding context.",
    "  – Keep responses concise. After completing the task, summarise what changed in one sentence.",
    "  – If the user's request is ambiguous, ask one clarifying question instead of guessing.",
  ].join("\n");
}

async function handleLocalCodeChat(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return writeJson(res, 400, { error: `Bad JSON: ${e.message}` }); }

  const prompt = (body.prompt || "").toString();
  const model = (body.model || "").toString();
  const cwd = body.cwd ? String(body.cwd) : CODE_CWD;
  const history = Array.isArray(body.history) ? body.history : [];
  const systemPrompt = (body.systemPrompt || "").trim() || defaultCodeSystemPrompt(cwd);

  if (!prompt.trim()) return writeJson(res, 400, { error: "Empty prompt" });
  if (!model) return writeJson(res, 400, { error: "model is required" });

  // Validate cwd exists.
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) throw new Error("cwd is not a directory");
  } catch (e) {
    return writeJson(res, 400, { error: `cwd not usable: ${e.message}` });
  }

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
  emit({ kind: "meta", jobId, cwd, model, toolCapable: isToolCapable(model) });

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
        resp = await ollamaPost("/api/chat", {
          model,
          messages,
          tools: AGENT_TOOLS,
          stream: false,
          options: body.options || {},
        }, abort.signal);
      } catch (err) {
        emit({ kind: "error", message: `Ollama request failed: ${err.message}` });
        break;
      }

      const msg = resp.message || {};
      // Push the assistant message into history before we even render it,
      // so tool replies have the right shape on the next turn.
      messages.push({
        role: "assistant",
        content: msg.content || "",
        tool_calls: msg.tool_calls,
      });

      if (msg.content) {
        emit({ kind: "assistant_text", text: msg.content });
      }

      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
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
          result = await executeTool(name, toolArgs, cwd, abort.signal);
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
