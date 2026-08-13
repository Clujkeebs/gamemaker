// Bring-your-own-domain: show the records, then verify they resolve.
//
// We don't control the user's registrar, so this is deliberately a
// show-instructions-and-check flow rather than an automation. The honest part
// is the status reporting: DNS propagation genuinely takes time, and a UI that
// says "failed" three minutes in is lying.

import { Resolver } from 'node:dns/promises';

// Multi-label public suffixes common enough to matter. Counting dots alone gets
// mygame.co.uk wrong — it calls it a subdomain and tells the user to add
// "CNAME mygame" at the co.uk level, which nobody can do. This is not the full
// public suffix list and isn't meant to be; it's the set a hobby game domain is
// realistically registered under. Anything unlisted falls back to dot-counting,
// which is right for every single-label TLD.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'co.nz', 'co.za', 'co.jp', 'co.kr', 'co.in', 'co.il',
  'com.au', 'net.au', 'org.au', 'com.br', 'com.mx', 'com.ar',
  'com.tr', 'com.cn', 'com.sg', 'com.hk', 'com.tw', 'com.pl',
  'or.jp', 'ne.jp', 'go.jp',
]);

/**
 * Is this the whole registrable domain rather than a subdomain of one?
 *
 * Apex matters for two reasons: the records differ, and an apex physically
 * cannot carry a CNAME — that's a DNS rule, not a registrar limitation.
 */
export function isApex(domain) {
  const labels = String(domain).split('.').filter(Boolean);
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.length <= 3 : labels.length <= 2;
}

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

/** Public resolvers, not the system one — see verify(). */
function publicResolver() {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  return resolver;
}

const bare = (host) => String(host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');

/**
 * Check whether the record is live yet.
 *
 * Queries public resolvers directly rather than the system one: a cached
 * negative from the local resolver would report "not set up" long after the
 * user got it right.
 *
 * `resolver` is injectable so the address path can be tested without a network.
 */
export async function verify(domain, target, resolver = publicResolver()) {
  const targetHost = bare(target);

  const found = { cname: [], a: [] };
  await Promise.all([
    resolver.resolveCname(domain).then((r) => (found.cname = r)).catch(() => {}),
    resolver.resolve4(domain).then((r) => (found.a = r)).catch(() => {}),
  ]);

  const verified = (message) => ({ state: 'verified', found, message });

  if (found.cname.some((c) => bare(c) === targetHost)) {
    return verified(`${domain} points at ${targetHost}.`);
  }

  // An apex domain can't hold a CNAME, so the ALIAS/A record we asked for
  // resolves to addresses rather than to a name. Comparing it against the
  // target's *name* would never match, which used to leave a correctly
  // configured apex stuck reporting "mismatch" forever. Compare addresses.
  if (found.a.length && targetHost) {
    const targetIps = await resolver.resolve4(targetHost).catch(() => []);
    if (targetIps.length && found.a.some((ip) => targetIps.includes(ip))) {
      return verified(`${domain} points at the same address as ${targetHost}.`);
    }
  }

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
