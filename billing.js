// billing.js - Stripe wrapper for generating Checkout Session URLs. Never throws at require
// time — a bot with no Stripe keys set still boots and runs matchmaking normally, just with
// Subscribe buttons showing a config error instead of a checkout link (see createCheckoutSession).

let stripeClient = null;
let stripeInitAttempted = false;

function getStripeClient() {
  if (stripeInitAttempted) return stripeClient;
  stripeInitAttempted = true;

  if (!process.env.STRIPE_SECRET_KEY) return null;

  const Stripe = require('stripe');
  stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

function isStripeConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_MONTHLY_PRICE_ID && process.env.STRIPE_YEARLY_PRICE_ID);
}

const PRICE_ENV_VARS = {
  monthly: 'STRIPE_MONTHLY_PRICE_ID',
  yearly: 'STRIPE_YEARLY_PRICE_ID',
};

// Returns a fresh, single-use Checkout Session URL for this specific Discord ID. discordId is
// stamped into BOTH the session's own metadata AND subscription_data.metadata — the latter is
// what ends up on the resulting Stripe Subscription object, which is all the
// customer.subscription.deleted webhook payload carries (see webhook-server.js). There's no
// later opportunity to attach it, so this must happen at creation time.
async function createCheckoutSession(discordId, plan) {
  const stripe = getStripeClient();
  if (!stripe) {
    throw new Error('Subscriptions aren\'t configured on this bot yet — ask an admin to set STRIPE_SECRET_KEY.');
  }

  const priceId = process.env[PRICE_ENV_VARS[plan]];
  if (!priceId) {
    throw new Error(`Subscriptions aren't configured on this bot yet — ask an admin to set ${PRICE_ENV_VARS[plan]}.`);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { discordId, plan },
    subscription_data: { metadata: { discordId, plan } },
    success_url: process.env.STRIPE_SUCCESS_URL || 'https://discord.com',
    cancel_url: process.env.STRIPE_CANCEL_URL || 'https://discord.com',
  });

  return session.url;
}

module.exports = { isStripeConfigured, createCheckoutSession };
