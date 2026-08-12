// Credits: who gets to call a model, and how many times.
//
// Two balances, and the split is the whole design:
//
//   free  — granted on arrival and by promo codes. Spends on the FAST tier
//           only, which is Groq's free tier. Costs us essentially nothing, so
//           it can be handed out at a launch without thinking about it.
//   paid  — bought with money. Spends on either tier, including Claude.
//
// That's what makes "give launch visitors some credits, limited to something
// cheap" true by construction rather than by remembering to check.
//
// Identity is a random token the browser keeps. It is a convenience, not a
// security boundary: clearing storage gets you a fresh allowance. That's an
// accepted trade for not making people sign up to try a toy — the per-IP cap
// below is a speed bump for the laziest abuse, not a wall. The real backstop is
// that free credits can only ever spend on the cheap provider.

import { randomUUID } from 'node:crypto';
import { readDoc, writeDoc } from './storage.js';
import { findPromo, isExpired, normalise } from './promos.js';

export const FREE_ON_ARRIVAL = Number(process.env.RUMPUS_FREE_CREDITS ?? 5);
export const MAX_FREE_BALANCE = Number(process.env.RUMPUS_MAX_FREE ?? 60);
const NEW_ACCOUNTS_PER_IP_PER_DAY = Number(process.env.RUMPUS_IP_CAP ?? 8);

export const COST = { fast: 1, best: 2 };

const key = (token) => `credits/${token}`;
const today = () => new Date().toISOString().slice(0, 10);
const ipKey = (ip) => `ipcap/${today()}/${String(ip).replace(/[^a-z0-9.:]/gi, '_')}`;

export const newToken = () => `r_${randomUUID().replace(/-/g, '')}`;

const shape = (token, over = {}) => ({
  token,
  free: 0,
  paid: 0,
  spent: 0,
  redeemed: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

export async function getAccount(token) {
  if (!token || !/^r_[a-f0-9]{32}$/.test(token)) return null;
  return (await readDoc(key(token))) ?? null;
}

async function save(account) {
  account.updatedAt = new Date().toISOString();
  await writeDoc(key(account.token), account);
  return account;
}

/** How many fresh accounts this IP has opened today. A speed bump, not a wall. */
async function bumpIpCount(ip) {
  if (!ip) return 0;
  const k = ipKey(ip);
  const doc = (await readDoc(k)) ?? { count: 0 };
  doc.count += 1;
  await writeDoc(k, doc);
  return doc.count;
}

/**
 * Find the visitor's account, creating one with the arrival grant if this is
 * their first request.
 */
export async function ensureAccount(token, { ip } = {}) {
  const existing = await getAccount(token);
  if (existing) return { account: existing, created: false };

  const count = await bumpIpCount(ip);
  // Past the cap, still give them an account — just no free credits. A shared
  // office NAT shouldn't get a hard door slammed on it, and a promo code or a
  // purchase still works.
  const overCap = count > NEW_ACCOUNTS_PER_IP_PER_DAY;
  const account = shape(newToken(), {
    free: overCap ? 0 : FREE_ON_ARRIVAL,
    rateLimited: overCap || undefined,
  });
  await save(account);
  return { account, created: true, overCap };
}

/** Can this account afford `tier`, and out of which balance? */
export function affords(account, tier) {
  const cost = COST[tier] ?? COST.fast;
  if (tier === 'best') {
    // The point of the split: free credits never buy the expensive model.
    return account.paid >= cost ? { ok: true, from: 'paid', cost } : { ok: false, from: null, cost };
  }
  if (account.free >= cost) return { ok: true, from: 'free', cost };
  if (account.paid >= cost) return { ok: true, from: 'paid', cost };
  return { ok: false, from: null, cost };
}

export async function spend(account, tier) {
  const plan = affords(account, tier);
  if (!plan.ok) return { ok: false, account };
  account[plan.from] -= plan.cost;
  account.spent += plan.cost;
  await save(account);
  return { ok: true, account, from: plan.from, cost: plan.cost };
}

/** Give credits back when a call failed and produced nothing worth charging for. */
export async function refund(account, from, cost) {
  account[from] += cost;
  account.spent = Math.max(0, account.spent - cost);
  return save(account);
}

export async function grantPaid(account, credits, reason = 'purchase') {
  account.paid += Math.max(0, credits);
  account.purchases = [...(account.purchases ?? []), { credits, reason, at: new Date().toISOString() }];
  return save(account);
}

/**
 * Redeem a promo code.
 *
 * The redemption counter is a read-modify-write, so two people redeeming the
 * last slot of a code at the same instant can both get it. Overshooting a
 * launch code by a couple of redemptions is a non-event; making every redeem
 * take a distributed lock would not be.
 */
export async function redeem(account, rawCode) {
  const code = normalise(rawCode);
  const promo = findPromo(code);
  if (!promo) return { ok: false, error: "That code doesn't exist." };
  if (isExpired(promo)) return { ok: false, error: 'That code has expired.' };
  if (account.redeemed?.includes(code)) {
    return { ok: false, error: "You've already used that code." };
  }

  const counterKey = `promo/${code}`;
  const counter = (await readDoc(counterKey)) ?? { code, redemptions: 0 };
  if (counter.redemptions >= promo.maxRedemptions) {
    return { ok: false, error: 'That code has been fully claimed.' };
  }

  const room = Math.max(0, MAX_FREE_BALANCE - account.free);
  const granted = Math.min(promo.credits, room);
  if (granted <= 0) {
    return { ok: false, error: `You're already at the ${MAX_FREE_BALANCE}-credit free maximum.` };
  }

  counter.redemptions += 1;
  await writeDoc(counterKey, counter);

  account.free += granted;
  account.redeemed = [...(account.redeemed ?? []), code];
  await save(account);

  return {
    ok: true,
    granted,
    capped: granted < promo.credits,
    note: promo.note,
    account,
  };
}

/** What the client is allowed to know about its own account. */
export const publicView = (account) => ({
  token: account.token,
  free: account.free,
  paid: account.paid,
  total: account.free + account.paid,
  spent: account.spent,
  redeemed: account.redeemed ?? [],
  cost: COST,
  maxFree: MAX_FREE_BALANCE,
});
