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

const PORT = parseInt(process.env.PORT, 10) || 5500;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const ROOT = __dirname;

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

  if (pathname.startsWith("/api/")) {
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
  console.log("  Ollama Chat");
  console.log("  ───────────");
  console.log(`  UI:     http://localhost:${PORT}`);
  console.log(`  Proxy:  /api/* → ${OLLAMA_HOST}`);
  console.log("");
  console.log("");
  console.log("  Ollama Chat");
  console.log("  ───────────");
  console.log(`  UI:     http://localhost:${PORT}`);
  console.log(`  Proxy:  /api/* → ${OLLAMA_HOST}`);
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
