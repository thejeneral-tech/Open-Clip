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

// Claude Code subprocess works in the parent project (Trend Vault folder).
const CLAUDE_CWD = process.env.CLAUDE_CWD || path.resolve(ROOT, "..");
const IS_WIN = process.platform === "win32";

// In-flight Claude Code jobs keyed by jobId.
const claudeJobs = new Map();

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
   Claude Code subprocess integration
   ---------------------------------------------------------- */
function resolveClaudeBin() {
  // Respect explicit override.
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) {
    return process.env.CLAUDE_BIN;
  }
  // Otherwise rely on PATH; spawn with shell:true so .cmd shims resolve on Windows.
  return "claude";
}

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

function handleClaudeCheck(req, res) {
  const bin = resolveClaudeBin();
  // `claude --version` exits 0 with a version string when installed.
  const probe = spawnSync(bin, ["--version"], {
    shell: IS_WIN,
    timeout: 6000,
    encoding: "utf8",
  });
  const available = probe.status === 0;
  writeJson(res, 200, {
    available,
    bin,
    version: available ? (probe.stdout || "").trim() : null,
    error: available ? null : (probe.stderr || probe.error?.message || "claude not found").trim(),
    cwd: CLAUDE_CWD,
    platform: process.platform,
  });
}

async function handleClaudeChat(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return writeJson(res, 400, { error: `Bad JSON: ${e.message}` }); }

  const prompt = (body.prompt || "").toString();
  const sessionId = body.sessionId ? String(body.sessionId) : null;
  const permissionMode = body.permissionMode || "bypassPermissions";
  const cwd = body.cwd ? String(body.cwd) : CLAUDE_CWD;

  if (!prompt.trim()) return writeJson(res, 400, { error: "Empty prompt" });

  // Prompt is piped via stdin (no -p arg) so it can't be misparsed as shell
  // metacharacters even when shell:true is needed for .cmd resolution on Windows.
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", permissionMode,
  ];
  if (sessionId) args.push("--resume", sessionId);

  const bin = resolveClaudeBin();
  const jobId = crypto.randomBytes(8).toString("hex");

  let child;
  try {
    child = spawn(bin, args, {
      cwd,
      shell: IS_WIN,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
      windowsHide: true,
    });
    child.stdin.write(prompt);
    child.stdin.end();
  } catch (err) {
    return writeJson(res, 500, { error: `spawn failed: ${err.message}` });
  }

  claudeJobs.set(jobId, child);

  // NDJSON streaming response — one envelope per line.
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "X-Claude-Job": jobId,
  });
  res.write(JSON.stringify({ kind: "meta", jobId, cwd, bin }) + "\n");

  // Forward stdout line-by-line; each line is one stream-json event from claude.
  let stdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { /* keep raw */ }
      const env = parsed
        ? { kind: "event", event: parsed }
        : { kind: "raw", line };
      res.write(JSON.stringify(env) + "\n");
    }
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrBuf += text;
    // Forward stderr in chunks so the UI can show progress / warnings.
    res.write(JSON.stringify({ kind: "stderr", data: text }) + "\n");
  });

  const cleanup = () => {
    claudeJobs.delete(jobId);
  };

  child.on("error", (err) => {
    res.write(JSON.stringify({ kind: "error", message: err.message }) + "\n");
  });

  child.on("close", (code, signal) => {
    // Flush any trailing partial line.
    if (stdoutBuf.trim()) {
      let parsed = null;
      try { parsed = JSON.parse(stdoutBuf.trim()); } catch {}
      res.write(JSON.stringify(parsed
        ? { kind: "event", event: parsed }
        : { kind: "raw", line: stdoutBuf.trim() }) + "\n");
      stdoutBuf = "";
    }
    res.write(JSON.stringify({
      kind: "exit",
      code,
      signal,
      stderr: stderrBuf.slice(-2000),
    }) + "\n");
    res.end();
    cleanup();
  });

  // Client disconnected — kill the subprocess.
  res.on("close", () => {
    if (!child.killed) {
      try { child.kill(IS_WIN ? undefined : "SIGTERM"); } catch {}
    }
    cleanup();
  });
}

async function handleClaudeStop(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return writeJson(res, 400, { error: `Bad JSON: ${e.message}` }); }
  const jobId = (body.jobId || "").toString();
  const child = claudeJobs.get(jobId);
  if (!child) return writeJson(res, 404, { stopped: false, error: "Unknown jobId" });
  try { child.kill(IS_WIN ? undefined : "SIGTERM"); }
  catch (e) { return writeJson(res, 500, { stopped: false, error: e.message }); }
  claudeJobs.delete(jobId);
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

  if (pathname === "/claude/check" && req.method === "GET") {
    handleClaudeCheck(req, res);
  } else if (pathname === "/claude/chat" && req.method === "POST") {
    handleClaudeChat(req, res);
  } else if (pathname === "/claude/stop" && req.method === "POST") {
    handleClaudeStop(req, res);
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
  console.log(`  Claude: /claude/* (cwd: ${CLAUDE_CWD})`);
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
