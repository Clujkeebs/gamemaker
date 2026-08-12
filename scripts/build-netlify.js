// Assemble the static publish directory for Netlify.
//
// Netlify serves exactly one directory, but the app's static assets live in
// three (web/, shared/, templates/) and the paths they reference each other by
// have to survive. So this copies them into build/ preserving those paths —
// no bundler, no transform, same files the local server hands out.

import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build');

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// web/ becomes the site root; the other two keep their directory names because
// engines import each other by relative path.
cpSync(join(ROOT, 'web'), OUT, { recursive: true });
cpSync(join(ROOT, 'shared'), join(OUT, 'shared'), { recursive: true });

// Only the engine files are needed at runtime. Schemas and example configs are
// read server-side by the function, which gets them via included_files.
for (const id of readdirSync(join(ROOT, 'templates'), { withFileTypes: true })) {
  if (!id.isDirectory()) continue;
  mkdirSync(join(OUT, 'templates', id.name), { recursive: true });
  cpSync(join(ROOT, 'templates', id.name, 'engine.js'), join(OUT, 'templates', id.name, 'engine.js'));
}

// The published-bundle route is a function, so tell crawlers not to index the
// generated games under it as if they were pages of this site.
writeFileSync(join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /p/\n');

const count = readdirSync(join(OUT, 'templates')).length;
console.log(`build/ ready — ${count} engines, shared modules, and the editor`);
