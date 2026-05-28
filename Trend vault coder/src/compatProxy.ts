import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CompatProvider = "ollama" | "gemini" | "groq";

export const COMPAT_AUTH_TOKEN = "trendvault-coder-proxy";

const COMPAT_DEFAULT_PORTS: Record<CompatProvider, number> = {
  gemini: 8787,
  groq: 8788,
  ollama: 8789,
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..");
const PROXY_ENTRY = path.resolve(REPO_ROOT, "src", "anthropicCompatProxy.ts");

export function defaultPortForProvider(provider: CompatProvider): number {
  return COMPAT_DEFAULT_PORTS[provider];
}

export type CompatProxyConfig = {
  provider: CompatProvider;
  model: string;
  port?: number;
  ollamaBaseUrl?: string;
  ollamaKeepAlive?: string;
  ollamaApiKey?: string;
  ollamaNumCtx?: number;
  ollamaNumPredict?: number;
  geminiApiKey?: string;
  groqApiKey?: string;
};

export type CompatProxyHandle = {
  provider: CompatProvider;
  model: string;
  port: number;
  baseUrl: string;
  pid: number | null;
  ownsProcess: boolean;
  startedAt: number;
};

function envFromConfig(config: CompatProxyConfig, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_COMPAT_PROVIDER: config.provider,
    ANTHROPIC_COMPAT_PORT: String(port),
  };
  switch (config.provider) {
    case "ollama":
      env.OLLAMA_MODEL = config.model;
      if (config.ollamaBaseUrl) env.OLLAMA_BASE_URL = config.ollamaBaseUrl;
      if (config.ollamaKeepAlive) env.OLLAMA_KEEP_ALIVE = config.ollamaKeepAlive;
      if (config.ollamaApiKey) env.OLLAMA_API_KEY = config.ollamaApiKey;
      if (config.ollamaNumCtx !== undefined) env.OLLAMA_NUM_CTX = String(config.ollamaNumCtx);
      if (config.ollamaNumPredict !== undefined) env.OLLAMA_NUM_PREDICT = String(config.ollamaNumPredict);
      break;
    case "gemini":
      env.GEMINI_MODEL = config.model;
      if (config.geminiApiKey) env.GEMINI_API_KEY = config.geminiApiKey;
      break;
    case "groq":
      env.GROQ_MODEL = config.model;
      if (config.groqApiKey) env.GROQ_API_KEY = config.groqApiKey;
      break;
  }
  return env;
}

async function probeHealth(baseUrl: string, provider: string, model: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const json = (await res.json()) as { ok?: boolean; provider?: string; model?: string };
    return json.ok === true && json.provider === provider && json.model === model;
  } catch {
    return false;
  }
}

export class CompatProxyManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private handle: CompatProxyHandle | null = null;
  private lastStderr = "";

  current(): CompatProxyHandle | null {
    return this.handle;
  }

  private matches(config: CompatProxyConfig): boolean {
    if (!this.handle) return false;
    if (this.handle.provider !== config.provider) return false;
    if (this.handle.model !== config.model) return false;
    if (config.port != null && this.handle.port !== config.port) return false;
    return true;
  }

  async ensure(config: CompatProxyConfig): Promise<CompatProxyHandle> {
    if (this.matches(config) && this.handle) {
      return this.handle;
    }
    await this.stop();

    const port = config.port ?? defaultPortForProvider(config.provider);
    const baseUrl = `http://127.0.0.1:${port}`;

    // Reuse an externally-running healthy proxy (e.g. launched from the CLI launcher).
    const alreadyUp = await probeHealth(baseUrl, config.provider, config.model);
    if (alreadyUp) {
      this.handle = {
        provider: config.provider,
        model: config.model,
        port,
        baseUrl,
        pid: null,
        ownsProcess: false,
        startedAt: Date.now(),
      };
      return this.handle;
    }

    return this.spawn(config, port, baseUrl);
  }

  private async spawn(config: CompatProxyConfig, port: number, baseUrl: string): Promise<CompatProxyHandle> {
    const env = envFromConfig(config, port);
    // Always invoke tsx's JS entry directly. On Linux/macOS,
    // `node_modules/.bin/tsx` is a `#!/bin/sh` wrapper that `node` cannot
    // execute, so spawning it with `process.execPath` (which is `node`)
    // failed silently and the proxy never came up.
    const tsxBin = path.resolve(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

    const child = spawn(process.execPath, [tsxBin, PROXY_ENTRY], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    this.lastStderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => process.stdout.write(`[compat-proxy] ${chunk}`));
    child.stderr.on("data", (chunk: string) => {
      this.lastStderr += chunk;
      process.stderr.write(`[compat-proxy] ${chunk}`);
    });

    child.on("exit", (code, signal) => {
      // Only clear handle if it's the same child we tracked.
      if (this.child === child) {
        this.child = null;
        this.handle = null;
      }
      if (code !== 0 && code !== null) {
        process.stderr.write(
          `[compat-proxy] exited code=${code} signal=${signal ?? ""}\n`,
        );
      }
    });

    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (child.killed || child.exitCode !== null) {
        const tail = this.lastStderr.split("\n").slice(-6).join("\n").trim();
        throw new Error(
          `Compat proxy exited before becoming healthy${tail ? `: ${tail}` : "."}`,
        );
      }
      const healthy = await probeHealth(baseUrl, config.provider, config.model);
      if (healthy) {
        this.handle = {
          provider: config.provider,
          model: config.model,
          port,
          baseUrl,
          pid: child.pid ?? null,
          ownsProcess: true,
          startedAt: Date.now(),
        };
        return this.handle;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    await this.stop();
    throw new Error(
      `Compat proxy did not become healthy on ${baseUrl} within 15s. Last stderr: ${this.lastStderr.slice(-200)}`,
    );
  }

  async stop(): Promise<void> {
    const child = this.child;
    const handle = this.handle;
    this.child = null;
    this.handle = null;
    if (child && !child.killed && handle?.ownsProcess !== false) {
      child.kill();
    }
  }
}
