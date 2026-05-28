#!/usr/bin/env node
/* ============================================================
   Ollama Studio — zero-dependency Node web server
   ------------------------------------------------------------
   - Serves the static UI (index.html, styles.css, app.js)
   - Proxies /api/* requests to the Ollama server, preserving
     streaming so token-by-token chat works.
   - Spawns the bundled claw-dev CLI for the Code section. All
     of claw-dev's Anthropic API traffic is routed through a
     local Anthropic↔Ollama compat proxy this file also hosts —
     so claw-dev's tools and agent loop run on local Ollama
     models, with no Anthropic API key required.

   Usage:
     node server.js                       # port 5500, ollama at :11434
     PORT=8080 node server.js
     OLLAMA_HOST=http://localhost:11434 node server.js
     PROXY_PORT=8789 node server.js       # claw-dev compat proxy port
   ============================================================ */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT, 10) || 5500;
const PROXY_PORT = parseInt(process.env.PROXY_PORT, 10) || 8789;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const ROOT = __dirname;

const IS_WIN = process.platform === "win32";
const CLAW_DEV_CLI = path.resolve(
  ROOT, "claw-dev-main", "Leonxlnx-claude-code", "package", "cli.js"
);
const CODE_CWD = process.env.CODE_CWD || path.resolve(ROOT, "..");

// In-flight claw-dev subprocess jobs keyed by jobId.
const clawJobs = new Map();

// The compat proxy doesn't know which Ollama model claw-dev was launched for —
// claw-dev sends `model: "claude-sonnet-4-6"` (or whatever) in /v1/messages,
// not an Ollama tag. We stash the user's chosen Ollama model here at /code/chat
// time so the proxy can rewrite the model before forwarding upstream.
// Single-tab single-job app, so a module-level slot is fine.
let currentOllamaModel = "";

function pathnameOf(reqUrl) {
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
  let pathname = decodeURIComponent(pathnameOf(req.url));
  if (pathname === "/" || pathname === "") pathname = "/index.html";

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

  req.pipe(upstream);

  res.on("close", () => {
    if (!res.writableEnded && !upstream.destroyed) {
      upstream.destroy();
    }
  });
}

/* ----------------------------------------------------------
   JSON body / response helpers
   ---------------------------------------------------------- */
