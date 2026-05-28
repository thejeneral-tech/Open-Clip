import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pc from "picocolors";

import { CodingAgent, type AgentEvent } from "./agent.js";
import { loadConfig, type AppConfig } from "./config.js";
import { OllamaChat } from "./ollamaChat.js";
import type { ProviderName } from "./providers.js";
import { toolDefinitions } from "./tools.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.WEB_PORT ?? 7878);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..");
const PUBLIC_DIR = path.resolve(REPO_ROOT, "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

type ServerState = {
  agent: CodingAgent | null;
  config: AppConfig | null;
  cwd: string;
  error: string | null;
  chat: OllamaChat;
};

function buildChat(existing?: OllamaChat): OllamaChat {
  const baseUrl =
    existing?.getBaseUrl() ||
    process.env.OLLAMA_BASE_URL?.trim() ||
    DEFAULT_OLLAMA_URL;
  const model =
    existing?.getModel() ||
    process.env.OLLAMA_MODEL?.trim() ||
    "qwen3";
  const apiKey = process.env.OLLAMA_API_KEY?.trim();
  const keepAlive = process.env.OLLAMA_KEEP_ALIVE?.trim();
  return new OllamaChat({
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(keepAlive ? { keepAlive } : {}),
  });
}

// Pick the first installed Ollama model as the default when OLLAMA_MODEL isn't
// explicitly set in the environment. Falls back to "qwen3" only as a last
// resort (probe failure or no models installed).
async function resolveDefaultOllamaModel(): Promise<void> {
  if (process.env.OLLAMA_MODEL?.trim()) return;
  const baseUrl = (process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  const probe = await probeOllama(baseUrl);
  if (probe.ok && probe.models.length > 0) {
    process.env.OLLAMA_MODEL = probe.models[0];
  } else {
    process.env.OLLAMA_MODEL = "qwen3";
  }
}

await resolveDefaultOllamaModel();

const state: ServerState = {
  agent: null,
  config: null,
  cwd: process.cwd(),
  error: null,
  chat: buildChat(),
};

function buildAgent(overrides?: Partial<Pick<AppConfig, "provider" | "model">>, cwd?: string): void {
  try {
    const config = loadConfig(overrides);
    const workingDir = cwd ?? state.cwd;
    const agentArgs: ConstructorParameters<typeof CodingAgent>[0] = {
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      cwd: workingDir,
    };
    if (config.baseUrl) {
      agentArgs.baseUrl = config.baseUrl;
    }
    if (config.keepAlive) {
      agentArgs.keepAlive = config.keepAlive;
    }
    if (config.numCtx !== undefined) {
      agentArgs.numCtx = config.numCtx;
    }
    if (config.numPredict !== undefined) {
      agentArgs.numPredict = config.numPredict;
    }
    state.agent = new CodingAgent(agentArgs);
    state.config = config;
    state.cwd = workingDir;
    state.error = null;
  } catch (error) {
    state.agent = null;
    state.config = null;
    state.error = error instanceof Error ? error.message : String(error);
  }
}

async function listFilesInWorkspace(url: URL, res: ServerResponse): Promise<void> {
  const sub = url.searchParams.get("path")?.trim() || "";
  const cwdResolved = path.resolve(state.cwd);
  const target = path.resolve(cwdResolved, sub);
  if (!target.startsWith(cwdResolved)) {
    return sendJson(res, 403, { error: "Path escapes workspace" });
  }
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist")
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) {
            return a.isDirectory() ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        })
        .map(async (entry) => {
          const full = path.join(target, entry.name);
          let size: number | null = null;
          if (entry.isFile()) {
            try {
              const stat = await fs.stat(full);
              size = stat.size;
            } catch {
              size = null;
            }
          }
          return {
            name: entry.name,
            type: entry.isDirectory() ? "dir" : "file",
            path: path.relative(cwdResolved, full).split(path.sep).join("/"),
            size,
          };
        }),
    );
    return sendJson(res, 200, { cwd: cwdResolved, path: sub, items });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function listAbsoluteDirectory(url: URL, res: ServerResponse): Promise<void> {
  const raw = url.searchParams.get("path");
  const requested = typeof raw === "string" ? raw.trim() : "";

  // Empty path → list Windows drives (or "/" on POSIX).
  if (requested.length === 0) {
    if (process.platform === "win32") {
      const drives: Array<{ name: string; path: string; type: "dir" }> = [];
      // Probe drive letters A: through Z:.
      for (let code = 65; code <= 90; code++) {
        const letter = String.fromCharCode(code);
        const drivePath = `${letter}:\\`;
        try {
          await fs.access(drivePath);
          drives.push({ name: `${letter}:`, path: drivePath, type: "dir" });
        } catch {
          // Drive not present — skip.
        }
      }
      return sendJson(res, 200, {
        path: "",
        parent: null,
        isRoot: true,
        items: drives,
      });
    }
    // POSIX: root.
    return listAbsoluteDirectoryAt("/", res);
  }

  // Resolve to absolute so callers can pass things like "C:\\Users".
  const target = path.resolve(requested);
  return listAbsoluteDirectoryAt(target, res);
}

