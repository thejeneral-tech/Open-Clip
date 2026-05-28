import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CliAgentEvent =
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; content: string; isError: boolean }
  | { type: "text"; text: string }
  | { type: "error"; message: string };

export type RunTurnOptions = {
  onEvent?: (event: CliAgentEvent) => void;
};

export type RunTurnResult = {
  text: string;
  isError: boolean;
  durationMs: number;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI_PATH = path.resolve(MODULE_DIR, "..", "vendor", "claude-code-bundle", "cli.js");

export type CliAgentArgs = {
  cwd: string;
  cliPath?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
};

type PendingTurn = {
  onEvent?: (event: CliAgentEvent) => void;
  resolve: (result: RunTurnResult) => void;
  reject: (err: Error) => void;
  accumulatedText: string;
  toolInputs: Map<string, { name: string; input: Record<string, unknown> }>;
  startedAt: number;
};

export class CliAgent {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private cwd: string;
  private cliPath: string;
  private model: string | undefined;
  private env: NodeJS.ProcessEnv;
  private sessionId: string | null = null;
  private pending: PendingTurn | null = null;
  private startupError: string | null = null;

  constructor(args: CliAgentArgs) {
    this.cwd = path.resolve(args.cwd);
    this.cliPath = args.cliPath ?? DEFAULT_CLI_PATH;
    this.model = args.model;
    this.env = { ...process.env, ...(args.env ?? {}) };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getCwd(): string {
    return this.cwd;
  }

  setCwd(cwd: string): void {
    const resolved = path.resolve(cwd);
    if (resolved === this.cwd) return;
    this.cwd = resolved;
    this.dispose();
  }

  setModel(model: string | undefined): void {
    if ((model ?? "") === (this.model ?? "")) return;
    this.model = model;
    this.dispose();
  }

  clear(): void {
    this.sessionId = null;
    this.dispose();
  }

  dispose(): void {
    if (this.pending) {
      this.pending.reject(new Error("CLI agent disposed mid-turn"));
      this.pending = null;
    }
    if (this.child && !this.child.killed) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
      this.child.kill();
    }
    this.child = null;
    this.buffer = "";
  }

  private ensureChild(): void {
    if (this.child && !this.child.killed) return;

    const args: string[] = [
      this.cliPath,
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (this.model && this.model.trim().length > 0) {
      args.push("--model", this.model.trim());
    }
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    this.startupError = null;
    this.buffer = "";

    const child = spawn(process.execPath, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
      windowsHide: true,
    });

    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.toString();
      this.startupError = (this.startupError ?? "") + text;
      process.stderr.write(`[cli-agent stderr] ${text}`);
    });

    child.on("exit", (code, signal) => {
      const why =
        signal != null
          ? `signal ${signal}`
          : code != null
            ? `code ${code}`
            : "no exit code";
      if (this.pending) {
        const stderrTail = (this.startupError ?? "").trim().split("\n").slice(-6).join("\n");
        const message = stderrTail.length > 0
          ? `CLI exited (${why}): ${stderrTail}`
          : `CLI exited (${why}) before turn completed.`;
        this.pending.reject(new Error(message));
        this.pending = null;
      }
      this.child = null;
      this.buffer = "";
    });

    child.on("error", (err) => {
      if (this.pending) {
        this.pending.reject(err);
        this.pending = null;
      }
    });
  }

  async runTurn(prompt: string, options?: RunTurnOptions): Promise<RunTurnResult> {
    if (this.pending) {
      throw new Error("CLI agent is already processing a turn.");
    }
    this.ensureChild();
    const child = this.child;
    if (!child) {
      throw new Error("Failed to spawn CLI agent.");
    }

    return new Promise<RunTurnResult>((resolve, reject) => {
      this.pending = {
        onEvent: options?.onEvent,
        resolve,
        reject,
        accumulatedText: "",
        toolInputs: new Map(),
        startedAt: Date.now(),
      };

      const userMessage = JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      });

      try {
        child.stdin.write(userMessage + "\n");
      } catch (err) {
        this.pending = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private consumeStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.handleEvent(event);
    }
  }

  private extractToolResultContent(rawContent: unknown): string {
    if (typeof rawContent === "string") return rawContent;
    if (Array.isArray(rawContent)) {
      const parts: string[] = [];
      for (const block of rawContent) {
        if (block && typeof block === "object" && "type" in block) {
          const b = block as { type: string; text?: string; content?: string };
          if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
          else if (typeof b.content === "string") parts.push(b.content);
        }
      }
      return parts.join("\n");
    }
    return "";
  }

  private handleEvent(event: Record<string, unknown>): void {
    const turn = this.pending;
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "system" && event.subtype === "init") {
      if (typeof event.session_id === "string") this.sessionId = event.session_id;
      return;
    }

    if (type === "assistant" && event.message && typeof event.message === "object") {
      const message = event.message as { content?: unknown };
      const content = Array.isArray(message.content) ? message.content : [];
      for (const blockRaw of content) {
        if (!blockRaw || typeof blockRaw !== "object") continue;
        const block = blockRaw as { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
        if (block.type === "text" && typeof block.text === "string") {
          if (turn) {
            turn.accumulatedText += block.text;
            turn.onEvent?.({ type: "text", text: turn.accumulatedText });
          }
        } else if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          const input = (block.input ?? {}) as Record<string, unknown>;
          if (turn) {
            turn.toolInputs.set(block.id, { name: block.name, input });
            turn.onEvent?.({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input,
            });
          }
        }
      }
      return;
    }

    if (type === "user" && event.message && typeof event.message === "object") {
      const message = event.message as { content?: unknown };
      const content = Array.isArray(message.content) ? message.content : [];
      for (const blockRaw of content) {
        if (!blockRaw || typeof blockRaw !== "object") continue;
        const block = blockRaw as {
          type?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        };
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const resultText = this.extractToolResultContent(block.content);
          if (turn) {
            turn.onEvent?.({
              type: "tool_result",
              id: block.tool_use_id,
              content: resultText,
              isError: !!block.is_error,
            });
          }
        }
      }
      return;
    }

    if (type === "result") {
      if (!turn) return;
      const isError = event.is_error === true || event.subtype === "error";
      const resultText =
        typeof event.result === "string" && event.result.length > 0
          ? event.result
          : turn.accumulatedText;
      if (isError && resultText && resultText !== turn.accumulatedText) {
        turn.onEvent?.({ type: "error", message: resultText });
      }
      turn.resolve({
        text: resultText,
        isError,
        durationMs: Date.now() - turn.startedAt,
      });
      this.pending = null;
      return;
    }
  }
}
