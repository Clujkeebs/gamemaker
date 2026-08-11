// Minimal Claude API client. No SDK, because the whole app is zero-dependency
// and this is one fetch call.

// Overridable so the pipeline can be pointed at a gateway, a proxy, or the
// mock server the tests use to exercise everything short of the real model.
const BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const API = `${BASE}/v1/messages`;

// Sonnet by default: the preview loop is interactive, and a generation that
// lands in two seconds beats a marginally better one that takes eight. Set
// RUMPUS_MODEL to trade that the other way.
export const MODEL = process.env.RUMPUS_MODEL || 'claude-sonnet-5';
export const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

export class ModelError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function complete({ system, messages, maxTokens = 4096, temperature = 0.7 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ModelError('ANTHROPIC_API_KEY is not set', 401);

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ModelError(`Claude API ${res.status}: ${body.slice(0, 400)}`, res.status);
  }
  const data = await res.json();
  return (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Pull a JSON object out of a model response.
 * Models wrap JSON in prose or fences more often than they should, and a whole
 * generation shouldn't fail over a stray "Here you go:".
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