function readJsonBody(req, maxBytes = 8_000_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
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

/* ----------------------------------------------------------
   /code/check — confirm claw-dev is reachable + report version
   ---------------------------------------------------------- */
function probeClawVersion() {
  if (!fs.existsSync(CLAW_DEV_CLI)) {
    return { available: false, error: `claw-dev CLI not found at ${CLAW_DEV_CLI}` };
  }
  try {
    const r = spawnSync(process.execPath, [CLAW_DEV_CLI, "--version"], {
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true,
    });
    const text = ((r.stdout || "") + (r.stderr || "")).trim();
    const version = (text.split(/\r?\n/, 1)[0] || "").trim() || "(unknown)";
    if (r.status !== 0 && !version) {
      return { available: false, error: `claw-dev exited ${r.status}: ${text.slice(0, 200)}` };
    }
    return { available: true, version, bin: CLAW_DEV_CLI };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

function handleCodeCheck(req, res) {
  const probe = probeClawVersion();
  writeJson(res, 200, {
    ...probe,
    cwd: CODE_CWD,
    platform: process.platform,
    proxyPort: PROXY_PORT,
    ollamaHost: OLLAMA_HOST,
  });
}

/* ----------------------------------------------------------
   /code/chat — POST { prompt, sessionId?, cwd?, resume?,
                       ollamaModel, allowedDirs? }
   ----------------------------------------------------------
   Spawns claw-dev with --print --output-format stream-json
   --include-partial-messages. ANTHROPIC_BASE_URL is pointed at
   the local compat proxy so all of claw-dev's API traffic
   becomes Ollama traffic.

   sessionId is a UUID maintained by the client per conversation.
   First turn uses --session-id to claim that ID; subsequent
   turns pass --resume <sessionId> to continue the session
   claw-dev persisted to disk last time.
   ---------------------------------------------------------- */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleCodeChat(req, res) {
  readJsonBody(req)
    .then((body) => runClawTurn(req, res, body))
    .catch((e) => writeJson(res, 400, { error: `Bad JSON: ${e.message}` }));
}

function runClawTurn(req, res, body) {
  const prompt = (body.prompt || "").toString();
  if (!prompt.trim()) return writeJson(res, 400, { error: "Empty prompt" });

  if (!fs.existsSync(CLAW_DEV_CLI)) {
    return writeJson(res, 400, {
      error: `claw-dev CLI missing at ${CLAW_DEV_CLI}`,
    });
  }

  const ollamaModel = (body.ollamaModel || "").toString().trim();
  if (!ollamaModel) {
    return writeJson(res, 400, {
      error: "ollamaModel is required (pick a model in the topbar)",
    });
  }

  const cwd = body.cwd ? String(body.cwd) : CODE_CWD;
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) throw new Error("cwd is not a directory");
  } catch (e) {
    return writeJson(res, 400, { error: `cwd not usable: ${e.message}` });
  }

  // Validate allowedDirs — claw-dev will accept them via --add-dir.
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
    if (abs !== path.resolve(cwd) && !allowedDirs.includes(abs)) allowedDirs.push(abs);
  }

  const sessionId = (body.sessionId || "").toString();
  if (sessionId && !UUID_RE.test(sessionId)) {
    return writeJson(res, 400, { error: "sessionId must be a UUID" });
  }
  const resume = body.resume === true;

  // Make the model visible to the compat proxy before we spawn claw-dev.
  // claw-dev's first /v1/messages call may fire within milliseconds of spawn
  // so the assignment has to happen before the spawn() call below.
  currentOllamaModel = ollamaModel;

  const args = [
    CLAW_DEV_CLI,
    "--print",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    // --dangerously-skip-permissions lets the agent edit files without
    // a per-call approval prompt; safe enough for a single-user local app.
    "--dangerously-skip-permissions",
  ];
  for (const d of allowedDirs) args.push("--add-dir", d);
  if (sessionId && resume) {
    args.push("--resume", sessionId);
  } else if (sessionId) {
    args.push("--session-id", sessionId);
  }
  args.push(prompt);

  const jobId = crypto.randomBytes(8).toString("hex");

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "X-Code-Job": jobId,
  });
  const emit = (obj) => {
    if (res.writableEnded) return;
    res.write(JSON.stringify(obj) + "\n");
  };
  emit({
    kind: "meta",
    jobId, cwd, sessionId: sessionId || null, resume,
    ollamaModel, allowedDirs,
    proxyUrl: `http://127.0.0.1:${PROXY_PORT}`,
  });

  // Build child env: route Anthropic traffic to our compat proxy, override
  // any real Anthropic credentials with a stub key so claw-dev (a) treats
  // itself as "logged in" and (b) can't accidentally bill the user's real
  // account, and hand the picked Ollama model + host through so the proxy
  // can use them.
  //
  // IMPORTANT: claw-dev's auth check (apiKeySource) looks for
  // ANTHROPIC_API_KEY first. If absent, it exits with "Not logged in" and
  // never even hits ANTHROPIC_BASE_URL. We MUST set the env var to
  // something non-empty even though our compat proxy ignores it.
  const childEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    TERM: "dumb",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${PROXY_PORT}`,
    ANTHROPIC_API_KEY: "sk-ollama-proxy-stub",   // dummy, never sent upstream
    ANTHROPIC_AUTH_TOKEN: "ollama-proxy",
    OLLAMA_BASE_URL: OLLAMA_HOST,
    OLLAMA_MODEL: ollamaModel,
    CLAUDE_CODE_DISABLE_TELEMETRY: "1",
  };
  // Strip any OAuth token from the parent env so we don't pick up the
  // user's logged-in identity by accident.
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

  const child = spawn(process.execPath, args, {
    cwd,
    env: childEnv,
    windowsHide: true,
    // stdin: ignore — claw-dev otherwise waits ~3s for piped input.
    stdio: ["ignore", "pipe", "pipe"],
  });
  clawJobs.set(jobId, { child });

  const killChild = () => {
    if (child.exitCode !== null) return;
    try { child.kill(IS_WIN ? undefined : "SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500).unref();
  };

  res.on("close", () => {
    if (!res.writableEnded && child.exitCode === null) killChild();
    clawJobs.delete(jobId);
  });

  let stdoutBuf = "";
  // Track whether claw-dev already streamed a structured error to stdout
  // (e.g. {type:"result", is_error:true, result:"API Error: 400 ..."}). If
  // so, the real error is rendered separately as a result block — skip the
  // bare "exited with code N (no stderr output)" wrapper on close so the
  // user doesn't see a useless second error below the real one.
  let sawStreamError = false;
  const trackAndForward = (evt) => {
    if (evt && evt.type === "result" && evt.is_error === true) {
      sawStreamError = true;
    }
    forwardClawEvent(emit, evt);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      trackAndForward(evt);
    }
  });

  // Buffer ALL of claw-dev's stderr so we can dump it as one block on
  // non-zero exit. Emitting line-by-line as warnings made it look like
  // chat and the actual failure was easy to miss.
  let stderrAccum = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrAccum += chunk;
  });

  // Models with weak tool-call support tend to make claw-dev exit non-zero
  // because the compat proxy returns content blocks without the
  // tool_use shape claw-dev's agent loop requires. Surfacing this as a
  // hint saves a debugging round-trip.
  const WEAK_MODEL_PATTERNS = [
    /^llama3(\.2)?(:1b)?(?::|$)/i,    // llama3.2, llama3.2:1b
    /^phi[123]/i,                      // phi-1/2/3 chat models
    /^gemma[12]?(:2b)?$/i,             // gemma:2b etc.
    /^tinyllama/i,
    /^smollm(?!2)/i,                   // smollm (non-2)
  ];
  const looksWeak = WEAK_MODEL_PATTERNS.some((re) => re.test(ollamaModel || ""));

  child.on("close", (code, sig) => {
    clawJobs.delete(jobId);
    if (stdoutBuf.trim()) {
      try {
        const evt = JSON.parse(stdoutBuf.trim());
        trackAndForward(evt);
      } catch { /* ignore tail */ }
      stdoutBuf = "";
    }
    if (code === 0) {
      // On clean exit there's rarely anything interesting on stderr;
      // emit it as a low-key warning only if non-empty.
      const trimmed = stderrAccum.trim();
      if (trimmed) emit({ kind: "warning", message: "[claw-dev stderr]\n" + trimmed });
      emit({ kind: "done", message: "claw-dev finished (exit 0)" });
    } else {
      // Non-zero exit. Three cases:
      //  1. stderr has content → dump it as the error block.
      //  2. stderr is empty but claw-dev already streamed an is_error
      //     result to stdout (rendered separately as a result block) →
      //     skip the wrapper; a second, vaguer error just adds noise.
      //  3. truly no info anywhere → emit the bare wrapper as a last resort.
      const trimmed = stderrAccum.trim();
      const exitInfo = `claw-dev exited with code ${code}${sig ? ` (signal ${sig})` : ""}`;
      if (trimmed) {
        emit({
          kind: "error",
          message: `${exitInfo}\n\n--- claw-dev stderr ---\n${trimmed}\n--- end stderr ---`,
        });
      } else if (!sawStreamError) {
        emit({ kind: "error", message: `${exitInfo} (no stderr output)` });
      }
      if (looksWeak) {
        emit({
          kind: "warning",
          message:
            `Model hint: "${ollamaModel}" is light on tool-call support. ` +
            `claw-dev needs a model that reliably emits tool_use blocks. Try ` +
            `qwen2.5-coder:7b, llama3.1:8b, or mistral-nemo from the Models tab.`,
        });
      }
    }
    if (!res.writableEnded) {
      emit({ kind: "exit" });
      res.end();
    }
  });

  child.on("error", (err) => {
    clawJobs.delete(jobId);
    emit({ kind: "error", message: `claw-dev failed to launch: ${err.message}` });
    if (!res.writableEnded) {
      emit({ kind: "exit" });
      res.end();
    }
  });
}

function forwardClawEvent(emit, evt) {
  if (!evt || typeof evt !== "object") return;

  if (evt.type === "stream_event") {
    const inner = evt.event || {};
    if (inner.type === "content_block_delta" && inner.delta) {
      const d = inner.delta;
      if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
        emit({ kind: "text_delta", text: d.text });
      } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
        emit({ kind: "tool_input_delta", index: inner.index, partial: d.partial_json });
      }
      return;
    }
    if (inner.type === "content_block_start" && inner.content_block) {
      const cb = inner.content_block;
      if (cb.type === "tool_use") {
        emit({ kind: "tool_use", id: cb.id, name: cb.name, input: cb.input || {} });
      }
      return;
    }
    if (inner.type === "message_start" || inner.type === "message_stop") {
      return;
    }
    return;
  }

  if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        emit({ kind: "assistant_text", text: block.text });
      } else if (block.type === "tool_use") {
        emit({ kind: "tool_use", id: block.id, name: block.name, input: block.input || {} });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        emit({ kind: "thinking", text: block.thinking });
      }
    }
    return;
  }

  if (evt.type === "user" && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_result") {
        const out = Array.isArray(block.content)
          ? block.content.map((c) => (c && c.type === "text" ? c.text : "")).join("\n")
          : (typeof block.content === "string" ? block.content : "");
        emit({
          kind: "tool_result",
          id: block.tool_use_id,
          output: out,
          isError: block.is_error === true,
        });
      }
    }
    return;
  }

  if (evt.type === "result") {
    emit({
      kind: "result",
      result: typeof evt.result === "string" ? evt.result : "",
      durationMs: evt.duration_ms || 0,
      totalCostUsd: evt.total_cost_usd || 0,
      usage: evt.usage || null,
      isError: evt.is_error === true,
    });
    return;
  }

  if (evt.type === "system" && evt.subtype === "init") {
    emit({
      kind: "system_init",
      sessionId: evt.session_id || null,
      model: evt.model || null,
      tools: Array.isArray(evt.tools) ? evt.tools : [],
    });
    return;
  }

  emit({ kind: "debug", event: evt });
}

function handleCodeStop(req, res) {
  readJsonBody(req).then((body) => {
    const jobId = (body.jobId || "").toString();
    const job = clawJobs.get(jobId);
    if (!job) return writeJson(res, 404, { stopped: false, error: "Unknown jobId" });
    try {
      if (job.child.exitCode === null) {
        job.child.kill(IS_WIN ? undefined : "SIGTERM");
        setTimeout(() => { try { job.child.kill("SIGKILL"); } catch {} }, 1500).unref();
      }
    } catch (e) {
      return writeJson(res, 500, { stopped: false, error: e.message });
    }
    clawJobs.delete(jobId);
    writeJson(res, 200, { stopped: true });
  }).catch((e) => writeJson(res, 400, { error: `Bad JSON: ${e.message}` }));
}

/* ----------------------------------------------------------
   /code/fs/list — directory listing for the picker UI
   ---------------------------------------------------------- */
function listWindowsDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const root = `${letter}:\\`;
    try {
      fs.statSync(root);
      drives.push({ name: `${letter}:`, path: root, type: "drive" });
    } catch { /* skip */ }
  }
  return drives;
}

async function handleCodeFsList(req, res) {
  const u = new URL(req.url, "http://x");
  const reqPath = u.searchParams.get("path") || "";
  const showHidden = u.searchParams.get("hidden") === "1";

  try {
    if (IS_WIN && !reqPath) {
      const drives = listWindowsDrives();
      return writeJson(res, 200, {
        path: "", parent: null, isRoot: true, platform: process.platform,
        entries: drives,
      });
    }

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
    for (const d of entries) {
      if (!showHidden && d.name.startsWith(".")) continue;
      if (!d.isDirectory()) continue;
      dirs.push({
        name: d.name,
        path: path.join(abs, d.name),
        type: "dir",
      });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    const parent = (() => {
      const up = path.dirname(abs);
      if (up === abs) return IS_WIN ? "" : null;
      return up;
    })();

    writeJson(res, 200, {
      path: abs, parent, isRoot: false, platform: process.platform,
      entries: dirs,
    });
  } catch (err) {
    writeJson(res, 500, { error: err.message });
  }
}

/* ============================================================
   Anthropic ↔ Ollama compat proxy (port PROXY_PORT, default 8789)
   ------------------------------------------------------------
   claw-dev talks to Anthropic's /v1/messages API. This proxy
   pretends to be that API: it receives Anthropic-shape requests,
   translates them to Ollama /api/chat calls, then re-streams
   the Ollama NDJSON as Anthropic SSE events.

   Only the subset of /v1/messages claw-dev exercises is
   implemented: streaming, system prompts, tool_use, tool_result.
   ============================================================ */

function anthropicToOllamaBody(req) {
  const messages = [];

  // System prompt: Anthropic accepts a string OR an array of {type:"text",text}.
  if (req.system) {
    const sys = typeof req.system === "string"
      ? req.system
      : Array.isArray(req.system)
        ? req.system
            .map((s) => (typeof s === "string" ? s : (s && s.text) || ""))
            .filter(Boolean).join("\n\n")
        : "";
    if (sys.trim()) messages.push({ role: "system", content: sys });
  }

  for (const m of req.messages || []) {
    const role = m.role;
    if (typeof m.content === "string") {
      messages.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    if (role === "user") {
      const textParts = [];
      const toolResults = [];
      for (const block of m.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") {
          textParts.push(block.text || "");
        } else if (block.type === "tool_result") {
          const content = Array.isArray(block.content)
            ? block.content
                .map((c) => (c && c.type === "text" ? c.text : ""))
                .filter(Boolean).join("\n")
            : (typeof block.content === "string" ? block.content : "");
          toolResults.push({
            tool_use_id: block.tool_use_id,
            content,
            is_error: block.is_error === true,
          });
        }
        // image blocks etc. are intentionally skipped — Ollama text models
        // won't understand them, and the chat would just confuse the agent.
      }
      // Emit text first (if any) then one role:"tool" message per tool_result.
      // Ollama's /api/chat expects tool messages with tool_call_id (newer
      // versions) — older builds tolerate just role:"tool" + content. We send
      // both so it works either way.
      if (textParts.length > 0) {
        messages.push({ role: "user", content: textParts.join("\n\n") });
      }
      for (const tr of toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: tr.is_error ? `[error] ${tr.content}` : tr.content,
        });
      }
    } else if (role === "assistant") {
      const textParts = [];
      const toolCalls = [];
      for (const block of m.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") {
          textParts.push(block.text || "");
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: block.input || {},
            },
          });
        }
        // skip thinking blocks
      }
      const msg = { role: "assistant", content: textParts.join("\n\n") };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }

  const tools = Array.isArray(req.tools) ? req.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  })) : undefined;

  return {
    model: currentOllamaModel,
    messages,
    tools: tools && tools.length ? tools : undefined,
    stream: true,
    options: {
      // claw-dev sets max_tokens fairly high; pass through if present.
      num_predict: typeof req.max_tokens === "number" ? req.max_tokens : -1,
      temperature: typeof req.temperature === "number" ? req.temperature : 0.7,
    },
    keep_alive: "30m",
  };
}

function emitSSE(res, eventType, data) {
  if (res.writableEnded) return;
  res.write(`event: ${eventType}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function ollamaChatRequest(body) {
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
    const req = proxyAgent.request(opts, (resp) => resolve(resp));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function handleAnthropicMessages(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: e.message } }));
  }

  if (!currentOllamaModel) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "No Ollama model selected. Pick one in the Ollama Studio topbar first.",
      },
    }));
  }

  const wantStream = body.stream === true;
  const originalModel = body.model || "claude-sonnet-4-6";
  const ollamaBody = anthropicToOllamaBody(body);

  if (!wantStream) {
    // claw-dev always streams, but support the non-streaming path for
    // robustness so the proxy is honest about /v1/messages.
    try {
      const collected = await collectOllamaResponse(ollamaBody);
      const msg = buildAnthropicMessageObject(collected, originalModel);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(msg));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
    }
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  await streamOllamaAsAnthropicSSE(res, ollamaBody, originalModel);
  res.end();
}

