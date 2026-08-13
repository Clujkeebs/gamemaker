// Netlify Function: the whole Romp API on one route.
//
// Deliberately thin. Everything it does lives in server/api.js, which the local
// Node server also calls — so the deployed app and `npm start` cannot drift
// apart. The only real difference between them is where storage.js writes.

import { handleApi, serveBundleFile } from '../../server/api.js';

export default async (request) => {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    // Published bundles come out of Blobs, since a function has no durable disk.
    const published = path.match(/^\/p\/([a-z0-9-]+)(\/.*)?$/);
    if (published) {
      const out = await serveBundleFile(published[1], published[2]);
      return new Response(out.body, {
        status: out.status,
        headers: { 'content-type': out.contentType, 'cache-control': 'no-store' },
      });
    }

    let raw = '';
    let body = {};
    if (request.method === 'POST') {
      raw = await request.text();
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return json(400, { error: 'request body was not valid JSON' });
        }
      }
    }

    const out = await handleApi({
      method: request.method,
      pathname: path,
      searchParams: url.searchParams,
      body,
      rawBody: raw,
      headers: Object.fromEntries(request.headers),
      token: request.headers.get('x-romp-token'),
      // Netlify's own header; request.headers has no peer address.
      ip: request.headers.get('x-nf-client-connection-ip') ?? request.headers.get('x-forwarded-for'),
      origin: url.origin,
    });
    return json(out.status, out.body);
  } catch (err) {
    console.error('[romp]', path, err);
    return json(500, { error: String(err?.message ?? err) });
  }
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Claim both prefixes so no redirect rules are needed to reach this.
export const config = { path: ['/api/*', '/p/*'] };
