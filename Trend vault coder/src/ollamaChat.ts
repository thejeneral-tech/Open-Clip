export type ChatChunkEvent =
  | { type: "delta"; text: string }
  | { type: "done"; text: string };

export type ChatRunOptions = {
  onChunk?: (event: ChatChunkEvent) => void;
};

type OllamaChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * Lightweight wrapper around Ollama's /api/chat — no tools, no agent loop.
 * Just user prompts in, assistant tokens out, with conversation history.
 */
export class OllamaChat {
  private baseUrl: string;
  private model: string;
  private readonly apiKey: string | undefined;
  private readonly keepAlive: string | undefined;
  private systemPrompt: string;
  private readonly history: OllamaChatMessage[] = [];

  constructor(args: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    keepAlive?: string;
    systemPrompt?: string;
  }) {
    this.baseUrl = args.baseUrl.replace(/\/$/, "");
    this.model = args.model;
    this.apiKey = args.apiKey;
    this.keepAlive = args.keepAlive;
    this.systemPrompt = args.systemPrompt ?? "";
  }

  setModel(model: string): void {
    const trimmed = model.trim();
    if (trimmed.length > 0 && trimmed !== this.model) {
      this.model = trimmed;
    }
  }

  setBaseUrl(baseUrl: string): void {
    const trimmed = baseUrl.trim().replace(/\/$/, "");
    if (trimmed.length > 0) {
      this.baseUrl = trimmed;
    }
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
    // System prompt change only takes effect on next fresh conversation.
  }

  getModel(): string {
    return this.model;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getHistory(): ReadonlyArray<{ role: "user" | "assistant"; content: string }> {
    return this.history.filter((m) => m.role !== "system") as Array<{
      role: "user" | "assistant";
      content: string;
    }>;
  }

  clear(): void {
    this.history.length = 0;
  }

  async runTurn(prompt: string, options?: ChatRunOptions): Promise<string> {
    if (this.history.length === 0 && this.systemPrompt.length > 0) {
      this.history.push({ role: "system", content: this.systemPrompt });
    }

    this.history.push({ role: "user", content: prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.history,
      stream: true,
    };
    if (this.keepAlive) {
      body.keep_alive = this.keepAlive;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // Roll back the user message so a retry doesn't double-add it.
      this.history.pop();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not reach Ollama at ${this.baseUrl}. Is the Ollama server running? (${message})`,
      );
    }

    if (!response.ok) {
      this.history.pop();
      const errorText = await response.text().catch(() => "");
      const lower = errorText.toLowerCase();
      if (/runner.*terminated|exit code|out of memory|cuda.*(error|oom)/i.test(lower)) {
        throw new Error(
          `Ollama runner crashed (${errorText.slice(0, 200).trim() || "no detail"}). ` +
            `Try a smaller model (llama3.2:1b), clear this chat, or restart Ollama.`,
        );
      }
      throw new Error(
        `Ollama responded ${response.status}: ${errorText.slice(0, 500) || response.statusText}`,
      );
    }

    if (!response.body) {
      this.history.pop();
      throw new Error("Ollama returned no response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantText = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }
          let parsed: { message?: { content?: string }; done?: boolean; error?: string };
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (parsed.error) {
            throw new Error(parsed.error);
          }
          const text = parsed.message?.content;
          if (typeof text === "string" && text.length > 0) {
            assistantText += text;
            options?.onChunk?.({ type: "delta", text });
          }
          if (parsed.done) {
            break;
          }
        }
      }
    } catch (error) {
      this.history.pop();
      throw error;
    }

    this.history.push({ role: "assistant", content: assistantText });
    options?.onChunk?.({ type: "done", text: assistantText });
    return assistantText;
  }
}
