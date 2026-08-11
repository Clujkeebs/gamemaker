// Bring-your-own-domain: show the records, then verify they resolve.
//
// We don't control the user's registrar, so this is deliberately a
// show-instructions-and-check flow rather than an automation. The honest part
// is the status reporting: DNS propagation genuinely takes time, and a UI that
// says "failed" three minutes in is lying.

import { Resolver } from 'node:dns/promises';

const isApex = (domain) => domain.split('.').filter(Boolean).length <= 2;

export function validateDomain(input) {
  const domain = String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(domain)) {
    return { ok: false, error: 'That does not look like a domain name. Try something like mygame.com.' };
  }
  if (domain.length > 253) return { ok: false, error: 'Domain is too long.' };
  return { ok: true, domain };
}

/** The records to show the user, given where their site is actually hosted. */
export function instructionsFor(domain, target) {
  const apex = isApex(domain);
  return {
    domain,
    apex,
    records: apex
      ? [
          { type: 'ALIAS', name: '@', value: target, note: 'If your registrar has no ALIAS/ANAME, use their A record for apex domains instead.' },
          { type: 'CNAME', name: 'www', value: target },
        ]
      : [{ type: 'CNAME', name: domain.split('.')[0], value: target }],
    hint: apex
      ? 'Apex domains need ALIAS/ANAME support. A www subdomain is simpler if your registrar does not have it.'
      : 'Add this at your registrar, then come back and check. Propagation is usually minutes, sometimes an hour.',
  };
}

/**
 * Check whether the record is live yet.
 * Queries public resolvers directly rather than the system one: a cached
 * negative from the local resolver would report "not set up" long after the
 * user got it right.
 */
export async function verify(domain, target) {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);

  const found = { cname: [], a: [] };
  await Promise.all([
    resolver.resolveCname(domain).then((r) => (found.cname = r)).catch(() => {}),
    resolver.resolve4(domain).then((r) => (found.a = r)).catch(() => {}),
  ]);

  const targetHost = String(target || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const matches = found.cname.some((c) => c.replace(/\.$/, '') === targetHost);

  if (matches) return { state: 'verified', found, message: `${domain} points at ${targetHost}.` };
  if (found.cname.length || found.a.length) {
    return {
      state: 'mismatch',
      found,
      message: `${domain} resolves, but not to ${targetHost}. Found: ${[...found.cname, ...found.a].join(', ')}.`,
    };
  }
  return {
    state: 'pending',
    found,
    message: `No record for ${domain} yet. DNS can take up to an hour to propagate — this is normal, check again shortly.`,
  };
}