function buildAnthropicMessageObject(collected, originalModel) {
  const content = [];
  if (collected.text) content.push({ type: "text", text: collected.text });
  for (const tc of collected.toolCalls) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.input,
    });
  }
  return {
    id: "msg_" + crypto.randomBytes(12).toString("hex"),
    type: "message",
    role: "assistant",
    model: originalModel,
    content,
    stop_reason: collected.toolCalls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: collected.promptTokens,
      output_tokens: collected.evalTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

async function collectOllamaResponse(body) {
  const resp = await ollamaChatRequest({ ...body, stream: false });
  const buf = await new Promise((resolve, reject) => {
    let s = "";
    resp.setEncoding("utf8");
    resp.on("data", (c) => { s += c; });
    resp.on("end", () => resolve(s));
    resp.on("error", reject);
  });
  let obj;
  try { obj = JSON.parse(buf); }
  catch (e) { throw new Error(`Ollama returned non-JSON: ${buf.slice(0, 200)}`); }
  if (resp.statusCode >= 400) throw new Error(obj.error || `HTTP ${resp.statusCode}`);
  const msg = obj.message || {};
  const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((tc) => {
    let args = tc.function?.arguments || {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = { _raw: args }; }
    }
    return {
      id: tc.id || ("toolu_" + crypto.randomBytes(12).toString("hex")),
      name: tc.function?.name || "",
      input: args,
    };
  });
  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCalls,
    promptTokens: obj.prompt_eval_count || 0,
    evalTokens: obj.eval_count || 0,
  };
}

