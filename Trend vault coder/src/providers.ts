import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { GoogleGenAI, FunctionCallingConfigMode } from "@google/genai";

import type { AgentEvent, RunTurnOptions } from "./agent.js";
import { toolDefinitions, toolHandlers } from "./tools.js";

export type AgentTurnResult = {
  text: string;
};

export type ProviderName = "anthropic" | "gemini" | "ollama";

function buildSystemPrompt(cwd: string): string {
  return `
You are TrendVault Coder, a local terminal coding assistant.
Work step by step, prefer inspecting files before editing, and use tools when needed.
When you use tools, keep tool inputs minimal and precise.

Your current working directory is: ${cwd}
All file-related tool paths are interpreted relative to this directory.
A path of "." refers to the working directory itself.
You may not read or write paths outside of this directory.

To explore the project, call the list_files tool (e.g. {"path": "."}) instead of asking
the user to paste the listing. Use read_file to inspect a file, write_file to create or
overwrite one, search_text to grep, and run_shell for one-off commands.
`.trim();
}

export interface LlmProvider {
  runTurn(prompt: string, options?: RunTurnOptions): Promise<AgentTurnResult>;
  clear(): void;
}

function emit(options: RunTurnOptions | undefined, event: AgentEvent): void {
  if (options?.onEvent) {
    try {
      options.onEvent(event);
    } catch {
      // Listener errors must not break the agent loop.
    }
  }
}

export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly cwd: string;
  private readonly messages: MessageParam[] = [];

  constructor(args: { apiKey: string; model: string; cwd: string }) {
    this.client = new Anthropic({ apiKey: args.apiKey });
    this.model = args.model;
    this.cwd = args.cwd;
  }

  clear(): void {
    this.messages.length = 0;
  }

  async runTurn(prompt: string, options?: RunTurnOptions): Promise<AgentTurnResult> {
    this.messages.push({
      role: "user",
      content: prompt,
    });

    let assistantText = "";

    for (let i = 0; i < 8; i += 1) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        system: buildSystemPrompt(this.cwd),
        messages: this.messages,
        tools: toolDefinitions,
      });

      this.messages.push({
        role: "assistant",
        content: response.content,
      });

      const textBlocks = response.content.filter((block) => block.type === "text");
      if (textBlocks.length > 0) {
        assistantText = textBlocks.map((block) => block.text).join("\n");
        emit(options, { type: "text", text: assistantText });
      }

      const toolUses = response.content.filter((block) => block.type === "tool_use");
      if (toolUses.length === 0) {
        return { text: assistantText };
      }

      const toolResults: ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const input = (toolUse.input as Record<string, unknown>) ?? {};
        emit(options, {
          type: "tool_use",
          id: toolUse.id,
          name: toolUse.name,
          input,
        });

        const handler = toolHandlers[toolUse.name];
        if (!handler) {
          const content = `Unknown tool: ${toolUse.name}`;
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content,
          });
          emit(options, {
            type: "tool_result",
            id: toolUse.id,
            content,
            isError: true,
          });
          continue;
        }

        try {
          const result = await handler(input, this.cwd);
          const toolResult: ToolResultBlockParam = {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.content,
          };
          if (result.isError !== undefined) {
            toolResult.is_error = result.isError;
          }
          toolResults.push(toolResult);
          emit(options, {
            type: "tool_result",
            id: toolUse.id,
            content: result.content,
            isError: result.isError ?? false,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: message,
          });
          emit(options, {
            type: "tool_result",
            id: toolUse.id,
            content: message,
            isError: true,
          });
        }
      }

      this.messages.push({
        role: "user",
        content: toolResults,
      });
    }

    return {
      text: assistantText || "Stopped after reaching the tool iteration limit.",
    };
  }
}

type GeminiContent = {
  role: "user" | "model";
  parts: Array<Record<string, unknown>>;
};

