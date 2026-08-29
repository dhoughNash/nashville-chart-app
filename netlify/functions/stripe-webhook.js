// Save this file at: netlify/functions/stripe-webhook.js
// (create via GitHub -> Add file -> Create new file, type the full path
// into the filename field -- GitHub creates the folders automatically)

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Maps each subscription price -- by its unique Stripe Price ID, not
// dollar amount -- to a tier. Price IDs are globally unique, so this can
// never accidentally match a price from a different app sharing the same
// Stripe account (matching on amount alone couldn't guarantee that).
const TIER_BY_PRICE_ID = {
  price_1U9nFyRru8MEHEIA9hC25Ib9: { tier: 'starter', chartsLimit: 10 },
  price_1U9nGSRru8MEHEIAQL14YVvA: { tier: 'pro', chartsLimit: 30 },
  price_1U9nGqRru8MEHEIAkzm4HaMG: { tier: 'unlimited', chartsLimit: 100 },
};

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    // Must be the RAW body, not JSON-parsed, or signature verification fails
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: `Webhook signature verification failed: ${err.message}` };
  }

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const userId = session.client_reference_id;
      if (!userId) {
        return { statusCode: 200, body: 'No client_reference_id on session, ignoring.' };
      }

      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const priceId = subscription.items.data[0].price.id;
      const tierInfo = TIER_BY_PRICE_ID[priceId];
      if (!tierInfo) {
        // Not one of our three prices -- almost certainly a purchase from
        // a different app on the same Stripe account. Ignore it.
        return { statusCode: 200, body: `Price ${priceId} isn't one of ours, ignoring.` };
      }

      // Upsert, not update -- this may be the user's very first row.
      await upsertByUserId(userId, {
        status: 'active',
        tier: tierInfo.tier,
        charts_limit: tierInfo.chartsLimit,
        charts_used: 0,
        period_reset_at: new Date(subscription.current_period_end * 1000).toISOString(),
        stripe_customer_id: session.customer,
        stripe_subscription_id: subscription.id,
      });
    }

    if (stripeEvent.type === 'customer.subscription.updated') {
      const subscription = stripeEvent.data.object;
      const priceId = subscription.items.data[0].price.id;
      const tierInfo = TIER_BY_PRICE_ID[priceId];
      if (!tierInfo) {
        // Not one of our three prices -- a different app's subscription
        // event on the same Stripe account. Ignore it entirely.
        return { statusCode: 200, body: `Price ${priceId} isn't one of ours, ignoring.` };
      }

      let status = 'active';
      if (['past_due', 'unpaid'].includes(subscription.status)) status = 'past_due';
      else if (['canceled', 'incomplete_expired'].includes(subscription.status)) status = 'cancelled';

      const patchData = {
        status,
        tier: tierInfo.tier,
        charts_limit: tierInfo.chartsLimit,
        stripe_subscription_id: subscription.id,
        period_reset_at: new Date(subscription.current_period_end * 1000).toISOString(),
      };
      // A fresh billing period (renewal, or moving between tiers) resets usage
      if (status === 'active') {
        patchData.charts_used = 0;
      }

      await patchByStripeCustomerId(subscription.customer, patchData);
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      const subscription = stripeEvent.data.object;
      const priceId = subscription.items.data[0].price.id;
      if (!TIER_BY_PRICE_ID[priceId]) {
        return { statusCode: 200, body: `Price ${priceId} isn't one of ours, ignoring.` };
      }
      // Never delete the user's charts or data on cancellation -- just drop
      // access. Removes the "I lost everything" support problem entirely.
      await patchByStripeCustomerId(subscription.customer, { status: 'cancelled' });
    }

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: `Handler error: ${err.message}` };
  }
};

async function upsertByUserId(userId, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ user_id: userId, ...data }),
  });
  if (!resp.ok) throw new Error(`Supabase upsert failed: ${resp.status} ${await resp.text()}`);
}

async function patchByStripeCustomerId(customerId, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?stripe_customer_id=eq.${customerId}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`Supabase patch failed: ${resp.status} ${await resp.text()}`);
}