async function listAbsoluteDirectoryAt(target: string, res: ServerResponse): Promise<void> {
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      return sendJson(res, 400, { error: "Not a directory" });
    }
    const entries = await fs.readdir(target, { withFileTypes: true });
    const items = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((entry) => ({
        name: entry.name,
        path: path.join(target, entry.name),
        type: "dir" as const,
      }));

    const parsed = path.parse(target);
    // parent is null when we're at a root (e.g. "C:\\" or "/").
    const atRoot = parsed.root === target || target === parsed.root;
    const parent = atRoot ? null : path.dirname(target);

    return sendJson(res, 200, {
      path: target,
      parent,
      isRoot: atRoot,
      items,
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readFileFromWorkspace(url: URL, res: ServerResponse): Promise<void> {
  const sub = url.searchParams.get("path")?.trim();
  if (!sub) {
    return sendJson(res, 400, { error: "path is required" });
  }
  const cwdResolved = path.resolve(state.cwd);
  const target = path.resolve(cwdResolved, sub);
  if (!target.startsWith(cwdResolved)) {
    return sendJson(res, 403, { error: "Path escapes workspace" });
  }
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      return sendJson(res, 400, { error: "Not a regular file" });
    }
    const MAX_BYTES = 200 * 1024;
    const buffer = await fs.readFile(target);
    const truncated = buffer.length > MAX_BYTES;
    const slice = truncated ? buffer.subarray(0, MAX_BYTES) : buffer;
    const content = slice.toString("utf8");
    return sendJson(res, 200, {
      path: sub,
      size: stat.size,
      truncated,
      content,
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function probeOllama(baseUrl: string): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      return { ok: false, error: `Ollama responded ${response.status} at ${url}` };
    }
    const json = (await response.json()) as { models?: Array<{ name?: string }> };
    const models = Array.isArray(json.models)
      ? json.models.map((m) => (typeof m?.name === "string" ? m.name : "")).filter((n) => n.length > 0)
      : [];
    return { ok: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not reach Ollama at ${baseUrl}: ${message}` };
  }
}

function activeOllamaBaseUrl(): string {
  return (
    state.config?.baseUrl ||
    state.chat.getBaseUrl() ||
    process.env.OLLAMA_BASE_URL?.trim() ||
    DEFAULT_OLLAMA_URL
  ).replace(/\/$/, "");
}

async function proxyOllamaGet(apiPath: string, res: ServerResponse): Promise<void> {
  const baseUrl = activeOllamaBaseUrl();
  try {
    const r = await fetch(`${baseUrl}${apiPath}`);
    if (!r.ok) {
      return sendJson(res, 502, { ok: false, error: `Ollama responded ${r.status} at ${baseUrl}${apiPath}` });
    }
    const json = (await r.json()) as { models?: unknown };
    const models = Array.isArray(json.models) ? json.models : [];
    return sendJson(res, 200, { ok: true, baseUrl, models });
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      error: `Could not reach Ollama at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function unloadOllamaModel(name: string, res: ServerResponse): Promise<void> {
  const baseUrl = activeOllamaBaseUrl();
  try {
    // Ollama unloads a loaded model when /api/generate is called with keep_alive=0.
    const r = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name, keep_alive: 0, prompt: "" }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return sendJson(res, 502, { error: `Ollama responded ${r.status}: ${text || r.statusText}` });
    }
    // Drain the streamed (and possibly empty) body — we don't need the contents.
    await r.text().catch(() => "");
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 502, {
      error: `Could not reach Ollama at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function deleteOllamaModel(name: string, res: ServerResponse): Promise<void> {
  const baseUrl = activeOllamaBaseUrl();
  try {
    const r = await fetch(`${baseUrl}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return sendJson(res, 502, { error: `Ollama responded ${r.status}: ${text || r.statusText}` });
    }
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 502, {
      error: `Could not reach Ollama at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function pullOllamaModel(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const baseUrl = activeOllamaBaseUrl();
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let clientClosed = false;
  req.on("close", () => {
    clientClosed = true;
  });

  const sendEvent = (event: string, data: unknown): void => {
    if (clientClosed || res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const r = await fetch(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, stream: true }),
    });
    if (!r.ok || !r.body) {
      sendEvent("error", { message: `Ollama responded ${r.status} at ${baseUrl}/api/pull` });
      res.end();
      return;
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (clientClosed) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let payload: { status?: string; error?: string; total?: number; completed?: number };
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        if (payload.error) {
          sendEvent("error", { message: payload.error });
        } else {
          sendEvent("progress", payload);
          if (typeof payload.status === "string" && /^success$/i.test(payload.status)) {
            sendEvent("done", { status: payload.status });
          }
        }
      }
    }
  } catch (error) {
    sendEvent("error", {
      message: `Could not reach Ollama at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

buildAgent();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/api/info") {
      return sendJson(res, 200, {
        provider: state.config?.provider ?? null,
        model: state.config?.model ?? null,
        baseUrl: state.config?.baseUrl ?? null,
        cwd: state.cwd,
        ready: state.agent !== null,
        error: state.error,
      });
    }

    if (req.method === "GET" && pathname === "/api/ollama/ps") {
      return proxyOllamaGet("/api/ps", res);
    }

    if (req.method === "GET" && pathname === "/api/ollama/tags") {
      return proxyOllamaGet("/api/tags", res);
    }

    if (req.method === "POST" && pathname === "/api/ollama/unload") {
      const body = ((await readJson(req)) ?? {}) as { name?: string };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return sendJson(res, 400, { error: "name is required" });
      return unloadOllamaModel(name, res);
    }

    if (req.method === "POST" && pathname === "/api/ollama/delete") {
      const body = ((await readJson(req)) ?? {}) as { name?: string };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return sendJson(res, 400, { error: "name is required" });
      return deleteOllamaModel(name, res);
    }

    if (req.method === "POST" && pathname === "/api/ollama/pull") {
      const body = ((await readJson(req)) ?? {}) as { name?: string };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return sendJson(res, 400, { error: "name is required" });
      return pullOllamaModel(name, req, res);
    }

    if (req.method === "GET" && pathname === "/api/ollama/probe") {
      const baseUrl =
        url.searchParams.get("baseUrl")?.trim() ||
        state.config?.baseUrl ||
        process.env.OLLAMA_BASE_URL?.trim() ||
        DEFAULT_OLLAMA_URL;
      const result = await probeOllama(baseUrl);
      return sendJson(res, result.ok ? 200 : 502, { baseUrl, ...result });
    }

    if (req.method === "GET" && pathname === "/api/ollama/chat/info") {
      return sendJson(res, 200, {
        baseUrl: state.chat.getBaseUrl(),
        model: state.chat.getModel(),
        history: state.chat.getHistory(),
      });
    }

    if (req.method === "POST" && pathname === "/api/ollama/chat/clear") {
      state.chat.clear();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && pathname === "/api/ollama/chat/model") {
      const body = ((await readJson(req)) ?? {}) as { model?: string; baseUrl?: string };
      if (typeof body.model === "string" && body.model.trim().length > 0) {
        state.chat.setModel(body.model);
      }
      if (typeof body.baseUrl === "string" && body.baseUrl.trim().length > 0) {
        state.chat.setBaseUrl(body.baseUrl);
      }
      return sendJson(res, 200, {
        ok: true,
        model: state.chat.getModel(),
        baseUrl: state.chat.getBaseUrl(),
      });
    }

    if (req.method === "POST" && pathname === "/api/ollama/chat") {
      return handleOllamaChat(req, res);
    }

    if (req.method === "GET" && pathname === "/api/files") {
      return listFilesInWorkspace(url, res);
    }

    if (req.method === "GET" && pathname === "/api/files/read") {
      return readFileFromWorkspace(url, res);
    }

    if (req.method === "GET" && pathname === "/api/fs/list") {
      return listAbsoluteDirectory(url, res);
    }

    if (req.method === "GET" && pathname === "/api/fs/home") {
      const home =
        process.env.USERPROFILE || process.env.HOME || (process.platform === "win32" ? "C:\\Users" : "/");
      return sendJson(res, 200, { home });
    }

    if (req.method === "POST" && pathname === "/api/runtime") {
      const body = ((await readJson(req)) ?? {}) as {
        numPredict?: number | null;
        numCtx?: number | null;
      };
      const update: { numPredict?: number | null; numCtx?: number | null } = {};
      if (body.numPredict === null || typeof body.numPredict === "number") {
        update.numPredict = body.numPredict;
      }
      if (body.numCtx === null || typeof body.numCtx === "number") {
        update.numCtx = body.numCtx;
      }
      if (state.agent) {
        state.agent.updateRuntimeOptions(update);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/tools") {
      return sendJson(res, 200, { tools: toolDefinitions });
    }

    if (req.method === "POST" && pathname === "/api/clear") {
      if (state.agent) {
        state.agent.clear();
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && pathname === "/api/config") {
      const body = ((await readJson(req)) ?? {}) as {
        provider?: string;
        model?: string;
        cwd?: string;
        baseUrl?: string;
      };

      const overrides: Partial<Pick<AppConfig, "provider" | "model">> = {};
      if (
        body.provider === "anthropic" ||
        body.provider === "gemini" ||
        body.provider === "ollama"
      ) {
        overrides.provider = body.provider satisfies ProviderName;
      }
      if (typeof body.model === "string" && body.model.trim().length > 0) {
        overrides.model = body.model.trim();
      }

      const nextCwd =
        typeof body.cwd === "string" && body.cwd.trim().length > 0
          ? path.resolve(body.cwd.trim())
          : state.cwd;

      // Fast path: if we're already on Ollama and only the model changed, update
      // the live provider in place so conversation history isn't reset.
      const onlyModelChanged =
        state.agent !== null &&
        state.config?.provider === "ollama" &&
        (overrides.provider === undefined || overrides.provider === "ollama") &&
        overrides.model !== undefined &&
        nextCwd === state.cwd &&
        (typeof body.baseUrl !== "string" || body.baseUrl.trim().length === 0);

      if (onlyModelChanged && state.agent && state.config) {
        state.agent.setModel(overrides.model!);
        state.config = { ...state.config, model: overrides.model! };
        return sendJson(res, 200, {
          ok: true,
          provider: state.config.provider,
          model: state.config.model,
          baseUrl: state.config.baseUrl ?? null,
          cwd: state.cwd,
        });
      }

      // Allow per-request OLLAMA_BASE_URL override (only when provider=ollama).
      const previousBaseUrl = process.env.OLLAMA_BASE_URL;
      if (
        overrides.provider === "ollama" &&
        typeof body.baseUrl === "string" &&
        body.baseUrl.trim().length > 0
      ) {
        process.env.OLLAMA_BASE_URL = body.baseUrl.trim();
      }

      try {
        buildAgent(overrides, nextCwd);
      } finally {
        if (previousBaseUrl === undefined) {
          delete process.env.OLLAMA_BASE_URL;
        } else if (overrides.provider === "ollama" && body.baseUrl) {
          process.env.OLLAMA_BASE_URL = previousBaseUrl;
        }
      }

      if (!state.agent) {
        return sendJson(res, 400, { error: state.error });
      }

      // For Ollama, verify reachability so the user gets immediate feedback.
      if (state.config?.provider === "ollama" && state.config.baseUrl) {
        const probe = await probeOllama(state.config.baseUrl);
        if (!probe.ok) {
          state.error = probe.error;
          return sendJson(res, 502, {
            error: probe.error,
            provider: state.config.provider,
            model: state.config.model,
            baseUrl: state.config.baseUrl,
          });
        }
      }

      return sendJson(res, 200, {
        ok: true,
        provider: state.config?.provider,
        model: state.config?.model,
        baseUrl: state.config?.baseUrl ?? null,
        cwd: state.cwd,
      });
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      return handleChat(req, res);
    }

    if (req.method === "GET") {
      return serveStatic(pathname, res);
    }

    return sendJson(res, 404, {
      error: `Unsupported endpoint: ${req.method ?? "GET"} ${pathname}`,
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    process.stderr.write(
      `\n${pc.red("Port already in use:")} ${HOST}:${PORT} is occupied — another TrendVault Coder server is probably already running.\n` +
        `Close the other terminal, or set a different port:\n` +
        `  ${pc.cyan(`set WEB_PORT=7879 && claw-web.bat`)}\n` +
        `The launcher will kill the stale process automatically on the next ${pc.cyan("claw-web.bat")} run.\n\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`${pc.red("Server error:")} ${error.message}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  const url = `http://${HOST}:${PORT}`;
  process.stdout.write(`${pc.cyan("TrendVault Coder Web UI")} ready at ${pc.yellow(url)}\n`);
  if (state.error) {
    process.stdout.write(
      `${pc.yellow("Notice:")} agent not yet ready — ${state.error}\n` +
        `Open ${url} to configure provider keys via the Settings panel.\n`,
    );
    return;
  }
  if (!state.config) {
    return;
  }
  process.stdout.write(
    `Provider: ${pc.green(state.config.provider)}  Model: ${pc.green(state.config.model)}  CWD: ${pc.gray(state.cwd)}\n`,
  );
  if (state.config.provider === "ollama" && state.config.baseUrl) {
    const probe = await probeOllama(state.config.baseUrl);
    if (probe.ok) {
      const modelTag = state.config.model;
      const hasModel = probe.models.some(
        (name) => name === modelTag || name.startsWith(`${modelTag}:`),
      );
      process.stdout.write(
        `Ollama at ${pc.green(state.config.baseUrl)} reachable — ${probe.models.length} model(s) installed.\n`,
      );
      if (!hasModel) {
        process.stdout.write(
          `${pc.yellow("Notice:")} requested model "${modelTag}" is not installed. ` +
            `Run: ${pc.cyan(`ollama pull ${modelTag}`)}\n`,
        );
      }
    } else {
      process.stdout.write(`${pc.yellow("Notice:")} ${probe.error}\n`);
      process.stdout.write(
        `Start Ollama with ${pc.cyan("ollama serve")} or change provider in the UI Settings panel.\n`,
      );
    }
  }
});

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!state.agent) {
    return sendJson(res, 500, {
      error: state.error ?? "Agent is not configured. Set provider credentials and try again.",
    });
  }

  const body = ((await readJson(req)) ?? {}) as { prompt?: string };
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return sendJson(res, 400, { error: "prompt is required" });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const sendEvent = (event: string, data: unknown): void => {
    if (res.writableEnded) {
      return;
    }
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let clientClosed = false;
  req.on("close", () => {
    clientClosed = true;
  });

  try {
    const result = await state.agent.runTurn(prompt, {
      onEvent: (event: AgentEvent) => {
        if (clientClosed) {
          return;
        }
        sendEvent(event.type, event);
      },
    });
    if (!clientClosed) {
      sendEvent("done", { text: result.text });
    }
  } catch (error) {
    if (!clientClosed) {
      sendEvent("error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
}

async function handleOllamaChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = ((await readJson(req)) ?? {}) as { prompt?: string; model?: string };
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return sendJson(res, 400, { error: "prompt is required" });
  }

  if (typeof body.model === "string" && body.model.trim().length > 0) {
    state.chat.setModel(body.model);
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let clientClosed = false;
  req.on("close", () => {
    clientClosed = true;
  });

  const sendEvent = (event: string, data: unknown): void => {
    if (clientClosed || res.writableEnded) {
      return;
    }
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("meta", {
    model: state.chat.getModel(),
    baseUrl: state.chat.getBaseUrl(),
  });

  try {
    await state.chat.runTurn(prompt, {
      onChunk: (event) => {
        if (clientClosed) {
          return;
        }
        sendEvent(event.type, event);
      },
    });
  } catch (error) {
    sendEvent("error", {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const requested = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!requested.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(requested);
    const ext = path.extname(requested).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
