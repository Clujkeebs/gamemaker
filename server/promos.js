// Promo codes.
//
// Deliberately small grants on the cheap tier. A launch code should be enough
// to make something and share it — not enough to be worth farming. Anything
// more generous needs a card, which is the point of the paid tier.
//
// Codes live here rather than in a database because they change with a deploy,
// not with traffic. ROMP_PROMOS can add more without a code change:
//   ROMP_PROMOS='LAUNCHDAY:20:500:2026-12-31,FRIENDS:50:25'
//   (code : credits : maxRedemptions [: expires])

const BUILT_IN = [
  {
    code: 'PRODUCTHUNT',
    credits: 20,
    maxRedemptions: 750,
    expires: '2026-12-31',
    note: 'Product Hunt launch',
  },
  {
    code: 'SHIPATHON',
    credits: 20,
    maxRedemptions: 750,
    expires: '2026-12-31',
    note: 'Shipathon',
  },
  {
    code: 'ROMP',
    credits: 10,
    maxRedemptions: 2000,
    expires: '2026-12-31',
    note: 'Generic "saw it somewhere" code',
  },
];

function fromEnv() {
  const raw = process.env.ROMP_PROMOS;
  if (!raw) return [];
  return raw.split(',').map((entry) => {
    const [code, credits, maxRedemptions, expires] = entry.split(':').map((s) => s?.trim());
    if (!code || !credits) return null;
    return {
      code: code.toUpperCase(),
      credits: Math.max(0, Math.min(200, Number(credits) || 0)),
      maxRedemptions: Number(maxRedemptions) || 100,
      expires: expires || null,
      note: 'configured via ROMP_PROMOS',
    };
  }).filter(Boolean);
}

export const normalise = (code) => String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');

/** Env entries override built-ins with the same code. */
export function allPromos() {
  const byCode = new Map(BUILT_IN.map((p) => [p.code, p]));
  for (const p of fromEnv()) byCode.set(p.code, p);
  return [...byCode.values()];
}

export function findPromo(code) {
  const wanted = normalise(code);
  return allPromos().find((p) => p.code === wanted) ?? null;
}

export const isExpired = (promo, now = new Date()) =>
  Boolean(promo.expires) && new Date(`${promo.expires}T23:59:59Z`) < now;
