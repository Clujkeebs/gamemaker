// Published-game index.
//
// The thing that must not break is URL stability: republishing an edited game
// has to land on the same slug, or every link anyone already shared rots. That
// requirement is about slug allocation, not about the database — so this stays
// a single JSON document, and `storage.js` decides where that document lives.
//
// Everything is async because on Netlify the backing store is a network call.

import { readIndex, writeIndex } from './storage.js';

// Names that would let a published game impersonate part of the service.
const RESERVED = new Set([
  'www', 'api', 'app', 'admin', 'mail', 'ftp', 'cdn', 'static', 'assets',
  'docs', 'blog', 'help', 'support', 'status', 'dashboard', 'account',
  'login', 'signup', 'auth', 'billing', 'rumpus', 'play', 'games', 'new',
  'preview', 'styles', 'index',
]);

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
export async function allocateSlug(title, gameId) {
  const db = await readIndex();
  const existing = gameId && db.games[gameId];
  if (existing?.slug) return existing.slug;

  const base = slugify(title);
  const taken = new Set(Object.values(db.games).map((g) => g.slug));
  let slug = RESERVED.has(base) ? `${base}-game` : base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  return slug;
}

export async function put(game) {
  const db = await readIndex();
  const now = new Date().toISOString();
  const prev = db.games[game.id];
  db.games[game.id] = { ...prev, ...game, createdAt: prev?.createdAt ?? now, updatedAt: now };
  await writeIndex(db);
  return db.games[game.id];
}

export const getGame = async (id) => (await readIndex()).games[id] ?? null;

export const bySlug = async (slug) =>
  Object.values((await readIndex()).games).find((g) => g.slug === slug) ?? null;

export const list = async () =>
  Object.values((await readIndex()).games).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

export const newId = () =>
  `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** The URL a published game lives at, per the tier-1 wildcard-subdomain plan. */
export function publicUrl(slug) {
  const root = process.env.RUMPUS_ROOT_DOMAIN;
  return root ? `https://${slug}.${root}` : null;
}
