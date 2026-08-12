// Netlify Function: the whole Rumpus API on one route.
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

    let body = {};
    if (request.method === 'POST') {
      const text = await request.text();
      if (text) {
        try {
          body = JSON.parse(text);
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
    });
    return json(out.status, out.body);
  } catch (err) {
    console.error('[rumpus]', path, err);
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
