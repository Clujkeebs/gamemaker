// Rumpus server. Zero dependencies: node:http, node:fs, and built-in fetch.
//
// Serves the editor, the sandboxed preview frame, the generation API, the
// publish pipeline, and locally-hosted copies of published bundles so the whole
// loop is demoable with no Netlify account and no API key.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { ROOT, catalog, get } from './registry.js';
import { generate, edit, blank } from './generate.js';
import { hasKey, MODEL } from './anthropic.js';
import { validate, defaultsFor } from '../shared/schema.js';
import { checkLevel } from '../shared/levelcheck.js';
import { buildBundle, bundleFiles } from './bundle.js';
import { defaultPage } from '../arcade/render.js';
import * as store from './store.js';
import * as netlify from './netlify.js';
import * as dns from './dns.js';

const PORT = Number(process.env.PORT || 4173);
const DIST = join(ROOT, 'dist');
const arcadeSchema = JSON.parse(readFileSync(join(ROOT, 'arcade', 'schema.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
};

function serveFile(res, absPath) {
  if (!existsSync(absPath) || !statSync(absPath).isFile()) return false;
  const ext = extname(absPath).toLowerCase();
  const body = readFileSync(absPath);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.length,
    // The preview iframe is sandboxed without allow-same-origin, so its origin
    // is opaque and its ES module fetches are cross-origin. Without this the
    // engine never loads.
    'access-control-allow-origin': '*',
    'cache-control': ext === '.html' ? 'no-store' : 'no-cache',
  });
  res.end(body);
  return true;
}

/** Resolve a URL path under a root, refusing anything that escapes it. */
function safeJoin(root, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const abs = join(root, rel);
  return abs.startsWith(root) ? abs : null;
}

async function readBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('request body was not valid JSON');
  }
}

// --- preview frame ----------------------------------------------------------

// Inline favicon: without one the browser requests /favicon.ico and logs a 404,
// which buries real errors in the console during development.
const FAVICON = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>%F0%9F%95%B9%EF%B8%8F</text></svg>`;

const previewPage = (templateId) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>preview</title>
<link rel="icon" href="${FAVICON}">
<link rel="apple-touch-icon" href="${FAVICON}">
<style>
  html,body{margin:0;height:100%;background:#05060a;overflow:hidden}
  body{display:flex;align-items:center;justify-content:center}
  canvas{width:100%;height:100%;object-fit:contain;display:block;image-rendering:pixelated;touch-action:none}
</style></head>
<body><canvas id="stage"></canvas>
<script type="module" src="/templates/${templateId}/engine.js"></script>
</body></html>`;

// --- api --------------------------------------------------------------------