export class GeminiProvider implements LlmProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly cwd: string;
  private readonly contents: GeminiContent[] = [];

  constructor(args: { apiKey: string; model: string; cwd: string }) {
    this.client = new GoogleGenAI({ apiKey: args.apiKey });
    this.model = args.model;
    this.cwd = args.cwd;
  }

  clear(): void {
    this.contents.length = 0;
  }

  async runTurn(prompt: string, options?: RunTurnOptions): Promise<AgentTurnResult> {
    this.contents.push({
      role: "user",
      parts: [{ text: prompt }],
    });

    let assistantText = "";

    for (let i = 0; i < 8; i += 1) {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: this.contents,
        config: {
          systemInstruction: buildSystemPrompt(this.cwd),
          tools: [
            {
              functionDeclarations: toolDefinitions.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.input_schema,
              })),
            },
          ],
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.AUTO,
            },
          },
        },
      });

      const candidate = response.candidates?.[0];
      const parts = (candidate?.content?.parts ?? []) as Array<Record<string, unknown>>;
      this.contents.push({
        role: "model",
        parts,
      });

      const textParts = parts
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .filter((text) => text.length > 0);
      if (textParts.length > 0) {
        assistantText = textParts.join("\n");
        emit(options, { type: "text", text: assistantText });
      }

      const functionCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is { id?: string; name?: string; args?: unknown } => typeof call === "object" && call !== null);

      if (functionCalls.length === 0) {
        return { text: assistantText || response.text || "" };
      }

      const functionResponses: Array<Record<string, unknown>> = [];

      for (const functionCall of functionCalls) {
        const name = typeof functionCall.name === "string" ? functionCall.name : "";
        const callId = typeof functionCall.id === "string" ? functionCall.id : name;
        const handler = toolHandlers[name];
        const input = isRecord(functionCall.args) ? functionCall.args : {};

        emit(options, {
          type: "tool_use",
          id: callId,
          name,
          input,
        });

        if (!handler) {
          const message = `Unknown tool: ${name}`;
          functionResponses.push({
            functionResponse: {
              name,
              id: callId,
              response: {
                error: message,
              },
            },
          });
          emit(options, {
            type: "tool_result",
            id: callId,
            content: message,
            isError: true,
          });
          continue;
        }

        try {
          const result = await handler(input, this.cwd);
          functionResponses.push({
            functionResponse: {
              name,
              id: callId,
              response: {
                content: result.content,
                isError: result.isError ?? false,
              },
            },
          });
          emit(options, {
            type: "tool_result",
            id: callId,
            content: result.content,
            isError: result.isError ?? false,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          functionResponses.push({
            functionResponse: {
              name,
              id: callId,
              response: {
                error: message,
              },
            },
          });
          emit(options, {
            type: "tool_result",
            id: callId,
            content: message,
            isError: true,
          });
        }
      }

      this.contents.push({
        role: "user",
        parts: functionResponses,
      });
    }

    return {
      text: assistantText || "Stopped after reaching the tool iteration limit.",
    };
  }
}

type OllamaToolCall = {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
};

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
  tool_name?: string;
};

// Cap individual tool result content so a single huge file or ripgrep dump
// doesn't blow past the model's context window on the next turn.
const MAX_TOOL_RESULT_CHARS = 4000;
// Sensible default context for Ollama if the user hasn't set one — large enough
// for an agent loop with a few tool calls, small enough not to OOM consumer hardware.
const DEFAULT_OLLAMA_NUM_CTX = 8192;

function truncateToolResultForHistory(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) {
    return content;
  }
  const head = content.slice(0, MAX_TOOL_RESULT_CHARS);
  const omitted = content.length - MAX_TOOL_RESULT_CHARS;
  return `${head}\n\n[... truncated: ${omitted} more characters omitted to preserve context]`;
}

