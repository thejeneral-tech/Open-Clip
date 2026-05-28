import {
  AnthropicProvider,
  GeminiProvider,
  OllamaProvider,
  type LlmProvider,
  type ProviderName,
} from "./providers.js";

export type AgentTurnResult = {
  text: string;
};

export type AgentEvent =
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; content: string; isError: boolean }
  | { type: "text"; text: string };

export type RunTurnOptions = {
  onEvent?: (event: AgentEvent) => void;
};

export type AgentConstructorArgs = {
  provider: ProviderName;
  apiKey: string;
  model: string;
  cwd: string;
  baseUrl?: string;
  keepAlive?: string;
  numCtx?: number;
  numPredict?: number;
};

export class CodingAgent {
  private readonly provider: LlmProvider;

  constructor(args: AgentConstructorArgs) {
    if (args.provider === "gemini") {
      this.provider = new GeminiProvider({
        apiKey: args.apiKey,
        model: args.model,
        cwd: args.cwd,
      });
      return;
    }

    if (args.provider === "ollama") {
      const ollamaArgs: ConstructorParameters<typeof OllamaProvider>[0] = {
        baseUrl: args.baseUrl ?? "http://127.0.0.1:11434",
        model: args.model,
        cwd: args.cwd,
      };
      if (args.apiKey && args.apiKey.length > 0) {
        ollamaArgs.apiKey = args.apiKey;
      }
      if (args.keepAlive) {
        ollamaArgs.keepAlive = args.keepAlive;
      }
      if (args.numCtx !== undefined) {
        ollamaArgs.numCtx = args.numCtx;
      }
      if (args.numPredict !== undefined) {
        ollamaArgs.numPredict = args.numPredict;
      }
      this.provider = new OllamaProvider(ollamaArgs);
      return;
    }

    this.provider = new AnthropicProvider({
      apiKey: args.apiKey,
      model: args.model,
      cwd: args.cwd,
    });
  }

  clear(): void {
    this.provider.clear();
  }

  async runTurn(prompt: string, options?: RunTurnOptions): Promise<AgentTurnResult> {
    return this.provider.runTurn(prompt, options);
  }

  /** Update the active model on the existing provider without losing history. */
  setModel(model: string): boolean {
    if (this.provider instanceof OllamaProvider) {
      this.provider.setModel(model);
      return true;
    }
    return false;
  }

  /** Update Ollama runtime options live (no-op on cloud providers). */
  updateRuntimeOptions(opts: { numPredict?: number | null; numCtx?: number | null }): void {
    if (this.provider instanceof OllamaProvider) {
      this.provider.updateRuntimeOptions(opts);
    }
  }
}