async function streamOllamaAsAnthropicSSE(res, ollamaBody, originalModel) {
  const messageId = "msg_" + crypto.randomBytes(12).toString("hex");
  let outputTokens = 0;
  let inputTokens = 0;
  let blockIndex = -1;
  let currentBlockType = null;   // "text" | null  (tool_use blocks open and close in one tick)
  let stopReason = "end_turn";

  emitSSE(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: originalModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      },
    },
  });

  // Periodic "ping" comments keep idle connections alive when the model
  // takes a while to start producing tokens.
  const pinger = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15_000);
  pinger.unref?.();

  let resp;
  try {
    resp = await ollamaChatRequest(ollamaBody);
  } catch (err) {
    clearInterval(pinger);
    emitSSE(res, "error", {
      type: "error",
      error: { type: "api_error", message: `Ollama request failed: ${err.message}` },
    });
    return;
  }

  if (resp.statusCode >= 400) {
    let errBody = "";
    resp.setEncoding("utf8");
    resp.on("data", (c) => { errBody += c; });
    await new Promise((r) => resp.on("end", r));
    clearInterval(pinger);
    let parsed;
    try { parsed = JSON.parse(errBody); } catch { /* leave string */ }
    const msg = (parsed && parsed.error) || errBody || `Ollama HTTP ${resp.statusCode}`;
    emitSSE(res, "error", {
      type: "error",
      error: { type: "api_error", message: msg },
    });
    return;
  }

  const openTextBlock = () => {
    if (currentBlockType === "text") return;
    blockIndex++;
    currentBlockType = "text";
    emitSSE(res, "content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" },
    });
  };
  const closeCurrentBlock = () => {
    if (currentBlockType === null) return;
    emitSSE(res, "content_block_stop", { type: "content_block_stop", index: blockIndex });
    currentBlockType = null;
  };
  const emitToolUseBlock = (tc) => {
    closeCurrentBlock();
    blockIndex++;
    const id = tc.id || ("toolu_" + crypto.randomBytes(12).toString("hex"));
    const name = tc.function?.name || tc.name || "";
    let args = tc.function?.arguments ?? tc.input ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = { _raw: args }; }
    }
    emitSSE(res, "content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "tool_use", id, name, input: {} },
    });
    emitSSE(res, "content_block_delta", {
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
    });
    emitSSE(res, "content_block_stop", { type: "content_block_stop", index: blockIndex });
    currentBlockType = null;
    stopReason = "tool_use";
  };

  resp.setEncoding("utf8");
  let buf = "";

  const aborted = { v: false };
  res.on("close", () => {
    if (!res.writableEnded) {
      aborted.v = true;
      resp.destroy();
    }
  });

  await new Promise((resolve) => {
    resp.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.error) {
          emitSSE(res, "error", {
            type: "error",
            error: { type: "api_error", message: String(obj.error) },
          });
          continue;
        }
        const msg = obj.message || {};
        const text = typeof msg.content === "string" ? msg.content : "";
        if (text) {
          openTextBlock();
          emitSSE(res, "content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text },
          });
        }
        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        for (const tc of toolCalls) emitToolUseBlock(tc);

        if (obj.done) {
          outputTokens = obj.eval_count || outputTokens;
          inputTokens = obj.prompt_eval_count || inputTokens;
        }
      }
    });
    resp.on("end", resolve);
    resp.on("error", () => resolve());
  });

  clearInterval(pinger);
  if (aborted.v) return;

  closeCurrentBlock();

  emitSSE(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
  emitSSE(res, "message_stop", { type: "message_stop" });
}

