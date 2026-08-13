// Exercises the Netlify Function entry point in-process.
//
// It can't reach Netlify from CI, but it can prove the part that actually
// breaks deploys: that the function's module graph resolves, that every route
// works through the Request/Response shell, and that the files the server reads
// off disk are the ones netlify.toml lists in included_files. A bundle missing a
// schema fails at runtime in production and nowhere else.
//
// Run: node --test test/function.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import handler from '../netlify/functions/api.mjs';
import { ROOT, templates } from '../server/registry.js';

const call = (path, { method = 'GET', body } = {}) =>
  handler(new Request(`https://romp-gg.netlify.app${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));

test('the function answers health with the templates loaded', async () => {
  const res = await call('/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.templates, templates.size);
  assert.equal(body.storage, 'filesystem', 'should report the local backend when not on Netlify');
});

test('the function generates a playable game through the Request shell', async () => {
  const res = await call('/api/generate', {
    method: 'POST',
    body: { prompt: 'a cat ninja wall-jumping through a bamboo forest' },
  });
  assert.equal(res.status, 200);
  const game = await res.json();
  assert.ok(templates.has(game.template_id));
  assert.ok(game.config.style, 'no style on the generated config');
});

test('the function publishes and then serves the bundle back', async () => {
  const gen = await (await call('/api/generate', {
    method: 'POST', body: { prompt: 'a robot pushing crates in a warehouse' },
  })).json();

  const pub = await (await call('/api/publish', { method: 'POST', body: { game: gen } })).json();
  assert.ok(pub.slug, 'publish returned no slug');
  assert.ok(pub.files > 5, `expected a real bundle, got ${pub.files} files`);

  const page = await call(`/p/${pub.slug}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /<title>/);

  const game = await call(`/p/${pub.slug}/game.html`);
  assert.match(await game.text(), /ROMP_CONFIG/);

  const engine = await call(`/p/${pub.slug}/templates/${gen.template_id}/engine.js`);
  assert.equal(engine.status, 200);
  assert.match(engine.headers.get('content-type'), /javascript/);
});

test('the function refuses to climb out of a bundle', async () => {
  const res = await call('/p/anything/../../../package.json');
  assert.ok(res.status === 400 || res.status === 404, `path traversal returned ${res.status}`);
});

test('bad JSON and unknown routes fail as JSON, not as a stack trace', async () => {
  const unknown = await call('/api/nope');
  assert.equal(unknown.status, 404);
  assert.ok((await unknown.json()).error);

  const broken = await handler(new Request('https://x.dev/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oh no',
  }));
  assert.equal(broken.status, 400);
});

test('netlify.toml lists every runtime file the server reads off disk', () => {
  // esbuild can only see static imports. Anything read with fs at runtime has to
  // be named in included_files or it simply will not be in the bundle.
  const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  const patterns = [...toml.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const covered = (path) =>
    patterns.some((p) => new RegExp(`^${p.replace(/\*\*/g, '.*').replace(/(?<!\.)\*/g, '[^/]*')}$`).test(path));

  const needed = [
    'arcade/schema.json',
    ...[...templates.keys()].flatMap((id) => [
      `templates/${id}/schema.json`,
      `templates/${id}/engine.js`,
    ]),
  ];
  for (const path of needed) {
    assert.ok(covered(path), `netlify.toml included_files does not cover ${path}`);
  }
});

test('the static build directory carries every engine the editor can preview', async () => {
  const { execSync } = await import('node:child_process');
  execSync('node scripts/build-netlify.js', { cwd: ROOT, stdio: 'pipe' });
  const { existsSync } = await import('node:fs');
  for (const id of templates.keys()) {
    assert.ok(existsSync(join(ROOT, 'build', 'templates', id, 'engine.js')), `build/ is missing ${id}`);
  }
  for (const file of ['index.html', 'preview.html', 'app.js', 'styles.css', 'shared/runtime.js']) {
    assert.ok(existsSync(join(ROOT, 'build', file)), `build/ is missing ${file}`);
  }
});
