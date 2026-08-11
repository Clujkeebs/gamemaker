// Loads the template library off disk once at boot.
//
// This is the single source of truth for what templates exist. The classifier
// prompt is generated from it rather than hand-maintained, because a prompt
// listing a template that isn't installed makes the model classify into
// nothing — the exact drift the spec warned about.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES_DIR = join(ROOT, 'templates');

function loadOne(id) {
  const dir = join(TEMPLATES_DIR, id);
  const schema = JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8'));
  if (schema.template_id !== id) {
    throw new Error(`template ${id}: schema.json says template_id "${schema.template_id}"`);
  }
  const exDir = join(dir, 'examples');
  const examples = existsSync(exDir)
    ? readdirSync(exDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ name: f.replace(/\.json$/, ''), config: JSON.parse(readFileSync(join(exDir, f), 'utf8')) }))
    : [];
  if (!existsSync(join(dir, 'engine.js'))) throw new Error(`template ${id}: engine.js missing`);
  return { id, dir, schema, examples, enginePath: join(dir, 'engine.js') };
}

export const templates = new Map(
  readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => [d.name, loadOne(d.name)])
);

export const get = (id) => templates.get(id) ?? null;
export const ids = () => [...templates.keys()];

/** Compact catalog for the classifier. Small on purpose — it's sent every call. */
export function catalog() {
  return [...templates.values()].map(({ schema }) => ({
    template_id: schema.template_id,
    label: schema.label,
    blurb: schema.blurb,
    good_for: schema.goodFor,
    primary_verbs: schema.primaryVerbs,
    hooks: Object.keys(schema.mechanicHooks ?? {}),
  }));
}

/**
 * The schema text sent for the config pass — one template's, never all of them.
 * Sending fifteen schemas would blow the context and measurably hurt accuracy
 * on the one that matters.
 */
export function schemaBrief(id) {
  const t = get(id);
  if (!t) return null;
  const lines = [];
  const walk = (spec, path) => {
    if (spec.type === 'object') {
      for (const [k, sub] of Object.entries(spec.fields)) walk(sub, path ? `${path}.${k}` : k);
      return;
    }
    const bits = [`${path}: ${spec.type}`];
    if (spec.min !== undefined) bits.push(`range ${spec.min}..${spec.max}`);
    if (spec.values) bits.push(`one of ${spec.values.join('|')}`);
    if (spec.type === 'array' && spec.of?.values) bits.push(`array of ${spec.of.values.join('|')}`);
    if (spec.default !== undefined && spec.type !== 'grid') bits.push(`default ${JSON.stringify(spec.default)}`);
    if (spec.minRows) bits.push(`${spec.minRows}..${spec.maxRows} rows, max ${spec.maxCols} cols`);
    if (spec.doc) bits.push(`— ${spec.doc}`);
    lines.push(`  ${bits.join('  ')}`);
  };
  walk(t.schema.config, '');
  const hooks = Object.entries(t.schema.mechanicHooks ?? {})
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  const tiles = Object.entries(t.schema.tiles ?? {})
    .map(([k, v]) => `  "${k}" ${v}`)
    .join('\n');
  return [
    `TEMPLATE: ${t.schema.template_id} (v${t.schema.version}) — ${t.schema.label}`,
    `${t.schema.blurb}`,
    '',
    'CONFIG KEYS (every key is required; use no others):',
    lines.join('\n'),
    hooks ? `\nMECHANIC HOOKS (only these):\n${hooks}` : '',
    tiles ? `\nLEVEL TILES:\n${tiles}` : '',
  ].join('\n');
}

/** A known-good config for a template, used as a few-shot anchor and as a floor. */
export function exampleConfig(id, i = 0) {
  const t = get(id);
  if (!t?.examples.length) return null;
  const { _note, ...cfg } = t.examples[i % t.examples.length].config;
  return cfg;
}