function describeOllamaError(status: number, errorText: string): string {
  const lower = errorText.toLowerCase();
  if (
    /runner.*terminated|exit code|out of memory|cuda.*(error|oom)|gguf/i.test(lower) ||
    status === 500
  ) {
    const detail = errorText.slice(0, 200) || `status ${status}`;
    return (
      `Ollama runner crashed (${detail.trim()}). Likely causes: ` +
      `1) context window too small for accumulated history — clear the conversation and try again, ` +
      `2) model too large for available RAM/VRAM — try a smaller model like llama3.2:1b, ` +
      `3) Ollama needs restart — run "ollama serve" again.`
    );
  }
  return errorText.slice(0, 500) || `status ${status}`;
}

export class OllamaProvider implements LlmProvider {
  private readonly baseUrl: string;
  private model: string;
  private readonly cwd: string;
  private readonly apiKey: string | undefined;
  private readonly keepAlive: string | undefined;
  private numCtx: number | undefined;
  private numPredict: number | undefined;
  private readonly history: OllamaMessage[] = [];

  constructor(args: {
    baseUrl: string;
    model: string;
    cwd: string;
    apiKey?: string;
    keepAlive?: string;
    numCtx?: number;
    numPredict?: number;
  }) {
    this.baseUrl = args.baseUrl.replace(/\/$/, "");
    this.model = args.model;
    this.cwd = args.cwd;
    this.apiKey = args.apiKey;
    this.keepAlive = args.keepAlive;
    this.numCtx = args.numCtx;
    this.numPredict = args.numPredict;
  }

  clear(): void {
    this.history.length = 0;
  }

  setModel(model: string): void {
    const trimmed = model.trim();
    if (trimmed.length > 0 && trimmed !== this.model) {
      this.model = trimmed;
    }
  }

  updateRuntimeOptions(opts: { numPredict?: number | null; numCtx?: number | null }): void {
    if (opts.numPredict === null) {
      this.numPredict = undefined;
    } else if (typeof opts.numPredict === "number" && opts.numPredict > 0) {
      this.numPredict = opts.numPredict;
    }
    if (opts.numCtx === null) {
      this.numCtx = undefined;
    } else if (typeof opts.numCtx === "number" && opts.numCtx > 0) {
      this.numCtx = opts.numCtx;
    }
  }

  getModel(): string {
    return this.model;
  }

