// webhook-server.js - Standalone Express app receiving Stripe webhook events. Does not start
// listening at all if Stripe env vars are missing — no dangling unauthenticated port, and it
// never blocks the bot's own startup. This is the only HTTP surface this bot exposes.
//
// Deployment note: registering https://<your-domain>/stripe/webhook in the Stripe Dashboard, and
// exposing this port publicly (reverse proxy, or a tunnel like ngrok/Cloudflare Tunnel for local
// dev), are manual one-time steps this code cannot automate.

const express = require('express');
const SubscriptionModel = require('./models/Subscription');
const access = require('./access');
const { dmUser } = require('./discord-dm');
const { buildPaymentFailedDmEmbed } = require('./embeds');

function getStripeSdk() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// Current Stripe API versions moved current_period_end off the top-level Subscription object
// onto each subscription item (subscription.items.data[0].current_period_end) — confirmed
// against this account's real API responses, where the top-level field is undefined. Falls back
// to the legacy top-level field for accounts pinned to an older API version, and throws loudly
// rather than silently writing an Invalid Date if neither shape has it.
function getCurrentPeriodEnd(subscription) {
  const periodEnd = subscription.items?.data?.[0]?.current_period_end ?? subscription.current_period_end;
  if (!periodEnd) {
    throw new Error(`Could not determine current_period_end for subscription ${subscription.id}`);
  }
  return new Date(periodEnd * 1000);
}

async function handleCheckoutCompleted(stripe, session) {
  const discordId = session.metadata?.discordId;
  const plan = session.metadata?.plan;

  if (!discordId || !plan) {
    console.error('[webhook] checkout.session.completed missing discordId/plan metadata — ignoring', session.id);
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  const subscriptionExpiry = getCurrentPeriodEnd(subscription);

  await SubscriptionModel.findOneAndUpdate(
    { discordId },
    {
      $set: {
        plan,
        status: 'active',
        subscriptionStart: new Date(),
        subscriptionExpiry,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        // Reset so a resubscribe -> lapse -> resubscribe -> lapse cycle still gets an expiry DM
        // on every lapse, not just the first.
        subscriptionExpiredDmSent: false,
      },
    },
    { upsert: true }
  );

  access.invalidateCache(discordId);
  console.log(`[webhook] checkout.session.completed — ${discordId} subscribed (${plan}), access until ${subscriptionExpiry.toISOString()}`);
}

async function handleSubscriptionDeleted(subscription) {
  const discordId = subscription.metadata?.discordId;

  if (!discordId) {
    console.error('[webhook] customer.subscription.deleted missing discordId metadata — ignoring', subscription.id);
    return;
  }

  // Deliberately does NOT touch subscriptionExpiry — that's what preserves "access until period
  // end" even after cancellation.
  await SubscriptionModel.updateOne(
    { discordId, stripeSubscriptionId: subscription.id },
    { $set: { status: 'cancelled' } }
  );

  access.invalidateCache(discordId);
  console.log(`[webhook] customer.subscription.deleted — ${discordId} cancelled, access continues until period end`);
}

// Fires on renewals, proration changes, plan swaps, etc. — narrowly scoped to just refreshing
// subscriptionExpiry from Stripe's own current_period_end, so it can't accidentally clobber
// status (checkout.session.completed/customer.subscription.deleted own that).
async function handleSubscriptionUpdated(subscription) {
  const discordId = subscription.metadata?.discordId;

  if (!discordId) {
    console.error('[webhook] customer.subscription.updated missing discordId metadata — ignoring', subscription.id);
    return;
  }

  const subscriptionExpiry = getCurrentPeriodEnd(subscription);

  await SubscriptionModel.updateOne(
    { discordId, stripeSubscriptionId: subscription.id },
    { $set: { subscriptionExpiry } }
  );

  access.invalidateCache(discordId);
  console.log(`[webhook] customer.subscription.updated — ${discordId} expiry now ${subscriptionExpiry.toISOString()}`);
}

// Resolved via stripeCustomerId rather than metadata — Stripe invoices don't inherit the
// subscription's metadata automatically, but every subscriber's Stripe customer id is already on
// their record from checkout.session.completed.
async function handleInvoicePaymentFailed(invoice, client) {
  const customerId = invoice.customer;
  if (!customerId) {
    console.error('[webhook] invoice.payment_failed missing customer id — ignoring', invoice.id);
    return;
  }

  const doc = await SubscriptionModel.findOne({ stripeCustomerId: customerId });
  if (!doc) {
    console.error(`[webhook] invoice.payment_failed — no Subscription record for Stripe customer ${customerId}`);
    return;
  }

  await dmUser(client, doc.discordId, { embeds: [buildPaymentFailedDmEmbed()] });
  console.log(`[webhook] invoice.payment_failed — warned ${doc.discordId}`);
}

function startWebhookServer(client) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('[webhook] STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET not set — webhook server not started. Subscriptions are disabled.');
    return null;
  }

  const stripe = getStripeSdk();
  const app = express();

  // express.raw (not express.json) on this route only — Stripe's signature check needs the
  // exact raw bytes. No other routes or body-parser middleware exist on this app.
  app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[webhook] Signature verification failed:', err.message);
      return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        await handleCheckoutCompleted(stripe, event.data.object);
      } else if (event.type === 'customer.subscription.deleted') {
        await handleSubscriptionDeleted(event.data.object);
      } else if (event.type === 'customer.subscription.updated') {
        await handleSubscriptionUpdated(event.data.object);
      } else if (event.type === 'invoice.payment_failed') {
        await handleInvoicePaymentFailed(event.data.object, client);
      }
      res.json({ received: true });
    } catch (err) {
      console.error(`[webhook] Failed to handle ${event.type}:`, err.message);
      res.status(500).json({ error: 'internal error handling event' });
    }
  });

  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log(`[webhook] Stripe webhook server listening on port ${port} (POST /stripe/webhook)`);
  });

  return server;
}

module.exports = { startWebhookServer };
