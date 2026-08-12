// Model providers.
//
// Two, deliberately: Groq for the cheap path and Anthropic for the good one.
// Groq's free tier is what makes "anyone can try this" affordable — it's
// OpenAI-compatible, so the only real difference is the request shape.
//
// Which one runs is a TIER the caller asks for, not a hard-coded choice:
//   fast — prefer Groq. What free and promo credits buy.
//   best — prefer Claude. What paid credits buy.
// Either tier falls back to whatever is actually configured, so a deployment
// with only one key still works and nobody sees an error about a provider they
// never set up.

const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const GROQ_BASE = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai').replace(/\/$/, '');

export const PROVIDERS = {
  groq: {
    id: 'groq',
    label: 'Groq',
    envVar: 'GROQ_API_KEY',
    // Free tier, fast, and good enough to write a config against a schema.
    defaultModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    signupUrl: 'https://console.groq.com/keys',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Claude',
    envVar: 'ANTHROPIC_API_KEY',
    defaultModel: process.env.RUMPUS_MODEL || 'claude-sonnet-5',
    signupUrl: 'https://console.anthropic.com/settings/keys',
  },
};

export const TIERS = {
  fast: { order: ['groq', 'anthropic'], label: 'Fast & free' },
  best: { order: ['anthropic', 'groq'], label: 'Best quality' },
};

export const configured = (id) => Boolean(process.env[PROVIDERS[id].envVar]);
export const anyConfigured = () => Object.keys(PROVIDERS).some(configured);

/** Which provider actually serves a tier right now, or null if none can. */
export function resolveProvider(tier = 'fast') {
  const order = (TIERS[tier] ?? TIERS.fast).order;
  return order.find(configured) ?? null;
}

export function providerStatus() {
  return {
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id, label: p.label, configured: configured(p.id),
      model: configured(p.id) ? p.defaultModel : null,
      signupUrl: p.signupUrl,
    })),
    tiers: Object.fromEntries(
      Object.entries(TIERS).map(([id, t]) => [id, { label: t.label, provider: resolveProvider(id) }])
    ),
  };
}

export class ModelError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function callAnthropic({ system, messages, maxTokens, temperature, model }) {
  const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages }),
  });
  if (!res.ok) {
    throw new ModelError(`Claude API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 400)}`, res.status);
  }
  const data = await res.json();
  return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function callGroq({ system, messages, maxTokens, temperature, model }) {
  // OpenAI-compatible: the system prompt is the first message rather than a
  // top-level field, and that is the whole of the difference.
  const res = await fetch(`${GROQ_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!res.ok) {
    throw new ModelError(`Groq API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 400)}`, res.status);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

const CALLS = { anthropic: callAnthropic, groq: callGroq };

/** @returns { text, provider, model } */
export async function complete({ system, messages, maxTokens = 4096, temperature = 0.7, tier = 'fast' }) {
  const id = resolveProvider(tier);
  if (!id) throw new ModelError('No model provider is configured', 401);
  const provider = PROVIDERS[id];
  const model = provider.defaultModel;
  const text = await CALLS[id]({ system, messages, maxTokens, temperature, model });
  return { text, provider: id, model };
}

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose or fences more often than they should, and the
 * smaller/cheaper ones do it far more — so this matters more now than it did
 * when Claude was the only provider.
 */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  try {
    return JSON.parse(candidate);
  } catch { /* fall through to brace matching */ }

  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(candidate.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
