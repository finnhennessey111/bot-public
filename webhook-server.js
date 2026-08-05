// webhook-server.js - Standalone Express app receiving Stripe webhook events, the Epic OAuth
// callback, the Discord OAuth "pay through the website" hand-off, and the GitHub auto-deploy
// webhook. Each route is only registered if its own env vars are present, and the server only
// listens at all if at least one of them is — no dangling unauthenticated port, and it never
// blocks the bot's own startup. This is the only HTTP surface this bot exposes.
//
// Deployment note: registering https://<your-domain>/stripe/webhook in the Stripe Dashboard,
// registering https://<your-domain>/epic-callback as the OAuth redirect URI on the Epic
// Games developer portal, registering https://<your-domain>/discord-checkout-callback as an
// OAuth2 redirect on the Discord Developer Portal (same app as CLIENT_ID), registering
// https://<your-domain>/deploy as a GitHub webhook (content type application/json, "Just the push
// event", secret = DEPLOY_WEBHOOK_SECRET) on the bot-public repo, and exposing this port publicly
// (reverse proxy, or a tunnel like ngrok/Cloudflare Tunnel for local dev), are manual one-time
// steps this code cannot automate.

const express = require('express');
const crypto = require('crypto');
const { exec } = require('child_process');
const SubscriptionModel = require('./models/Subscription');
const access = require('./access');
const { dmUser } = require('./discord-dm');
const { buildPaymentFailedDmEmbed } = require('./embeds');
const epicOAuth = require('./epic-oauth');
const discordOAuth = require('./discord-oauth');
const billing = require('./billing');
const playerStore = require('./players');
const { getRoleId, getChannelId } = require('./guild-config');
const elo = require('./elo');
const { createRateLimiter } = require('./rate-limit');

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

