// notifications.js - Hourly sweep that DMs a player when they cross an access boundary:
// trial expiring soon, the daily "your credit-bought access expires at midnight" reminder (noon
// UTC only), 24h before the credit window closes, the credit window closing (forfeits any
// unused credits), or a subscription expiring. (A sixth DM type, payment failed, is triggered
// directly by webhook-server.js's invoice.payment_failed handler, not this sweep — each failed
// invoice is a distinct real event, not a one-time boundary.) The "your trial has ended, you have
// X credits" DM is NOT sent from here — it fires synchronously from index.js the moment the
// credit window actually starts (see access.js's ensureCreditWindowStarted), since that's a
// player-triggered event, not something a periodic sweep should discover after the fact.
//
// Trial/window boundaries are day-granularity except the noon-UTC-gated midnight reminder, so
// hourly is frequent enough without being wasteful — the noon gate just checks
// `now.getUTCHours() === 12` rather than needing a separate precise scheduler.

const SubscriptionModel = require('./models/Subscription');
const billing = require('./billing');
const { dmUser } = require('./discord-dm');
const { TRIAL_DAYS } = require('./access');
const {
  buildTrialExpiringSoonDmEmbed, buildMidnightReminderDmEmbed,
  buildCreditWindowExpiryWarningDmEmbed, buildCreditWindowExpiredDmEmbed,
  buildSubscriptionExpiredDmEmbed, buildDmSubscribeButtons,
} = require('./embeds');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const WARNING_WINDOW_MS = 24 * 60 * 60 * 1000;

// Generates both plan links so every DM can offer Monthly and Yearly, same as the #access embed.
// Each is independently best-effort — one failing (Stripe unconfigured, transient API error)
// doesn't block the other, and both failing still lets the DM send with no link buttons rather
// than not sending at all (skipping the DM would also skip setting the idempotency flag below,
// causing this sweep to retry-and-fail on the same player forever).
async function getSubscribeButtons(discordId) {
  const [monthlyUrl, yearlyUrl] = await Promise.all([
    billing.createCheckoutSession(discordId, 'monthly').catch(err => {
      console.warn(`[notifications] Could not generate a monthly checkout link for ${discordId}:`, err.message);
      return null;
    }),
    billing.createCheckoutSession(discordId, 'yearly').catch(err => {
      console.warn(`[notifications] Could not generate a yearly checkout link for ${discordId}:`, err.message);
      return null;
    }),
  ]);

  const row = buildDmSubscribeButtons(monthlyUrl, yearlyUrl);
  return row ? [row] : [];
}