function handleProxyHealth(req, res) {
  // Format matches what the claw-dev launcher's isHealthyProxy() looks for:
  // strings `"provider":"ollama"` and `"model":"<model>"`.
  writeJson(res, 200, {
    ok: true,
    provider: "ollama",
    model: currentOllamaModel || "(unset)",
    ollamaHost: OLLAMA_HOST,
  });
}

const compatProxy = http.createServer((req, res) => {
  const pathname = pathnameOf(req.url) || "/";
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(
      `[proxy] ${req.method.padEnd(4)} ${pathname.padEnd(28)} ${res.statusCode} ${ms}ms`
    );
  });

  if (pathname === "/health" && req.method === "GET") {
    handleProxyHealth(req, res);
  } else if (req.method === "HEAD" && (pathname === "/" || pathname === "/v1" || pathname === "/v1/")) {
    // Anthropic SDK pings the base URL at startup to verify reachability.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end();
  } else if ((pathname === "/v1/messages" || pathname === "/messages") && req.method === "POST") {
    handleAnthropicMessages(req, res);
  } else if (pathname === "/v1/models" && req.method === "GET") {
    // Some SDKs probe /v1/models on init; return a minimal shape so the
    // Anthropic SDK doesn't error out before sending /v1/messages.
    writeJson(res, 200, {
      data: [{ id: "claude-sonnet-4-6", display_name: "Ollama via Compat", created_at: new Date().toISOString(), type: "model" }],
      has_more: false,
      first_id: "claude-sonnet-4-6",
      last_id: "claude-sonnet-4-6",
    });
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "not_found_error", message: `No such endpoint: ${pathname}` },
    }));
  }
});

