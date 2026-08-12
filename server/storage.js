// Where the game index and published bundles actually live.
//
// Locally that's the filesystem. On Netlify it can't be: a function's disk is
// scratch space that vanishes with the container, so a published game would
// survive exactly until the next cold start. Netlify Blobs is the durable
// equivalent, and it's the only difference between the two environments —
// everything above this file is identical.
//
// The Blobs import is lazy on purpose. The local server stays zero-dependency;
// @netlify/blobs is only ever loaded inside the function that needs it.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { ROOT } from './registry.js';

export const onNetlify = () =>
  Boolean(process.env.NETLIFY_BLOBS_CONTEXT || process.env.NETLIFY);

export const backendName = () => (onNetlify() ? 'netlify-blobs' : 'filesystem');

let cached = null;
async function blobs() {
  if (!cached) {
    const { getStore } = await import('@netlify/blobs');
    // Strong consistency: publish then immediately fetch the page is the normal
    // flow here, and eventual consistency would serve a 404 on the happy path.
    cached = getStore({ name: 'rumpus', consistency: 'strong' });
  }
  return cached;
}

const DATA_DIR = join(ROOT, 'data');
const DIST_DIR = join(ROOT, 'dist');
const INDEX_KEY = 'index/games.json';
const bundleKey = (slug, rel) => `sites/${slug}/${rel.replace(/^\/+/, '')}`;

// ── the game index ──────────────────────────────────────────────────────────

export async function readIndex() {
  if (onNetlify()) {
    const store = await blobs();
    const raw = await store.get(INDEX_KEY, { type: 'json' });
    return raw ?? { games: {} };
  }
  const file = join(DATA_DIR, 'games.json');
  if (!existsSync(file)) return { games: {} };
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { games: {} };
  }
}

export async function writeIndex(db) {
  if (onNetlify()) {
    const store = await blobs();
    await store.setJSON(INDEX_KEY, db);
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(db, null, 2));
}

// ── small JSON documents (credit ledgers, promo counters) ───────────────────
//
// One key per record rather than one big document, so two visitors spending
// credits at the same time can't clobber each other's balance.

export async function readDoc(key) {
  if (onNetlify()) {
    const store = await blobs();
    return (await store.get(`doc/${key}.json`, { type: 'json' })) ?? null;
  }
  const file = join(DATA_DIR, `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeDoc(key, value) {
  if (onNetlify()) {
    const store = await blobs();
    await store.setJSON(`doc/${key}.json`, value);
    return;
  }
  const file = join(DATA_DIR, `${key}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

// ── published bundles ───────────────────────────────────────────────────────

/** @param files { "index.html": "…", "shared/draw.js": "…" } */
export async function writeBundle(slug, files) {
  if (onNetlify()) {
    const store = await blobs();
    // Sequential rather than parallel: a bundle is ~10 small files, and a burst
    // of parallel writes is a good way to meet a rate limit for no gain.
    for (const [rel, contents] of Object.entries(files)) {
      await store.set(bundleKey(slug, rel), contents);
    }
    return { location: `blobs:rumpus/sites/${slug}` };
  }
  const outDir = join(DIST_DIR, slug);
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return { location: outDir };
}

export async function readBundleFile(slug, rel) {
  if (onNetlify()) {
    const store = await blobs();
    return store.get(bundleKey(slug, rel));
  }
  // Refuse anything that climbs out of the bundle directory.
  const base = join(DIST_DIR, slug);
  const abs = join(base, rel);
  if (!abs.startsWith(base) || !existsSync(abs) || !statSync(abs).isFile()) return null;
  return readFileSync(abs, 'utf8');
}

/** Local only, for the dev server's directory listing and tests. */
export function localBundlePaths(slug) {
  const base = join(DIST_DIR, slug);
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(relative(base, abs).split(sep).join('/'));
    }
  };
  walk(base);
  return out;
}