async function checkAndNotifyOne(client, doc, now) {
  const hasActiveSub = !!doc.subscriptionExpiry && doc.subscriptionExpiry > now
    && (doc.status === 'active' || doc.status === 'cancelled');
  const trialEndsAt = doc.trialStartDate ? new Date(doc.trialStartDate.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000) : null;
  const trialOver = trialEndsAt && now >= trialEndsAt;
  const today = now.toISOString().slice(0, 10);

  // 1. Trial ending within 24h, not yet expired, not yet notified.
  if (trialEndsAt && !trialOver && trialEndsAt.getTime() - now.getTime() <= WARNING_WINDOW_MS && !doc.trialExpiringSoonDmSent) {
    const hoursRemaining = Math.max(1, Math.ceil((trialEndsAt.getTime() - now.getTime()) / (60 * 60 * 1000)));
    const components = await getSubscribeButtons(doc.discordId);
    await dmUser(client, doc.discordId, { embeds: [buildTrialExpiringSoonDmEmbed(hoursRemaining)], components });
    await SubscriptionModel.updateOne({ discordId: doc.discordId }, { $set: { trialExpiringSoonDmSent: true } });
    console.log(`[notifications] Sent trial-expiring-soon DM to ${doc.discordId}`);
  }

  // The remaining checks are all about the post-trial credit window — none of them apply to an
  // actively subscribed player (subscription bypasses the credit window entirely).
  if (hasActiveSub) return;

  // 2. Daily "your access expires at midnight tonight" reminder — noon UTC only, once per day,
  // only for players who actually bought today's access with credits.
  if (now.getUTCHours() === 12 && doc.creditDaySpentDate === today && doc.midnightReminderSentDate !== today) {
    await dmUser(client, doc.discordId, { embeds: [buildMidnightReminderDmEmbed()] });
    await SubscriptionModel.updateOne({ discordId: doc.discordId }, { $set: { midnightReminderSentDate: today } });
    console.log(`[notifications] Sent midnight-reminder DM to ${doc.discordId}`);
  }

  // 3. 24h before the credit window closes, not yet expired, not yet notified.
  if (doc.creditWindowExpiry) {
    const msUntilWindowExpiry = new Date(doc.creditWindowExpiry).getTime() - now.getTime();
    if (msUntilWindowExpiry > 0 && msUntilWindowExpiry <= WARNING_WINDOW_MS && !doc.creditWindowExpiryWarningDmSent) {
      const components = await getSubscribeButtons(doc.discordId);
      await dmUser(client, doc.discordId, { embeds: [buildCreditWindowExpiryWarningDmEmbed(doc.creditsEarned)], components });
      await SubscriptionModel.updateOne({ discordId: doc.discordId }, { $set: { creditWindowExpiryWarningDmSent: true } });
      console.log(`[notifications] Sent credit-window-expiry-warning DM to ${doc.discordId}`);
    }
  }

  // 4. Credit window has fully closed — forfeit any remaining credits (true zero, not just
  // inaccessible) and notify once.
  if (doc.creditWindowExpiry && now >= new Date(doc.creditWindowExpiry) && !doc.creditWindowExpiredDmSent) {
    const components = await getSubscribeButtons(doc.discordId);
    await dmUser(client, doc.discordId, { embeds: [buildCreditWindowExpiredDmEmbed()], components });
    await SubscriptionModel.updateOne(
      { discordId: doc.discordId },
      { $set: { creditWindowExpiredDmSent: true, creditsEarned: 0 } }
    );
    console.log(`[notifications] Sent credit-window-expired DM to ${doc.discordId} — credits forfeited`);
  }

  // 5. Subscription just passed its expiry — reset the credit-day ladder (a lapsed subscriber's
  // next credit purchase starts back at the cheap end, not wherever they left off), notify once.
  // Resettable — see webhook-server.js clearing this flag on every fresh checkout.
  if (doc.subscriptionExpiry && now >= doc.subscriptionExpiry && !doc.subscriptionExpiredDmSent) {
    const components = await getSubscribeButtons(doc.discordId);
    await dmUser(client, doc.discordId, { embeds: [buildSubscriptionExpiredDmEmbed()], components });
    await SubscriptionModel.updateOne(
      { discordId: doc.discordId },
      { $set: { subscriptionExpiredDmSent: true, status: 'expired', creditDaysUsed: 0, creditDaySpentDate: null } }
    );
    console.log(`[notifications] Sent subscription-expired DM to ${doc.discordId} — credit ladder reset`);
  }
}

async function sweepOnce(client) {
  const now = new Date();
  const candidates = await SubscriptionModel.find({
    $or: [
      { trialExpiringSoonDmSent: false },
      { creditWindowExpiryWarningDmSent: false },
      { creditWindowExpiredDmSent: false },
      { subscriptionExpiredDmSent: false },
      { creditWindowStart: { $ne: null } }, // needed every sweep for the daily midnight reminder
    ],
  });

  for (const doc of candidates) {
    await checkAndNotifyOne(client, doc, now).catch(err => console.error(`[notifications] Failed to process ${doc.discordId}:`, err.message));
  }
}

function startAccessScheduler(client) {
  sweepOnce(client).catch(err => console.error('[notifications] Initial sweep failed:', err.message));
  setInterval(() => sweepOnce(client).catch(err => console.error('[notifications] Sweep failed:', err.message)), CHECK_INTERVAL_MS);
  console.log('[notifications] Access expiry DM scheduler started');
}

module.exports = { startAccessScheduler };
