/**
 * Local AI completion (Ollama / llama.cpp) — no API keys, no cloud.
 *
 * Talks to a local OpenAI-compatible /v1 endpoint. Configure via env:
 *   LOCAL_LLM_URL    default http://localhost:11434/v1  (Ollama)
 *                    llama.cpp: http://localhost:8080/v1
 *   LOCAL_LLM_MODEL  default llama3.1:8b
 */

export interface AICompletionRequest {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Override the local model for this call (else LOCAL_LLM_MODEL). */
  model?: string;
}

export interface AICompletionResult {
  text: string;
  provider: 'local';
  warning?: string;
}

const LOCAL_LLM_URL = (process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || 'llama3.1:8b';

async function callLocal(req: AICompletionRequest): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.user });

  let r: Response;
  try {
    r = await fetch(`${LOCAL_LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model ?? LOCAL_LLM_MODEL,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0.8,
        ...(req.topP != null ? { top_p: req.topP } : {}),
        messages,
        stream: false,
      }),
      // Local CPU inference can be slow — allow up to 5 min per call.
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    throw new Error(
      `Local LLM unreachable at ${LOCAL_LLM_URL} — is Ollama/llama.cpp running? ` +
      `(${(e as Error)?.message || e})`
    );
  }

  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`Local LLM ${r.status}: ${errBody.slice(0, 200)}`);
  }

  const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Local LLM returned empty response');
  return text;
}

export async function aiComplete(req: AICompletionRequest): Promise<AICompletionResult> {
  const text = await callLocal(req);
  return { text, provider: 'local' };
}

/** Strip markdown code fences / preamble and parse JSON safely.
 *
 * Models sometimes wrap JSON in prose ("Here's the prompt: { ... }") or fences.
 * This used to throw on any non-pure-JSON response, which silently broke the
 * Apply-AI button because all 5 callers funnel through here. Now we try, in
 * order: (1) raw, (2) inside the first ```...``` fence, (3) the substring
 * between the first '{' or '[' and the matching last '}' or ']'.
 */
export function parseAIJson<T>(raw: string): T {
  const candidates: string[] = [];
  const txt = raw.trim();
  candidates.push(txt);

  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());

  // First {...} or [...] block — handles preambles like "Here is the JSON: {..."
  const firstObj = txt.indexOf('{');
  const lastObj  = txt.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) candidates.push(txt.slice(firstObj, lastObj + 1));
  const firstArr = txt.indexOf('[');
  const lastArr  = txt.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) candidates.push(txt.slice(firstArr, lastArr + 1));

  let lastErr: unknown = null;
  for (const c of candidates) {
    try { return JSON.parse(c) as T; } catch (e) { lastErr = e; }
  }
  // None worked — throw a useful error that includes a snippet of what we got
  const snippet = txt.slice(0, 200).replace(/\s+/g, ' ');
  throw new Error(
    `parseAIJson: no valid JSON found in model response. ` +
    `First 200 chars: "${snippet}". Underlying error: ${(lastErr as Error)?.message || lastErr}`
  );
}