/* ----------------------------------------------------------
   Router (main UI server on PORT)
   ---------------------------------------------------------- */
const server = http.createServer((req, res) => {
  const pathname = pathnameOf(req.url) || "/";

  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(
      `${req.method.padEnd(4)} ${pathname.padEnd(28)} ${res.statusCode} ${ms}ms`
    );
  });

  if (pathname === "/code/check" && req.method === "GET") {
    handleCodeCheck(req, res);
  } else if (pathname === "/code/chat" && req.method === "POST") {
    handleCodeChat(req, res);
  } else if (pathname === "/code/stop" && req.method === "POST") {
    handleCodeStop(req, res);
  } else if (pathname === "/code/fs/list" && req.method === "GET") {
    handleCodeFsList(req, res);
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
  console.log(`  UI:        http://localhost:${PORT}`);
  console.log(`  Ollama:    /api/* → ${OLLAMA_HOST}`);
  console.log(`  claw-dev:  ${CLAW_DEV_CLI}`);
  console.log(`  Code cwd:  ${CODE_CWD}`);
  console.log("");
});

compatProxy.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`  Compat:    http://127.0.0.1:${PROXY_PORT}  (Anthropic→Ollama for claw-dev)`);
  console.log("");
  console.log("  Press Ctrl+C to stop.");
  console.log("");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\nShutting down (${sig})…`);
    server.close(() => {});
    compatProxy.close(() => {});
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
