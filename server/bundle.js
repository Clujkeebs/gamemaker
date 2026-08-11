// Builds the deployable static bundle for a published game.
//
// Layout mirrors the repo so the engine's own relative imports keep working
// with no bundler, no build step, and no transpile:
//
//   index.html                       arcade page  -> iframes game.html
//   game.html                        pinned engine + inlined config
//   templates/<id>/engine.js         copy of the engine at publish time
//   shared/*.js                      its imports
//
// Copying the engine is what pins it. Improving templates/<id>/engine.js in the
// repo tomorrow cannot reach into a bundle that already shipped.

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { ROOT, get } from './registry.js';
import { renderArcadePage, renderGamePage } from '../arcade/render.js';

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

// Matches `from '...'` and bare `import '...'`. Only ever run over our own
// engine sources, which are plain static ES modules — no dynamic imports.
const IMPORT_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g;

/** @returns Map<bundleRelativePath, source> for an entry file and everything it imports. */
function collectModules(entryAbs) {
  const out = new Map();
  const visit = (abs) => {
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (out.has(rel)) return;
    const source = readFileSync(abs, 'utf8');
    out.set(rel, source);
    for (const [, spec] of source.matchAll(IMPORT_RE)) {
      if (!spec.startsWith('.')) continue; // node builtins / bare specifiers: not ours
      visit(resolve(dirname(abs), spec));
    }
  };
  visit(entryAbs);
  return out;
}

export function buildBundle({ game, page, outDir }) {
  const template = get(game.template_id);
  if (!template) throw new Error(`unknown template ${game.template_id}`);

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const files = [];
  const put = (rel, content) => {
    write(join(outDir, rel), content);
    files.push(rel);
  };

  put('index.html', renderArcadePage(page, game));
  put('game.html', renderGamePage(game));

  // Walk the engine's real import graph rather than copying all of shared/.
  // A published game has no business shipping the validator or the level
  // checker — those run here, before anything is ever written.
  for (const [rel, source] of collectModules(template.enginePath)) put(rel, source);

  // Long-cache the engine (its URL is version-pinned by content), never the
  // HTML — republishing must be visible immediately at the same URL.
  put('_headers', [
    '/templates/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/shared/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/*.html',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
  ].join('\n'));

  put('rumpus.json', JSON.stringify({
    title: game.title,
    description: game.description,
    template_id: game.template_id,
    template_version: game.template_version,
    published_at: new Date().toISOString(),
  }, null, 2));

  return { outDir, files };
}

/** Everything Netlify's deploy API needs, as { path: contents }. */
export function bundleFiles(outDir, files) {
  return Object.fromEntries(files.map((f) => [`/${f}`, readFileSync(join(outDir, f), 'utf8')]));
}
