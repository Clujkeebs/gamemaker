// Builds the deployable static bundle for a published game.
//
// Returns the files in memory rather than writing them, because where they land
// depends on the environment — the local disk, Netlify Blobs, or straight into
// a Netlify deploy payload. Storage is somebody else's problem.
//
// Layout mirrors the repo so the engine's own relative imports keep working
// with no bundler, no build step, and no transpile:
//
//   index.html                       arcade page  -> iframes game.html
//   game.html                        pinned engine + inlined config
//   templates/<id>/engine.js         copy of the engine at publish time
//   shared/*.js                      only what that engine actually imports
//
// Copying the engine is what pins it. Improving templates/<id>/engine.js in the
// repo tomorrow cannot reach into a bundle that already shipped.

import { readFileSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { ROOT, get } from './registry.js';
import { renderArcadePage, renderGamePage } from '../arcade/render.js';

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

/** @returns { files: { [relativePath]: contents } } */
export function buildBundle({ game, page }) {
  const template = get(game.template_id);
  if (!template) throw new Error(`unknown template ${game.template_id}`);

  const files = {
    'index.html': renderArcadePage(page, game),
    'game.html': renderGamePage(game),
    [`templates/${game.template_id}/engine.js`]: readFileSync(template.enginePath, 'utf8'),
    // Long-cache the engine (its content is version-pinned), never the HTML —
    // republishing must be visible immediately at the same URL.
    _headers: [
      '/templates/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '/shared/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '/*.html',
      '  Cache-Control: public, max-age=0, must-revalidate',
      '',
    ].join('\n'),
    'romp.json': JSON.stringify({
      title: game.title,
      description: game.description,
      template_id: game.template_id,
      template_version: game.template_version,
      style: game.config?.style ?? null,
      published_at: new Date().toISOString(),
    }, null, 2),
  };

  for (const [rel, source] of collectModules(template.enginePath)) files[rel] = source;
  return { files };
}

/** Everything Netlify's deploy API needs, as { "/path": contents }. */
export const bundleFiles = (files) =>
  Object.fromEntries(Object.entries(files).map(([p, c]) => [`/${p}`, c]));
