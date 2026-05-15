/**
 * Multi-provider AI completion with automatic fallback.
 *
 * Provider preference (env: AI_PROVIDER):
 *   auto       — Anthropic first, fall back to OpenAI on failure (default)
 *   anthropic  — Anthropic only
 *   openai     — OpenAI only
 *
 * On Anthropic errors that signal billing/credit issues (HTTP 400/402/429,
 * "credit balance too low"), Auto mode silently retries with OpenAI.
 */

export interface AICompletionRequest {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AICompletionResult {
  text: string;
  provider: 'anthropic' | 'openai';
  warning?: string;
}

const ANTHROPIC_BILLING_REGEX = /credit\s*balance|billing|insufficient|quota|429|402|400.*invalid_request/i;

async function callAnthropic(req: AICompletionRequest): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages = [{ role: 'user' as const, content: req.user }];
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: req.maxTokens ?? 1024,
    ...(req.system ? { system: req.system } : {}),
    messages,
  });
  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Anthropic response type');
  return block.text;
}

async function callOpenAI(req: AICompletionRequest): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.user });

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.8,
      messages,
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`OpenAI ${r.status}: ${errBody.slice(0, 200)}`);
  }

  const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned empty response');
  return text;
}

export async function aiComplete(req: AICompletionRequest): Promise<AICompletionResult> {
  const provider = (process.env.AI_PROVIDER || 'auto').toLowerCase();

  if (provider === 'openai') {
    const text = await callOpenAI(req);
    return { text, provider: 'openai' };
  }

  if (provider === 'anthropic') {
    const text = await callAnthropic(req);
    return { text, provider: 'anthropic' };
  }

  // AUTO: Anthropic first, fall back to OpenAI
  try {
    const text = await callAnthropic(req);
    return { text, provider: 'anthropic' };
  } catch (anthErr) {
    const msg = String((anthErr as Error)?.message || anthErr);
    const isBilling = ANTHROPIC_BILLING_REGEX.test(msg);
    const hasOpenAI = !!process.env.OPENAI_API_KEY;

    if (!hasOpenAI) {
      // No fallback available — re-throw original error
      throw anthErr;
    }

    if (isBilling) {
      console.warn('[AI] Anthropic billing issue — falling back to OpenAI:', msg.slice(0, 100));
    } else {
      console.warn('[AI] Anthropic error — falling back to OpenAI:', msg.slice(0, 100));
    }

    try {
      const text = await callOpenAI(req);
      return {
        text,
        provider: 'openai',
        warning: isBilling
          ? 'Anthropic credits exhausted — using OpenAI instead'
          : 'Anthropic failed — using OpenAI instead',
      };
    } catch (openaiErr) {
      // Both failed — throw a combined error
      const oaiMsg = String((openaiErr as Error)?.message || openaiErr);
      throw new Error(`Both AI providers failed. Anthropic: ${msg.slice(0, 100)}. OpenAI: ${oaiMsg.slice(0, 100)}`);
    }
  }
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
