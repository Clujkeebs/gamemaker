// The generation pipeline: prompt in, validated config out.
//
// Two model calls, not one. Classification is a small, cheap decision that only
// needs the catalog; configuration needs one template's full schema. Doing them
// together would mean sending every schema on every request, which costs
// context and measurably hurts accuracy on the template that actually matters.

import { complete, extractJson, anyConfigured, ModelError, resolveProvider, PROVIDERS } from './llm.js';
import { catalog, schemaBrief, exampleConfig, get, ids } from './registry.js';
import { validate, defaultsFor } from '../shared/schema.js';
import { checkLevel, repairLevel } from '../shared/levelcheck.js';
import { generateOffline } from './offline.js';

// The template list is generated from the registry, never hand-written. A
// prompt that lists a template which isn't installed makes the model classify
// into nothing.
function classifierSystem() {
  const lines = catalog().map(
    (t) => `- ${t.template_id} — ${t.blurb}\n    verbs: ${t.primary_verbs.join(', ')}\n    ${t.good_for}`
  );
  return `You are the classifier stage of Rumpus, a 2D game generator.

Pick the ONE archetype template that best fits the user's game idea, based on
the core mechanic: movement + win/lose condition + the primary verb.

If the idea blends two archetypes ("a platformer where you also shoot"), pick
the DOMINANT mechanic as the base and note the secondary one — it becomes a
mechanic hook, never a new engine.

If the idea is genuinely ambiguous, choose the simplest, most robust archetype:
prefer platformer-classic or top-down-collector over anything else.

TEMPLATES:
${lines.join('\n')}

Reply with ONLY this JSON, no prose:
{"template_id": "...", "secondary": "<hook-ish mechanic the idea implies, or null>", "why": "<max 12 words>"}`;
}

function configSystem(templateId) {
  return `You are Rumpus, a game-generation engine. You produce a JSON CONFIG for a
fixed, already-working game template. You never write engine, physics, or
game-loop code — the renderer combines your config with tested template code.

${schemaBrief(templateId)}

RULES
- Output every key in the schema. Invent no keys that are not listed.
- Keep every number inside its stated range. Values outside the range are the
  number one cause of unplayable games.
- Only use mechanicHooks listed above for this template.
- Levels must be winnable: exactly one P, a reachable G when the win condition
  needs one, and no required tile sealed behind solid blocks.
- Grid rows must all be the same length.
- Art comes from the parts library only. Never image files, never prose art
  direction. Pick a style from the SUBJECT, and compose each character from a
  build plus features so it reads as the thing the title names: a cat is
  quadruped + earsPointed + tail, a robot is biped + visor + antenna, a dragon
  is biped + horns + wings. Enemies get eyes "angry" unless there's a reason not to.
- The style governs the game AND its published landing page, so pick one that
  fits the whole idea, not just the sprites.
- The theme must be internally consistent: title, colors, pickupName, and the
  collectible icon all agree ("snacks" means the fruit icon, not coin).

OUTPUT
Reply with ONLY this JSON, no prose, no code fence:
{"title": "<short game title, the kind of name a kid gives a game>",
 "description": "<one sentence for the landing page>",
 "config": { ...the full config object... }}`;
}

const editSystem = (templateId) => `${configSystem(templateId)}

You are EDITING an existing game. The user's instruction follows the current
config. Change only what the instruction implies, and return the FULL updated
config — never a diff.

If the instruction needs a mechanic this template cannot do (3D, multiplayer, a
fundamentally different core verb), reply instead with ONLY:
{"template_switch_required": true, "suggested_template": "<template_id or null>",
 "reason": "<one sentence>"}

Otherwise also include: "changelog_note": "<one sentence on what changed>"`;

async function classify(prompt, tier) {
  const { text } = await complete({
    system: classifierSystem(),
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 300,
    temperature: 0.2,
    tier,
  });
  const json = extractJson(text);
  if (!json?.template_id || !get(json.template_id)) {
    // A classifier that names a template we don't have is recoverable; keyword
    // matching is a fine floor, and it beats failing the whole request.
    const { classifyOffline } = await import('./offline.js');
    return { ...classifyOffline(prompt), why: 'fallback: classifier returned an unknown template' };
  }
  return json;
}

/**
 * Validate, and give the model exactly one chance to fix its own errors before
 * we fall back. One retry: two costs latency the preview loop can't afford, and
 * a model that fails twice on a schema this explicit will fail a third time.
 */
