// Schema-driven config validation and clamping.
//
// This is deliberately not full JSON Schema. Templates need one thing JSON
// Schema doesn't give first-class treatment: a documented *safe range* per
// number that we clamp into rather than reject. Out-of-range numerics are the
// single largest cause of unplayable output, and the fix is a value that still
// plays, not an error the user has to read.
//
// Policy, by failure kind:
//   invented key   -> ERROR. A key we don't know is a model mistake; merging it
//                     silently hides the bug and it can't affect the game anyway.
//   wrong type     -> ERROR, unless it's trivially coercible ("12" -> 12).
//   out of range   -> CLAMP + log. Always playable, always visible in dev.
//   missing key    -> FILL from default + log. Harmless, and demanding a
//                     complete config from the model costs accuracy elsewhere.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export class ValidationResult {
  constructor() {
    this.errors = [];
    this.clamps = [];
    this.fills = [];
    this.config = null;
  }
  get ok() {
    return this.errors.length === 0;
  }
  error(path, msg) {
    this.errors.push({ path, message: msg });
  }
  clamp(path, from, to) {
    this.clamps.push({ path, from, to });
  }
  fill(path, value) {
    this.fills.push({ path, value });
  }
  /** One-line summaries, for logs and for feeding a repair retry back to the model. */
  summary() {
    return [
      ...this.errors.map((e) => `error at ${e.path}: ${e.message}`),
      ...this.clamps.map((c) => `clamped ${c.path}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`),
    ];
  }
}

/** Build a fully-defaulted config from a schema. Also the fallback on total failure. */
export function defaultsFor(spec) {
  switch (spec.type) {
    case 'object': {
      const out = {};
      for (const [k, sub] of Object.entries(spec.fields)) out[k] = defaultsFor(sub);
      return out;
    }
    case 'array':
      return spec.default ? structuredClone(spec.default) : [];
    default:
      return spec.default !== undefined ? structuredClone(spec.default) : null;
  }
}