// Same style/pattern as renderEpicResultPage above, for the website checkout hand-off — this one
// only ever renders the failure case, since success redirects straight on to Stripe Checkout
// instead of rendering a page of its own.
function renderCheckoutErrorPage(message) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Checkout Failed</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 60px 20px;">
  <h2>❌ Something went wrong</h2>
  <p>${message}</p>
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
  const discordOAuthEnabled = discordOAuth.isConfigured();
  const deployEnabled = !!process.env.DEPLOY_WEBHOOK_SECRET;
  // Always on — unlike every other route here, the public ELO lookup needs no external API
  // credentials, just MongoDB (already required for Player records in general). Included in the
  // "is there anything to serve at all" check below so this alone is enough to bring the server up
  // even on a deployment with none of Stripe/Epic/Discord OAuth/deploy configured.
  const eloEnabled = true;

  if (!stripeEnabled && !epicEnabled && !discordOAuthEnabled && !deployEnabled && !eloEnabled) {
    console.warn('[webhook] Neither Stripe, Epic OAuth, Discord OAuth, nor deploy webhook env vars are set — webhook server not started.');
    return null;
  }

  const app = express();

  if (!stripeEnabled) {
    console.warn('[webhook] STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET not set — /stripe/webhook disabled. Subscriptions are disabled.');
  }
  if (!epicEnabled) {
    console.warn('[webhook] EPIC_CLIENT_ID/EPIC_CLIENT_SECRET/EPIC_REDIRECT_URI not set — /epic-callback disabled. Epic account linking is unavailable.');
  }
  if (!discordOAuthEnabled) {
    console.warn('[webhook] CLIENT_ID/DISCORD_CLIENT_SECRET/DISCORD_OAUTH_REDIRECT_URI not set — /premium and /discord-checkout-callback disabled. Website checkout is unavailable; /premium (Discord command) is unaffected.');
  }
  if (!deployEnabled) {
    console.warn('[webhook] DEPLOY_WEBHOOK_SECRET not set — /deploy auto-deploy endpoint disabled.');
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
          '❌ Linking your Epic account failed. You can try again in #register.'
        );
        return res.status(502).send(renderEpicResultPage(
          false, 'Failed to complete linking with Epic Games. You can try again.'
        ));
      }

      try {
        // linkEpicAccount (not a raw upsertPlayer) — this fires on a re-link to a different Epic
        // account too, and must invalidate any cached stats tied to whatever was linked before.
        await playerStore.linkEpicAccount(guildId, discordId, { epicId, epicUsername });

        // See permissions.js's progressive-visibility ladder, which gates
        // #get-roles/#how-to-use/#access behind this role.
        const verifiedRoleId = getRoleId(guildId, 'verified');
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

  if (discordOAuthEnabled) {
    const VALID_PLANS = ['monthly', 'yearly'];

    // Entry point linked from the website's "Subscribe" buttons — kicks off Discord OAuth so the
    // callback below can learn who's paying without the website ever needing its own Discord
    // session/identity of its own.
    app.get('/premium/:plan', (req, res) => {
      const { plan } = req.params;
      if (!VALID_PLANS.includes(plan)) {
        return res.status(400).send(renderCheckoutErrorPage('Unknown plan. Please go back to the website and try again.'));
      }
      res.redirect(discordOAuth.buildAuthUrl(plan));
    });

    // GET, not POST — this is a browser redirect from Discord's own authorize page, carrying
    // `code` and `state` (the plan from /premium/:plan above) as query params.
    app.get('/discord-checkout-callback', async (req, res) => {
      const { code, state: plan, error: discordError } = req.query;

      if (discordError) {
        return res.status(400).send(renderCheckoutErrorPage('Discord declined the request.'));
      }
      if (!code || !VALID_PLANS.includes(plan)) {
        return res.status(400).send(renderCheckoutErrorPage('This link is invalid or has expired. Please go back to the website and try again.'));
      }

      let discordId;
      try {
        ({ discordId } = await discordOAuth.exchangeCodeForUser(code));
      } catch (err) {
        console.error('[discord-oauth] Token exchange failed:', err.message);
        return res.status(502).send(renderCheckoutErrorPage('Failed to complete sign-in with Discord. Please try again.'));
      }

      try {
        const checkoutUrl = await billing.createCheckoutSession(discordId, plan);
        res.redirect(checkoutUrl);
      } catch (err) {
        console.error(`[discord-oauth] Failed to create Stripe checkout session for Discord ${discordId} (${plan}):`, err.message);
        res.status(502).send(renderCheckoutErrorPage(escapeHtml(err.message)));
      }
    });
  }

  if (deployEnabled) {
    // GitHub signs the raw JSON body with HMAC-SHA256 using the webhook's configured secret, sent
    // as `X-Hub-Signature-256: sha256=<hex>` — same shape as Stripe's signature check above, and
    // for the same reason needs the exact raw bytes (express.raw, not express.json).
    app.post('/deploy', express.raw({ type: '*/*' }), (req, res) => {
      const signature = req.headers['x-hub-signature-256'];
      const expected = 'sha256=' + crypto
        .createHmac('sha256', process.env.DEPLOY_WEBHOOK_SECRET)
        .update(req.body)
        .digest('hex');

      const signatureBuffer = Buffer.from(signature ?? '');
      const expectedBuffer = Buffer.from(expected);
      const signatureValid = signatureBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

      if (!signatureValid) {
        console.warn('[deploy] Rejected — missing or invalid X-Hub-Signature-256');
        return res.status(401).send('Invalid signature');
      }

      if (req.headers['x-github-event'] !== 'push') {
        return res.status(200).send('Ignored — not a push event');
      }

      let payload;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch (err) {
        console.error('[deploy] Failed to parse push payload:', err.message);
        return res.status(400).send('Invalid JSON payload');
      }

      if (payload.ref !== 'refs/heads/main') {
        console.log(`[deploy] Ignored push to ${payload.ref} — only main triggers a deploy`);
        return res.status(200).send('Ignored — not main branch');
      }

      console.log(`[deploy] Verified push to main (${payload.after ?? 'unknown commit'}) — deploying`);
      res.status(200).send('Deploying');

      // Respond before restarting — pm2 restarting this exact process (matchmaker-beta runs this
      // same webhook server) would otherwise race the HTTP response back to GitHub.
      setTimeout(() => {
        exec('git pull && pm2 restart matchmaker-beta', { cwd: __dirname }, (err, stdout, stderr) => {
          if (err) {
            console.error('[deploy] Deploy command failed:', err.message);
            if (stderr) console.error('[deploy] stderr:', stderr);
            return;
          }
          console.log('[deploy] Deploy output:', stdout);
        });
      }, 500);
    });
  }

  // Public "check your ELO" lookup (elo.js) — reads the STORED Epic username from the last time a
  // player linked/scraped, never a live Fortnite Tracker scrape at request time, so this stays
  // cheap enough to be genuinely public and unauthenticated. 20 requests/minute/IP is generous for
  // a human searching their own (or a friend's) name repeatedly, while still blunting casual
  // high-volume hammering — see rate-limit.js.
  const eloRateLimit = createRateLimiter({ windowMs: 60_000, max: 20 });
  const MAX_EPIC_USERNAME_LENGTH = 64; // generous — real Epic display names are far shorter

  // Autocomplete for the website's ELO checker — up to 5 registered Epic usernames matching a
  // partial (prefix) input, so a visitor can find their own name without typing it exactly. Own
  // rate limiter (not the eloRateLimit instance below) — same 20/min/IP config as the single-lookup
  // endpoint ("the same way" it's rate-limited), but a SEPARATE bucket, since autocomplete is
  // realistically fired once per keystroke rather than once per manual lookup; sharing one counter
  // between the two would let rapid typing exhaust the budget meant for the actual lookup too.
  //
  // Registered BEFORE /api/elo/:epicUsername below — Express matches routes in registration order,
  // and :epicUsername is a wildcard that would otherwise swallow a request to /api/elo/search
  // (treating "search" as the username param) before ever reaching this route.
  const eloSearchRateLimit = createRateLimiter({ windowMs: 60_000, max: 20 });

  app.get('/api/elo/search', eloSearchRateLimit, async (req, res) => {
    const q = req.query.q;
    if (!q || typeof q !== 'string' || q.length > MAX_EPIC_USERNAME_LENGTH) {
      return res.status(400).json({ error: 'Invalid query.' });
    }

    try {
      const usernames = await playerStore.searchEpicUsernames(q);
      res.json({ usernames });
    } catch (err) {
      console.error(`[elo] Username search failed for "${q}":`, err.message);
      res.status(500).json({ error: 'Something went wrong searching — try again shortly.' });
    }
  });

  app.get('/api/elo/:epicUsername', eloRateLimit, async (req, res) => {
    const { epicUsername } = req.params;
    if (!epicUsername || epicUsername.length > MAX_EPIC_USERNAME_LENGTH) {
      return res.status(400).json({ error: 'Invalid Epic username.' });
    }

    try {
      const result = await elo.getPublicElo(epicUsername);
      if (!result) {
        return res.status(404).json({ found: false, error: 'No player found with that Epic username.' });
      }
      res.json(result);
    } catch (err) {
      console.error(`[elo] Lookup failed for "${epicUsername}":`, err.message);
      res.status(500).json({ error: 'Something went wrong looking that up — try again shortly.' });
    }
  });

  const port = process.env.PORT || 3000;
  console.log('[webhook] Express server starting on port', port);
  const server = app.listen(port, () => {
    const routes = [
      stripeEnabled && 'POST /stripe/webhook',
      epicEnabled && 'GET /epic-callback',
      discordOAuthEnabled && 'GET /premium/:plan, GET /discord-checkout-callback',
      deployEnabled && 'POST /deploy',
      'GET /api/elo/:epicUsername',
      'GET /api/elo/search',
    ].filter(Boolean);
    console.log(`[webhook] Server listening on port ${port} (${routes.join(', ')})`);
  });

  return server;
}

module.exports = { startWebhookServer, simulateCheckoutCompleted };
