// webhook-server.js - Standalone Express app receiving Stripe webhook events and the Epic OAuth
// callback. Each route is only registered if its own env vars are present, and the server only
// listens at all if at least one of them is — no dangling unauthenticated port, and it never
// blocks the bot's own startup. This is the only HTTP surface this bot exposes.
//
// Deployment note: registering https://<your-domain>/stripe/webhook in the Stripe Dashboard,
// registering https://<your-domain>/epic-callback as the OAuth redirect URI on the Epic
// Games developer portal, and exposing this port publicly (reverse proxy, or a tunnel like
// ngrok/Cloudflare Tunnel for local dev), are manual one-time steps this code cannot automate.

const express = require('express');
const SubscriptionModel = require('./models/Subscription');
const access = require('./access');
const { dmUser } = require('./discord-dm');
const { buildPaymentFailedDmEmbed } = require('./embeds');
const epicOAuth = require('./epic-oauth');
const playerStore = require('./players');
const { getRoleId, getChannelId } = require('./guild-config');

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

// Shared DB-write step for "this Discord user now has an active subscription" — used by the real
// checkout.session.completed handler below (subscriptionExpiry computed from Stripe's own
// current_period_end) and by simulateCheckoutCompleted (a fabricated expiry, for /test-webhook),
// so a mod-run test exercises the exact same activation path a real payment would.
async function activateSubscription(discordId, plan, subscriptionExpiry, { stripeCustomerId = null, stripeSubscriptionId = null } = {}) {
  await SubscriptionModel.findOneAndUpdate(
    { discordId },
    {
      $set: {
        plan,
        status: 'active',
        subscriptionStart: new Date(),
        subscriptionExpiry,
        stripeCustomerId,
        stripeSubscriptionId,
        // Reset so a resubscribe -> lapse -> resubscribe -> lapse cycle still gets an expiry DM
        // on every lapse, not just the first.
        subscriptionExpiredDmSent: false,
      },
    },
    { upsert: true }
  );

  access.invalidateCache(discordId);
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

  await activateSubscription(discordId, plan, subscriptionExpiry, {
    stripeCustomerId: session.customer,
    stripeSubscriptionId: session.subscription,
  });

  console.log(`[webhook] checkout.session.completed — ${discordId} subscribed (${plan}), access until ${subscriptionExpiry.toISOString()}`);
}

// Test-only entry point for /test-webhook (mod command, index.js). Bypasses Stripe entirely —
// no API call, no real session/subscription needed — so mods can verify the activation path
// (Subscription doc written, access cache invalidated, #access reflects it) without a real
// payment or a live Stripe test-mode checkout.
async function simulateCheckoutCompleted(discordId, plan) {
  const days = plan === 'yearly' ? 365 : 30;
  const subscriptionExpiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  await activateSubscription(discordId, plan, subscriptionExpiry, {
    stripeCustomerId: 'test_customer',
    stripeSubscriptionId: `test_sub_${Date.now()}`,
  });

  console.log(`[webhook] [TEST] simulated checkout.session.completed — ${discordId} subscribed (${plan}), access until ${subscriptionExpiry.toISOString()}`);
  return subscriptionExpiry;
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

// Minimal HTML escape for values that end up in the browser-facing result page below — dn
// (display name) comes back from Epic's token response, so it's attacker-influenceable in
// principle (a crafted display name) even though Epic's own UI restricts what it can contain.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// The browser tab Epic redirects back to after /epic-callback finishes — the actual "you're
// linked" notification goes to Discord (notifyEpicLinkResult below); this is just what the player
// sees in the tab itself so they know it's safe to close.
function renderEpicResultPage(success, message) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${success ? 'Epic Account Linked' : 'Linking Failed'}</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 60px 20px;">
  <h2>${success ? '✅ Success' : '❌ Something went wrong'}</h2>
  <p>${message}</p>
  <p>You can close this tab and return to Discord.</p>
</body></html>`;
}

// DM first; if the player has DMs closed, fall back to posting in #register (tagging them) so the
// result isn't silently lost. Deliberately separate from discord-dm.js's dmUser, which swallows
// failures — this needs to know whether the DM actually landed to decide whether to fall back.
async function notifyEpicLinkResult(client, discordId, guildId, content) {
  try {
    const user = await client.users.fetch(discordId);
    await user.send({ content });
    return;
  } catch (err) {
    console.warn(`[epic-oauth] Could not DM ${discordId}, falling back to #register:`, err.message);
  }

  const registerChannelId = getChannelId(guildId, 'register');
  if (!registerChannelId) return;
  try {
    const channel = await client.channels.fetch(registerChannelId);
    await channel.send({ content: `<@${discordId}> ${content}` });
  } catch (err) {
    console.error('[epic-oauth] Failed to post fallback link result in #register:', err.message);
  }
}

