// Stripe Checkout, over REST.
//
// No SDK: Stripe's API is form-encoded HTTP and the webhook signature is an
// HMAC, both of which node can do unaided. That keeps the function bundle small
// and the dependency list at one.
//
// Prices are defined here in cents and sent inline as price_data, so there is
// nothing to create in the Stripe dashboard before this works — no products, no
// price IDs to copy. Add the key, and it runs.

import { createHmac, timingSafeEqual } from 'node:crypto';

const API = (process.env.STRIPE_BASE_URL || 'https://api.stripe.com').replace(/\/$/, '');

export const hasStripe = () => Boolean(process.env.STRIPE_SECRET_KEY);
export const isTestMode = () => (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_');

// Small packs on purpose. This is a toy that costs pennies to run; charging
// like it's infrastructure would be silly.
export const PACKS = {
  small: { id: 'small', credits: 100, cents: 500, label: '100 credits' },
  large: { id: 'large', credits: 500, cents: 2000, label: '500 credits', badge: 'best value' },
};

export const packList = () =>
  Object.values(PACKS).map((p) => ({ ...p, price: `$${(p.cents / 100).toFixed(2)}` }));

/** Stripe takes form encoding, including for nested fields. */
function encode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) encode(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => encode({ [i]: item }, key, out));
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: encode(body).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `Stripe ${res.status}`);
  }
  return data;
}

/**
 * @returns { url } — where to send the browser.
 * The visitor's token rides in metadata so the webhook knows whose balance to
 * top up. It's opaque and useless on its own, which is why it's safe to put there.
 */
export async function createCheckout({ pack, token, origin }) {
  const chosen = PACKS[pack];
  if (!chosen) throw new Error('unknown pack');
  if (!hasStripe()) throw new Error('Payments are not configured on this deployment.');

  const session = await stripe('/v1/checkout/sessions', {
    mode: 'payment',
    success_url: `${origin}/?paid=1&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?paid=0`,
    client_reference_id: token,
    // Let Stripe collect a promotion code at checkout too, so a discount can be
    // run without another code path in this app.
    allow_promotion_codes: true,
    metadata: { romp_token: token, credits: chosen.credits, pack: chosen.id },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: chosen.cents,
        product_data: {
          name: `Romp — ${chosen.label}`,
          description: 'Credits for generating and editing games. They do not expire.',
        },
      },
    }],
  });
  return { url: session.url, id: session.id };
}

/**
 * Verify a webhook came from Stripe.
 *
 * Signature check is the only thing standing between this endpoint and anyone
 * granting themselves credits with a curl, so it is not optional: with no
 * secret configured this returns false rather than trusting the payload.
 */
export function verifyWebhook(rawBody, signatureHeader, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  if (!secret || !signatureHeader) return { ok: false, error: 'webhook signature not configured' };

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => p.split('=').map((s) => s.trim()))
  );
  const timestamp = parts.t;
  const provided = parts.v1;
  if (!timestamp || !provided) return { ok: false, error: 'malformed signature header' };

  // Reject replays of an old, legitimately-signed request.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    return { ok: false, error: 'signature timestamp outside tolerance' };
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'signature mismatch' };
  }

  try {
    return { ok: true, event: JSON.parse(rawBody) };
  } catch {
    return { ok: false, error: 'body was not valid JSON' };
  }
}

/** Pull the bits we care about out of a checkout.session.completed event. */
export function creditsFromEvent(event) {
  if (event?.type !== 'checkout.session.completed') return null;
  const session = event.data?.object ?? {};
  if (session.payment_status !== 'paid') return null;
  const token = session.metadata?.romp_token ?? session.client_reference_id;
  const credits = Number(session.metadata?.credits);
  if (!token || !Number.isFinite(credits) || credits <= 0) return null;
  return { token, credits, sessionId: session.id };
}