async function configureWithRepair({ system, messages, templateId, tier }) {
  const schema = get(templateId).schema;
  let { text, provider, model } = await complete({ system, messages, maxTokens: 6000, temperature: 0.85, tier });
  let json = extractJson(text);

  if (json?.template_switch_required) return { switchRequired: json };

  let result = json?.config ? validate(json.config, schema) : null;

  if (!result || !result.ok) {
    const problems = result
      ? result.summary().filter((s) => s.startsWith('error')).slice(0, 12)
      : ['response was not valid JSON with a "config" key'];
    ({ text } = await complete({
      system,
      messages: [
        ...messages,
        { role: 'assistant', content: text.slice(0, 6000) },
        {
          role: 'user',
          content: `That config was rejected. Fix exactly these problems and return the same JSON shape again:\n${problems.map((p) => `- ${p}`).join('\n')}`,
        },
      ],
      maxTokens: 6000,
      temperature: 0.4,
      tier,
    }));
    const retry = extractJson(text);
    if (retry?.template_switch_required) return { switchRequired: retry };
    if (retry?.config) {
      const retryResult = validate(retry.config, schema);
      // Keep the retry only if it's actually better.
      if (!result || retryResult.errors.length < result.errors.length) {
        json = retry;
        result = retryResult;
      }
    }
  }

  if (!result) return { failed: true };
  return { json, result, provider, model };
}

function finish(templateId, json, result, extra = {}, meta = {}) {
  const schema = get(templateId).schema;
  let config = result.config;
  let repaired = false;
  let reachability = [];

  if (schema.reachability) {
    const check = checkLevel(schema, config);
    if (!check.ok) {
      const fix = repairLevel(schema, config);
      config = fix.config;
      repaired = fix.repaired;
      reachability = fix.check.ok ? check.reasons : fix.check.reasons;
    }
  }

  return {
    template_id: templateId,
    template_version: schema.version,
    config,
    title: String(json.title ?? 'Untitled Rumpus').slice(0, 60),
    description: String(json.description ?? schema.blurb).slice(0, 200),
    changelog_note: json.changelog_note ? String(json.changelog_note).slice(0, 200) : undefined,
    source: 'model',
    provider: meta.provider ?? null,
    model: meta.model ?? null,
    notes: {
      clamps: result.clamps,
      fills: result.fills.length,
      errors: result.errors,
      repaired,
      reachability,
      ...extra,
    },
  };
}

export async function generate(prompt, forcedTemplate = null, { tier = 'fast' } = {}) {
  if (!anyConfigured()) return generateOffline(prompt, forcedTemplate);

  try {
    const cls = forcedTemplate ? { template_id: forcedTemplate } : await classify(prompt, tier);
    const templateId = cls.template_id;
    const example = exampleConfig(templateId);

    const attempt = await configureWithRepair({
      system: configSystem(templateId),
      templateId,
      tier,
      messages: [
        {
          role: 'user',
          content: `Game idea: ${prompt}
${cls.secondary ? `\nSecondary mechanic to express as a hook if supported: ${cls.secondary}` : ''}

Here is a known-good config for this template, purely as a shape reference —
build a NEW one for the idea above, do not copy its theme:
${JSON.stringify(example, null, 1)}`,
        },
      ],
    });

    if (attempt.failed || !attempt.result) {
      const fallback = generateOffline(prompt, templateId);
      fallback.notes.degraded = 'the model did not return a usable config; built this one locally';
      return fallback;
    }
    return finish(templateId, attempt.json, attempt.result, { why: cls.why },
                  { provider: attempt.provider, model: attempt.model });
  } catch (err) {
    if (err instanceof ModelError) {
      const fallback = generateOffline(prompt, forcedTemplate);
      fallback.notes.degraded = err.message;
      return fallback;
    }
    throw err;
  }
}

export async function edit({ templateId, config, instruction, title, tier = 'fast' }) {
  if (!get(templateId)) throw new Error(`unknown template ${templateId}`);
  if (!anyConfigured()) {
    return {
      unavailable: true,
      message: `Conversational editing needs a model key — ${PROVIDERS.groq.envVar} (free) or ${PROVIDERS.anthropic.envVar}. Without one you can still re-roll from a new prompt.`,
    };
  }

  const attempt = await configureWithRepair({
    system: editSystem(templateId),
    templateId,
    tier,
    messages: [
      {
        role: 'user',
        content: `Current game: "${title ?? 'untitled'}" on template ${templateId}.
Current config:
${JSON.stringify(config, null, 1)}

Instruction: ${instruction}`,
      },
    ],
  });

  if (attempt.switchRequired) {
    const s = attempt.switchRequired;
    return {
      template_switch_required: true,
      suggested_template: get(s.suggested_template) ? s.suggested_template : null,
      reason: String(s.reason ?? 'That needs a different archetype.').slice(0, 240),
    };
  }
  if (attempt.failed || !attempt.result) {
    return { unavailable: true, message: 'The edit did not come back as a usable config. Try rephrasing it.' };
  }
  return finish(templateId, attempt.json, attempt.result, {},
                { provider: attempt.provider, model: attempt.model });
}

/** A blank, fully-defaulted config. Used by the UI to show a template cold. */
export function blank(templateId) {
  const t = get(templateId);
  if (!t) return null;
  return {
    template_id: templateId,
    template_version: t.schema.version,
    config: exampleConfig(templateId) ?? defaultsFor(t.schema.config),
    title: t.schema.label,
    description: t.schema.blurb,
    source: 'template',
    notes: {},
  };
}

export const templateIds = ids;
