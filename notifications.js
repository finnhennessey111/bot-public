// notifications.js - Hourly sweep that DMs a player exactly once when they cross one of five
// access boundaries: trial expiring soon, trial expired, credits running low, credits exhausted,
// or subscription expired. (A sixth DM type, payment failed, is triggered directly by
// webhook-server.js's invoice.payment_failed handler, not this sweep — each failed invoice is a
// distinct real event, not a one-time lifetime boundary, so it doesn't fit the idempotency-flag
// pattern used here.) Trial/credit/subscription boundaries are day-granularity, so hourly is
// frequent enough without being wasteful. Models channel-manager.js's startScheduler (immediate
// run + setInterval), minus the per-guild wrapper since access is global, not guild-scoped.

const SubscriptionModel = require('./models/Subscription');
const billing = require('./billing');
const { dmUser } = require('./discord-dm');
const { LADDER, TRIAL_DAYS } = require('./access');
const {
  buildTrialExpiringSoonDmEmbed, buildTrialExpiredDmEmbed,
  buildCreditsLowDmEmbed, buildCreditsExhaustedDmEmbed,
  buildSubscriptionExpiredDmEmbed, buildDmSubscribeButtons,
} = require('./embeds');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const TRIAL_WARNING_MS = 24 * 60 * 60 * 1000;
const CREDITS_LOW_THRESHOLD_DAYS = 2;

// Simulates forward through the (non-linear) ladder from the player's current
// creditsEarned/creditDaysUsed to estimate how many more days their banked credits actually
// cover — a naive average-cost division would misrepresent this since rungs cost 2..23.
function estimateDaysFromCredits(creditsEarned, creditDaysUsed) {
  let remaining = creditsEarned;
  let days = 0;
  for (let rung = creditDaysUsed; rung < LADDER.length; rung++) {
    if (remaining < LADDER[rung]) break;
    remaining -= LADDER[rung];
    days++;
  }
  return days;
}

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
  const ladderExhausted = doc.creditDaysUsed >= LADDER.length;

  // 1. Trial ending within 24h, not yet expired, not yet notified.
  if (trialEndsAt && !trialOver && trialEndsAt.getTime() - now.getTime() <= TRIAL_WARNING_MS && !doc.trialExpiringSoonDmSent) {
    const hoursRemaining = Math.max(1, Math.ceil((trialEndsAt.getTime() - now.getTime()) / (60 * 60 * 1000)));
    const components = await getSubscribeButtons(doc.discordId);
    await dmUser(client, doc.discordId, { embeds: [buildTrialExpiringSoonDmEmbed(hoursRemaining)], components });
    await SubscriptionModel.updateOne({ discordId: doc.discordId }, { $set: { trialExpiringSoonDmSent: true } });
    console.log(`[notifications] Sent trial-expiring-soon DM to ${doc.discordId}`);
  }

  // 2. Trial just expired, never subscribed, not yet notified.
  if (trialOver && !doc.subscriptionStart && !doc.trialExpiredDmSent) {
    const estimatedDays = estimateDaysFromCredits(doc.creditsEarned, doc.creditDaysUsed);
    const components = await getSubscribeButtons(doc.discordId);
    await dmUser(client, doc.discordId, { embeds: [buildTrialExpiredDmEmbed(estimatedDays)], components });
    await SubscriptionModel.updateOne({ discordId: doc.discordId }, { $set: { trialExpiredDmSent: true } });
    console.log(`[notifications] Sent trial-expired DM to ${doc.discordId}`);
  }

  // 3. Credits running low (~2 days of banked access left), ladder not yet exhausted, no active
  // subscription, not yet notified.
  if (trialOver && !ladderExhausted && !hasActiveSub && !doc.creditsLowDmSent) {
    const estimatedDays = estimateDaysFromCredits(doc.creditsEarned, doc.creditDaysUsed);
    if (estimatedDays <= CREDITS_LOW_THRESHOLD_DAYS) {
      const components = await getSubscribeButtons(doc.discordId);
      await dmUser(client, doc.discordId, { embeds: [buildCreditsLowDmEmbed(estimatedDays)], components });
      await SubscriptionModel.updateOne({ discordId: doc.discordId }, { $set: { creditsLowDmSent: true } });
      console.log(`[notifications] Sent credits-low DM to ${doc.discordId} (${estimatedDays}d estimated remaining)`);
    }
  }

  // 4. Ladder exhausted, no active subscription, not yet notified.
  if (trialOver && ladderExhausted && !hasActiveSub && !doc.creditsExhaustedDmSent) {
    const components = await getSubscribeButtons(doc.discordId);
    await dmUser(client, doc.discordId, { embeds: [buildCreditsExhaustedDmEmbed()], components });
    await SubscriptionModel.updateOne({ discordId: doc.discordId }, { $set: { creditsExhaustedDmSent: true } });
    console.log(`[notifications] Sent credits-exhausted DM to ${doc.discordId}`);
  }

  // 5. Subscription just passed its expiry, not yet notified. Resettable — see webhook-server.js.
  if (doc.subscriptionExpiry && now >= doc.subscriptionExpiry && !doc.subscriptionExpiredDmSent) {
    const components = await getSubscribeButtons(doc.discordId);
    await dmUser(client, doc.discordId, { embeds: [buildSubscriptionExpiredDmEmbed()], components });
    await SubscriptionModel.updateOne(
      { discordId: doc.discordId },
      { $set: { subscriptionExpiredDmSent: true, status: 'expired' } }
    );
    console.log(`[notifications] Sent subscription-expired DM to ${doc.discordId}`);
  }
}

async function sweepOnce(client) {
  const now = new Date();
  const candidates = await SubscriptionModel.find({
    $or: [
      { trialExpiringSoonDmSent: false },
      { trialExpiredDmSent: false },
      { creditsLowDmSent: false },
      { creditsExhaustedDmSent: false },
      { subscriptionExpiredDmSent: false },
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
