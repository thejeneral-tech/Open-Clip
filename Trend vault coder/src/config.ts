import { config as loadEnv } from "dotenv";
import { z } from "zod";
import type { ProviderName } from "./providers.js";

loadEnv({ quiet: true });

const providerSchema = z.enum(["anthropic", "gemini", "ollama"]);

const envSchema = z.object({
  LLM_PROVIDER: providerSchema.optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-20250514"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  OLLAMA_BASE_URL: z.string().optional(),
  OLLAMA_MODEL: z.string().min(1).default("qwen3"),
  OLLAMA_API_KEY: z.string().optional(),
  OLLAMA_KEEP_ALIVE: z.string().optional(),
  OLLAMA_NUM_CTX: z.coerce.number().int().positive().optional(),
  OLLAMA_NUM_PREDICT: z.coerce.number().int().positive().optional(),
});

export type AppConfig = {
  provider: ProviderName;
  apiKey: string;
  model: string;
  baseUrl?: string;
  keepAlive?: string;
  numCtx?: number;
  numPredict?: number;
};

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export function loadConfig(overrides?: Partial<Pick<AppConfig, "provider" | "model">>): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(", ");
    throw new Error(message);
  }

  const env = parsed.data;
  const provider = overrides?.provider ?? resolveDefaultProvider(env);

  if (provider === "gemini") {
    const apiKey = env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini");
    }
    return {
      provider,
      apiKey,
      model: overrides?.model ?? env.GEMINI_MODEL,
    };
  }

  if (provider === "ollama") {
    const baseUrl = (env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
    const config: AppConfig = {
      provider,
      apiKey: env.OLLAMA_API_KEY?.trim() ?? "",
      model: overrides?.model ?? env.OLLAMA_MODEL,
      baseUrl,
    };
    if (env.OLLAMA_KEEP_ALIVE?.trim()) {
      config.keepAlive = env.OLLAMA_KEEP_ALIVE.trim();
    }
    if (env.OLLAMA_NUM_CTX !== undefined) {
      config.numCtx = env.OLLAMA_NUM_CTX;
    }
    if (env.OLLAMA_NUM_PREDICT !== undefined) {
      config.numPredict = env.OLLAMA_NUM_PREDICT;
    }
    return config;
  }

  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic");
  }

  return {
    provider,
    apiKey,
    model: overrides?.model ?? env.ANTHROPIC_MODEL,
  };
}

function resolveDefaultProvider(env: z.infer<typeof envSchema>): ProviderName {
  if (env.LLM_PROVIDER) {
    return env.LLM_PROVIDER;
  }
  if (env.ANTHROPIC_API_KEY?.trim()) {
    return "anthropic";
  }
  if (env.GEMINI_API_KEY?.trim()) {
    return "gemini";
  }
  // No cloud keys configured — Ollama is the safe local default.
  return "ollama";
}