async function api(req, res, url) {
  const path = url.pathname;

  if (path === '/api/health') {
    return json(res, 200, {
      ok: true,
      model: hasKey() ? MODEL : null,
      ai: hasKey(),
      netlify: netlify.hasToken(),
      rootDomain: process.env.RUMPUS_ROOT_DOMAIN ?? null,
      templates: catalog().length,
    });
  }

  if (path === '/api/templates') {
    return json(res, 200, { templates: catalog(), ai: hasKey() });
  }

  if (path === '/api/template' && url.searchParams.get('id')) {
    const t = get(url.searchParams.get('id'));
    if (!t) return json(res, 404, { error: 'unknown template' });
    return json(res, 200, blank(t.id));
  }

  if (path === '/api/generate' && req.method === 'POST') {
    const body = await readBody(req);
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return json(res, 400, { error: 'Say what kind of game you want.' });
    if (prompt.length > 2000) return json(res, 400, { error: 'That idea is too long — trim it to a couple of sentences.' });
    const game = await generate(prompt, body.template ?? null);
    return json(res, 200, game);
  }

  if (path === '/api/edit' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.templateId || !body.config || !body.instruction) {
      return json(res, 400, { error: 'edit needs templateId, config and instruction' });
    }
    const result = await edit({
      templateId: body.templateId,
      config: body.config,
      instruction: String(body.instruction).slice(0, 1000),
      title: body.title,
    });
    return json(res, 200, result);
  }

  // Re-validate a config the client changed directly (the form UI path).
  if (path === '/api/validate' && req.method === 'POST') {
    const body = await readBody(req);
    const t = get(body.templateId);
    if (!t) return json(res, 400, { error: 'unknown template' });
    const result = validate(body.config, t.schema);
    const level = t.schema.reachability ? checkLevel(t.schema, result.config) : { ok: true, reasons: [] };
    return json(res, 200, {
      ok: result.ok && level.ok,
      config: result.config,
      errors: result.errors,
      clamps: result.clamps,
      reachability: level.reasons,
    });
  }

  if (path === '/api/publish' && req.method === 'POST') {
    const body = await readBody(req);
    const game = body.game;
    if (!game?.template_id || !game?.config) return json(res, 400, { error: 'publish needs a generated game' });
    const t = get(game.template_id);
    if (!t) return json(res, 400, { error: 'unknown template' });

    // Never publish a config that hasn't been through validation, whatever the
    // client says. The published bundle is the artifact people share.
    const checked = validate(game.config, t.schema);
    game.config = checked.config;

    const id = body.id && store.getGame(body.id) ? body.id : store.newId();
    const slug = store.allocateSlug(game.title, id);
    const page = body.page ?? defaultPage(game, defaultsFor(arcadeSchema.config));

    const outDir = join(DIST, slug);
    const { files } = buildBundle({ game, page, outDir });

    let deployed = null;
    let deployError = null;
    if (netlify.hasToken() && body.deploy !== false) {
      try {
        const prev = store.getGame(id);
        deployed = await netlify.deploy({
          files: bundleFiles(outDir, files),
          siteId: prev?.deploy?.siteId,
          name: `rumpus-${slug}`,
        });
      } catch (err) {
        deployError = String(err.message ?? err);
      }
    }

    const saved = store.put({
      id, slug,
      title: game.title,
      description: game.description,
      template_id: game.template_id,
      template_version: game.template_version,
      config: game.config,
      page,
      deploy: deployed ? { provider: 'netlify', ...deployed } : store.getGame(id)?.deploy ?? null,
    });

    return json(res, 200, {
      id, slug,
      localUrl: `/p/${slug}/`,
      liveUrl: deployed?.url ?? null,
      subdomainUrl: store.publicUrl(slug),
      deployError,
      deployAvailable: netlify.hasToken(),
      files: files.length,
      page,
      game: saved,
    });
  }

  if (path === '/api/games') {
    return json(res, 200, {
      games: store.list().map(({ config, page, ...g }) => g),
    });
  }

  if (path === '/api/arcade-schema') return json(res, 200, arcadeSchema);

  if (path === '/api/domain/instructions' && req.method === 'POST') {
    const body = await readBody(req);
    const v = dns.validateDomain(body.domain);
    if (!v.ok) return json(res, 400, { error: v.error });
    const game = store.getGame(body.id);
    const target = game?.deploy?.url?.replace(/^https?:\/\//, '') ?? `${game?.slug ?? 'your-game'}.netlify.app`;
    return json(res, 200, dns.instructionsFor(v.domain, target));
  }

  if (path === '/api/domain/verify' && req.method === 'POST') {
    const body = await readBody(req);
    const v = dns.validateDomain(body.domain);
    if (!v.ok) return json(res, 400, { error: v.error });
    const game = store.getGame(body.id);
    const target = body.target ?? game?.deploy?.url?.replace(/^https?:\/\//, '');
    if (!target) return json(res, 400, { error: 'Publish the game first — there is nothing to point the domain at yet.' });

    const result = await dns.verify(v.domain, target);
    let attached = null;
    if (result.state === 'verified' && game?.deploy?.siteId && netlify.hasToken()) {
      try {
        await netlify.attachDomain({ siteId: game.deploy.siteId, domain: v.domain });
        attached = true;
        store.put({ ...game, customDomain: v.domain });
      } catch (err) {
        attached = String(err.message ?? err);
      }
    }
    return json(res, 200, { ...result, attached });
  }

  return json(res, 404, { error: 'no such endpoint' });
}

// --- server -----------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  try {
    if (path.startsWith('/api/')) return await api(req, res, url);

    // Sandboxed preview host for a template.
    const preview = path.match(/^\/preview\/([a-z0-9-]+)\/?$/);
    if (preview) {
      if (!get(preview[1])) return json(res, 404, { error: 'unknown template' });
      const body = previewPage(preview[1]);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(body);
    }

    // Locally-served published bundles, so publish works with no hosting account.
    const published = path.match(/^\/p\/([a-z0-9-]+)(\/.*)?$/);
    if (published) {
      const rest = published[2] && published[2] !== '/' ? published[2] : '/index.html';
      const abs = safeJoin(join(DIST, published[1]), rest);
      if (abs && serveFile(res, abs)) return;
      return json(res, 404, { error: 'not published yet' });
    }

    // Engine + shared modules, for both the preview frame and local bundles.
    if (path.startsWith('/templates/') || path.startsWith('/shared/')) {
      const abs = safeJoin(ROOT, path);
      if (abs && serveFile(res, abs)) return;
    }

    const webPath = path === '/' ? '/index.html' : path;
    const abs = safeJoin(join(ROOT, 'web'), webPath);
    if (abs && serveFile(res, abs)) return;

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    const message = String(err?.message ?? err);
    if (!res.headersSent) json(res, 500, { error: message });
    else res.end();
    console.error(`[rumpus] ${req.method} ${path} failed:`, message);
  }
});

server.listen(PORT, () => {
  const mode = hasKey() ? `AI on (${MODEL})` : 'AI off — offline generator';
  const deploy = netlify.hasToken() ? 'Netlify deploy ready' : 'local publish only';
  console.log(`\n  Rumpus running at http://localhost:${PORT}`);
  console.log(`  ${catalog().length} templates · ${mode} · ${deploy}\n`);
});
