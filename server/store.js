// Published-game store. A JSON file, deliberately.
//
// The thing that must not break is URL stability: republishing an edited game
// has to land on the same slug, or every link anyone already shared rots. That
// requirement is about slug allocation, not about the database — so this stays
// a file until something actually needs more.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './registry.js';

const DATA_DIR = join(ROOT, 'data');
const DB = join(DATA_DIR, 'games.json');

// Names that would let a published game impersonate part of the service.
const RESERVED = new Set([
  'www', 'api', 'app', 'admin', 'mail', 'ftp', 'cdn', 'static', 'assets',
  'docs', 'blog', 'help', 'support', 'status', 'dashboard', 'account',
  'login', 'signup', 'auth', 'billing', 'rumpus', 'play', 'games', 'new',
]);

function load() {
  if (!existsSync(DB)) return { games: {} };
  try {
    return JSON.parse(readFileSync(DB, 'utf8'));
  } catch {
    return { games: {} };
  }
}

function save(db) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DB, JSON.stringify(db, null, 2));
}

export function slugify(title) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return base || 'game';
}

/** Allocate a slug, or keep the one this game already owns. */
export function allocateSlug(title, gameId) {
  const db = load();
  const existing = gameId && db.games[gameId];
  if (existing?.slug) return existing.slug;

  const base = slugify(title);
  const taken = new Set(Object.values(db.games).map((g) => g.slug));
  let slug = base;
  if (RESERVED.has(slug)) slug = `${slug}-game`;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  return slug;
}

export function put(game) {
  const db = load();
  const now = new Date().toISOString();
  const prev = db.games[game.id];
  db.games[game.id] = {
    ...prev,
    ...game,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  save(db);
  return db.games[game.id];
}

export const getGame = (id) => load().games[id] ?? null;
export const bySlug = (slug) => Object.values(load().games).find((g) => g.slug === slug) ?? null;
export const list = () =>
  Object.values(load().games).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

export const newId = () =>
  `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** The URL a published game lives at, per the tier-1 wildcard-subdomain plan. */
export function publicUrl(slug) {
  const root = process.env.RUMPUS_ROOT_DOMAIN;
  return root ? `https://${slug}.${root}` : null;
}