function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function walk(value, spec, path, res) {
  const missing = value === undefined || value === null;

  if (missing) {
    if (spec.required) {
      res.error(path, 'required value is missing');
      return defaultsFor(spec);
    }
    const filled = defaultsFor(spec);
    if (spec.type !== 'object') res.fill(path, filled);
    return filled;
  }

  switch (spec.type) {
    case 'object': {
      if (!isPlainObject(value)) {
        res.error(path, `expected an object, got ${Array.isArray(value) ? 'array' : typeof value}`);
        return defaultsFor(spec);
      }
      for (const key of Object.keys(value)) {
        if (!(key in spec.fields) && key !== '_note') {
          res.error(path ? `${path}.${key}` : key, `unknown key (not in this template's schema)`);
        }
      }
      const out = {};
      for (const [key, sub] of Object.entries(spec.fields)) {
        out[key] = walk(value[key], sub, path ? `${path}.${key}` : key, res);
      }
      return out;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        res.error(path, `expected an array, got ${typeof value}`);
        return defaultsFor(spec);
      }
      let items = value;
      const max = spec.maxItems ?? 64;
      if (items.length > max) {
        res.clamp(`${path}.length`, items.length, max);
        items = items.slice(0, max);
      }
      // An array is a list, not a set of fixed slots: a bad element gets dropped
      // and reported, never swapped for the default. Substituting would silently
      // duplicate whatever the default is — two "doubleJump" hooks, say.
      const out = [];
      items.forEach((item, i) => {
        const probe = new ValidationResult();
        const cleaned = walk(item, spec.of, `${path}[${i}]`, probe);
        res.clamps.push(...probe.clamps);
        res.fills.push(...probe.fills);
        if (probe.errors.length) res.errors.push(...probe.errors);
        else out.push(cleaned);
      });
      if (spec.minItems && out.length < spec.minItems) {
        res.error(path, `needs at least ${spec.minItems} item(s), got ${out.length}`);
      }
      return out;
    }

    case 'number':
    case 'int': {
      let n = coerceNumber(value);
      if (n === null) {
        res.error(path, `expected a number, got ${JSON.stringify(value)}`);
        return spec.default ?? spec.min ?? 0;
      }
      if (spec.type === 'int') n = Math.round(n);
      const lo = spec.min;
      const hi = spec.max;
      const clamped = Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, n));
      if (clamped !== n) {
        res.clamp(path, n, clamped);
        return clamped;
      }
      return n;
    }

    case 'bool': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      res.error(path, `expected true or false, got ${JSON.stringify(value)}`);
      return spec.default ?? false;
    }

    case 'enum': {
      if (spec.values.includes(value)) return value;
      res.error(path, `expected one of ${spec.values.join(' | ')}, got ${JSON.stringify(value)}`);
      return spec.default ?? spec.values[0];
    }

    case 'color': {
      if (typeof value === 'string' && HEX.test(value.trim())) return value.trim().toLowerCase();
      res.error(path, `expected a hex color like #4488ff, got ${JSON.stringify(value)}`);
      return spec.default ?? '#ffffff';
    }

    case 'string': {
      if (typeof value !== 'string') {
        res.error(path, `expected a string, got ${typeof value}`);
        return spec.default ?? '';
      }
      const max = spec.maxLength ?? 240;
      if (value.length > max) {
        res.clamp(path, `${value.length} chars`, `${max} chars`);
        return value.slice(0, max);
      }
      return value;
    }

    // Rows-of-strings level grid. Dimensions are clamped; contents are checked
    // for legal tile characters. Reachability is a separate, later pass.
    case 'grid': {
      if (!Array.isArray(value) || value.some((r) => typeof r !== 'string')) {
        res.error(path, 'expected an array of strings');
        return defaultsFor(spec);
      }
      const maxRows = spec.maxRows ?? 40;
      const maxCols = spec.maxCols ?? 80;
      let rows = value;
      if (rows.length > maxRows) {
        res.clamp(`${path}.rows`, rows.length, maxRows);
        rows = rows.slice(0, maxRows);
      }
      if (rows.length < (spec.minRows ?? 3)) {
        res.error(path, `needs at least ${spec.minRows ?? 3} rows, got ${rows.length}`);
        return defaultsFor(spec);
      }
      const legal = new Set(spec.tiles ?? ['.', '#', 'P', 'G', 'x', 'o', 'e', '-']);
      return rows.map((row, y) => {
        let r = row;
        if (r.length > maxCols) {
          res.clamp(`${path}[${y}].length`, r.length, maxCols);
          r = r.slice(0, maxCols);
        }
        return Array.from(r)
          .map((ch, x) => {
            if (legal.has(ch)) return ch;
            res.error(`${path}[${y}][${x}]`, `illegal tile character ${JSON.stringify(ch)}`);
            return '.';
          })
          .join('');
      });
    }

    default:
      res.error(path, `schema bug: unknown spec type ${spec.type}`);
      return null;
  }
}

/**
 * Validate a model-produced config against a template schema.
 * Always returns a usable config, even when `ok` is false — callers that want
 * to retry can, and callers that must render something still can.
 */
export function validate(config, schema) {
  const res = new ValidationResult();
  res.config = walk(config, schema.config, '', res);

  // Hooks are validated separately: they're a flat allowlist, and using one the
  // template doesn't implement is the exact failure the system prompt warns about.
  const declared = res.config?.mechanicHooks;
  if (Array.isArray(declared)) {
    // Schemas document hooks as { name: description }; accept a bare list too.
    const hookSpec = schema.mechanicHooks ?? {};
    const supported = new Set(Array.isArray(hookSpec) ? hookSpec : Object.keys(hookSpec));
    res.config.mechanicHooks = declared.filter((h) => {
      if (supported.has(h)) return true;
      res.error('mechanicHooks', `template "${schema.template_id}" does not support hook "${h}"`);
      return false;
    });
  }
  return res;
}