  async runTurn(prompt: string, options?: RunTurnOptions): Promise<AgentTurnResult> {
    if (this.history.length === 0) {
      this.history.push({ role: "system", content: buildSystemPrompt(this.cwd) });
    }

    this.history.push({ role: "user", content: prompt });

    const tools = toolDefinitions.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));

    let assistantText = "";

    for (let i = 0; i < 8; i += 1) {
      const runtimeOptions: Record<string, unknown> = {};
      runtimeOptions.num_ctx = this.numCtx ?? DEFAULT_OLLAMA_NUM_CTX;
      if (this.numPredict !== undefined) {
        runtimeOptions.num_predict = this.numPredict;
      }

      const body: Record<string, unknown> = {
        model: this.model,
        messages: this.history,
        tools,
        stream: false,
        options: runtimeOptions,
      };
      if (this.keepAlive) {
        body.keep_alive = this.keepAlive;
      }

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not reach Ollama at ${this.baseUrl}. Is the Ollama server running? (${message})`,
        );
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(describeOllamaError(response.status, errorText));
      }

      const json = (await response.json()) as { message?: OllamaMessage };
      const message = json.message;

      if (!message) {
        return { text: assistantText };
      }

      let content = typeof message.content === "string" ? message.content : "";
      let toolCalls: OllamaToolCall[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];

      // Fallback: some local models (especially small ones) emit tool calls as
      // literal JSON inside the text content instead of using Ollama's
      // structured tool_calls field. Recover those so the agent still acts.
      if (toolCalls.length === 0 && content.length > 0) {
        const knownToolNames = new Set(toolDefinitions.map((t) => t.name));
        const extracted = extractToolCallsFromText(content, knownToolNames);
        if (extracted.calls.length > 0) {
          toolCalls = extracted.calls;
          content = extracted.cleanedText;
        }
      }

      const assistantHistoryEntry: OllamaMessage = {
        role: "assistant",
        content,
      };
      if (toolCalls.length > 0) {
        assistantHistoryEntry.tool_calls = toolCalls;
      }
      this.history.push(assistantHistoryEntry);

      if (content.length > 0) {
        assistantText = content;
        emit(options, { type: "text", text: assistantText });
      }

      if (toolCalls.length === 0) {
        return { text: assistantText };
      }

      for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
        const call = toolCalls[callIndex];
        const fn = call?.function ?? {};
        const name = typeof fn.name === "string" ? fn.name : "tool";
        const id =
          typeof call?.id === "string" && call.id.length > 0
            ? call.id
            : `toolu_${i}_${callIndex}_${name}`;

        let input: Record<string, unknown> = {};
        if (isRecord(fn.arguments)) {
          input = fn.arguments;
        } else if (typeof fn.arguments === "string" && fn.arguments.trim().length > 0) {
          try {
            const parsed = JSON.parse(fn.arguments);
            input = isRecord(parsed) ? parsed : {};
          } catch {
            input = {};
          }
        }

        emit(options, { type: "tool_use", id, name, input });

        const handler = toolHandlers[name];
        let resultContent: string;
        let isError = false;

        if (!handler) {
          resultContent = `Unknown tool: ${name}`;
          isError = true;
        } else {
          try {
            const result = await handler(input, this.cwd);
            resultContent = result.content;
            isError = result.isError ?? false;
          } catch (error) {
            resultContent = error instanceof Error ? error.message : String(error);
            isError = true;
          }
        }

        this.history.push({
          role: "tool",
          content: truncateToolResultForHistory(resultContent),
          tool_call_id: id,
          tool_name: name,
        });

        // Emit the full content to the UI — only the model's history is capped.
        emit(options, { type: "tool_result", id, content: resultContent, isError });
      }
    }

    return {
      text: assistantText || "Stopped after reaching the tool iteration limit.",
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Find balanced { ... } object spans in text. Returns each span and its start
// index so the caller can both parse the JSON and strip it out of the text.
function findBalancedObjects(text: string): Array<{ start: number; end: number; raw: string }> {
  const out: Array<{ start: number; end: number; raw: string }> = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push({ start: i, end: j + 1, raw: text.slice(i, j + 1) });
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

// Scan text for JSON object literals shaped like
// {"name":"<tool>", "arguments":{...}} (or "parameters"/"input"/"args")
// and turn each one into a synthetic OllamaToolCall. Strips them from the
// returned cleanedText so the user-visible message isn't littered with the raw
// JSON.
function extractToolCallsFromText(
  text: string,
  knownToolNames: Set<string>,
): { calls: OllamaToolCall[]; cleanedText: string } {
  const calls: OllamaToolCall[] = [];
  const removeSpans: Array<{ start: number; end: number }> = [];

  for (const span of findBalancedObjects(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(span.raw);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const name =
      typeof parsed.name === "string"
        ? parsed.name
        : typeof parsed.tool === "string"
          ? parsed.tool
          : typeof parsed.function === "string"
            ? parsed.function
            : null;
    if (!name || !knownToolNames.has(name)) continue;

    const argsCandidate =
      parsed.arguments ?? parsed.parameters ?? parsed.input ?? parsed.args ?? {};
    const input: Record<string, unknown> = isRecord(argsCandidate) ? argsCandidate : {};

    calls.push({
      id: `text_${calls.length}_${name}`,
      function: { name, arguments: input },
    });
    removeSpans.push({ start: span.start, end: span.end });
  }

  if (calls.length === 0) return { calls: [], cleanedText: text };

  // Strip the matched JSON spans from the visible text, then clean up surrounding
  // code fences and stray whitespace.
  removeSpans.sort((a, b) => b.start - a.start);
  let cleaned = text;
  for (const span of removeSpans) {
    cleaned = cleaned.slice(0, span.start) + cleaned.slice(span.end);
  }
  cleaned = cleaned
    .replace(/```(?:json|tool_call|tool_use)?\s*```/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { calls, cleanedText: cleaned };
}