function startWebhookServer(client) {
  const stripeEnabled = !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
  const epicEnabled = epicOAuth.isConfigured();

  if (!stripeEnabled && !epicEnabled) {
    console.warn('[webhook] Neither Stripe nor Epic OAuth env vars are set — webhook server not started.');
    return null;
  }

  const app = express();

  // Temporary diagnostic — confirms whether requests are reaching this Express app at all before
  // any route-specific parsing runs. Remove once the Stripe signature verification issue is
  // resolved.
  app.use((req, res, next) => {
    console.log('[express] incoming:', req.method, req.url, 'content-type:', req.headers['content-type']);
    next();
  });

  if (!stripeEnabled) {
    console.warn('[webhook] STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET not set — /stripe/webhook disabled. Subscriptions are disabled.');
  }
  if (!epicEnabled) {
    console.warn('[webhook] EPIC_CLIENT_ID/EPIC_CLIENT_SECRET/EPIC_REDIRECT_URI not set — /epic-callback disabled. Epic linking falls back to Yunite only.');
  }

  if (stripeEnabled) {
    const stripe = getStripeSdk();

    // express.raw (not express.json) on this route only — Stripe's signature check needs the
    // exact raw bytes. No other routes or body-parser middleware exist on this app.
    //
    // type: '*/*' (not the default 'application/json') — body-parser only captures the body when
    // the request's Content-Type header matches this filter; anything else leaves req.body
    // undefined, which is what makes stripe.webhooks.constructEvent throw "No webhook payload was
    // provided." A reverse proxy (Nginx here) sitting in front is a common way for that header to
    // arrive altered or missing even though Stripe sent 'application/json' — since this route has
    // no purpose other than consuming Stripe webhooks, always reading the raw body regardless of
    // the advertised Content-Type is safe and removes that failure mode entirely.
    app.post('/stripe/webhook', express.raw({ type: '*/*' }), async (req, res) => {
      // Temporary diagnostic for the "No signatures found matching the expected signature"
      // failure — confirms whether req.body is still the exact raw Buffer Stripe sent (Nginx is
      // suspected of rewriting/re-encoding the body before it reaches this process) and whether
      // the stripe-signature header itself is arriving intact.
      console.log(
        `[webhook] Received /stripe/webhook — body is Buffer: ${Buffer.isBuffer(req.body)}, ` +
        `length: ${Buffer.isBuffer(req.body) ? req.body.length : 'n/a'}, ` +
        `stripe-signature: ${req.headers['stripe-signature'] ?? '(missing)'}`
      );

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
  }

  if (epicEnabled) {
    // GET, not POST — this is a browser redirect from Epic's own authorize page, carrying `code`
    // and `state` as query params, not a JSON body. No body-parser needed on this route at all.
    app.get('/epic-callback', async (req, res) => {
      const { code, state, error: epicError } = req.query;

      if (epicError) {
        return res.status(400).send(renderEpicResultPage(false, 'Epic Games declined the request.'));
      }

      const decoded = epicOAuth.decodeState(state);
      if (!decoded) {
        return res.status(400).send(renderEpicResultPage(
          false, 'This link is invalid or has expired. Go back to #register in Discord and click "Link Epic Account" again.'
        ));
      }
      const { discordId, guildId } = decoded;

      if (!code) {
        return res.status(400).send(renderEpicResultPage(false, 'No authorization code was provided by Epic Games.'));
      }

      let epicId, epicUsername;
      try {
        ({ epicId, epicUsername } = await epicOAuth.exchangeCodeForToken(code));
      } catch (err) {
        console.error('[epic-oauth] Token exchange failed:', err.message);
        await notifyEpicLinkResult(
          client, discordId, guildId,
          '❌ Linking your Epic account failed. You can try again, or link via Yunite in #register in the meantime.'
        );
        return res.status(502).send(renderEpicResultPage(
          false, 'Failed to complete linking with Epic Games. You can try again, or use Yunite instead.'
        ));
      }

      try {
        await playerStore.upsertPlayer(guildId, discordId, {
          epicId, epicUsername, epicOAuthLinked: true, epicLinkedAt: new Date(),
        });

        // Mirrors what Yunite's own verified-role assignment used to do — see permissions.js's
        // progressive-visibility ladder, which gates #get-roles/#how-to-use behind this role
        // regardless of which linking method granted it.
        const verifiedRoleId = getRoleId(guildId, 'yuniteVerified');
        if (verifiedRoleId) {
          const guild = await client.guilds.fetch(guildId).catch(() => null);
          const member = await guild?.members.fetch(discordId).catch(() => null);
          if (member) {
            await member.roles.add(verifiedRoleId).catch(err => console.error('[epic-oauth] Failed to assign verified role:', err.message));
          }
        }

        console.log(`[epic-oauth] Linked Discord ${discordId} <-> Epic ${epicUsername} (${epicId}) in guild ${guildId}`);
        await notifyEpicLinkResult(client, discordId, guildId, `✅ Your Epic account **${epicUsername}** is now linked!`);
        res.send(renderEpicResultPage(true, `Linked as ${escapeHtml(epicUsername)}!`));
      } catch (err) {
        console.error('[epic-oauth] Failed to store linked account:', err.message);
        res.status(500).send(renderEpicResultPage(false, 'Linked with Epic Games, but saving your account failed. Please try again.'));
      }
    });
  }

  const port = process.env.PORT || 3000;
  console.log('[webhook] Express server starting on port', port);
  const server = app.listen(port, () => {
    const routes = [stripeEnabled && 'POST /stripe/webhook', epicEnabled && 'GET /epic-callback'].filter(Boolean);
    console.log(`[webhook] Server listening on port ${port} (${routes.join(', ')})`);
  });

  return server;
}

module.exports = { startWebhookServer, simulateCheckoutCompleted };
