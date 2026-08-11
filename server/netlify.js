// Netlify deploy over the file-digest API. No SDK, no CLI, no build step.
//
// Flow: create (or reuse) a site, POST a manifest of sha1 digests, upload only
// the files Netlify says it doesn't already have, then wait for ready. Reusing
// the site id on republish is what keeps a shared link pointing at the game.

import { createHash } from 'node:crypto';

const API = 'https://api.netlify.com/api/v1';

export const hasToken = () => Boolean(process.env.NETLIFY_AUTH_TOKEN);

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

async function call(path, { method = 'GET', body, raw, contentType } = {}) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) throw new Error('NETLIFY_AUTH_TOKEN is not set');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': contentType ?? 'application/json',
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Netlify ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function ensureSite({ siteId, name }) {
  if (siteId) {
    try {
      return await call(`/sites/${siteId}`);
    } catch {
      // Site was deleted on Netlify's side; fall through and make a new one.
    }
  }
  return call('/sites', { method: 'POST', body: { name } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param files  { "/index.html": "<contents>", ... } — paths must start with "/"
 * @returns { url, siteId, deployId, siteName }
 */
export async function deploy({ files, siteId, name }) {
  const site = await ensureSite({ siteId, name });

  const digests = Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha1(c)]));
  const deployment = await call(`/sites/${site.id}/deploys`, {
    method: 'POST',
    body: { files: digests, async: false },
  });

  const needed = new Set(deployment.required ?? []);
  for (const [path, contents] of Object.entries(files)) {
    if (!needed.has(digests[path])) continue;
    await call(`/deploys/${deployment.id}/files${path}`, {
      method: 'PUT',
      raw: contents,
      contentType: 'application/octet-stream',
    });
  }

  let state = deployment;
  for (let i = 0; i < 40 && state.state !== 'ready'; i++) {
    if (state.state === 'error') throw new Error(`Netlify deploy failed: ${state.error_message ?? 'unknown'}`);
    await sleep(750);
    state = await call(`/deploys/${deployment.id}`);
  }

  return {
    url: state.ssl_url || state.url || site.ssl_url || site.url,
    siteId: site.id,
    siteName: site.name,
    deployId: state.id,
    ready: state.state === 'ready',
  };
}

/** Tier 2: attach a domain the user already owns. */
export async function attachDomain({ siteId, domain }) {
  const site = await call(`/sites/${siteId}`);
  const aliases = new Set(site.domain_aliases ?? []);
  aliases.add(domain);
  return call(`/sites/${siteId}`, {
    method: 'PATCH',
    body: { custom_domain: site.custom_domain || domain, domain_aliases: [...aliases] },
  });
}
