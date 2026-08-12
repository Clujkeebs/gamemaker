// Local Rumpus server. Zero dependencies: node:http, node:fs, built-in fetch.
//
// A thin transport over server/api.js — the same module the Netlify Function
// calls — plus static file serving, which on Netlify is the CDN's job.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { ROOT, catalog } from './registry.js';
import { handleApi, serveBundleFile, mimeFor } from './api.js';
import { hasKey, MODEL } from './anthropic.js';
import { backendName } from './storage.js';
import { hasToken } from './netlify.js';

const PORT = Number(process.env.PORT || 4173);

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
  const body = readFileSync(absPath);
  const ext = extname(absPath).toLowerCase();
  res.writeHead(200, {
    'content-type': mimeFor(absPath),
    'content-length': body.length,
    // The preview iframe is sandboxed without allow-same-origin, so its origin
    // is opaque and its ES module fetches count as cross-origin. Without this
    // the engine never loads. Netlify does the same via netlify.toml.
    'access-control-allow-origin': '*',
    'cache-control': ext === '.html' ? 'no-store' : 'no-cache',
  });
  res.end(body);
  return true;
}

/** Resolve a URL path under a root, refusing anything that escapes it. */
function safeJoin(root, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath))
    .replace(/^(\.\.[/\\])+/, '')
    .replace(/^[/\\]+/, '');
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  try {
    if (path.startsWith('/api/')) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await handleApi({
        method: req.method,
        pathname: path,
        searchParams: url.searchParams,
        body,
      });
      return json(res, out.status, out.body);
    }

    // Published bundles, served from wherever storage put them.
    const published = path.match(/^\/p\/([a-z0-9-]+)(\/.*)?$/);
    if (published) {
      const out = await serveBundleFile(published[1], published[2]);
      res.writeHead(out.status, { 'content-type': out.contentType, 'cache-control': 'no-store' });
      return res.end(out.body);
    }

    // Engine and shared modules, for the preview frame and local bundles.
    if (path.startsWith('/templates/') || path.startsWith('/shared/')) {
      const abs = safeJoin(ROOT, path);
      if (abs && serveFile(res, abs)) return;
    }

    const abs = safeJoin(join(ROOT, 'web'), path === '/' ? '/index.html' : path);
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
  const deploy = hasToken() ? 'Netlify deploy ready' : 'local publish only';
  console.log(`\n  Rumpus running at http://localhost:${PORT}`);
  console.log(`  ${catalog().length} templates · ${mode} · ${deploy} · store: ${backendName()}\n`);
});
