// access.js - The single gate every queue attempt (tournament and creative alike) goes through.
// Access is global per Discord ID, never per guild: a 7-day free trial starting on a player's
// first-ever queue attempt, then an escalating-cost credit-day ladder (funded only by creative-
// queue play — see credits.js) for up to 7 more days, then a paid Stripe subscription for
// unlimited access. See models/Subscription.js for the record shape this owns.
//
// checkAccess() is the write path (starts a trial, spends a credit-day) and is cached in memory
// for up to 24h purely as a perf optimisation — every write below calls invalidateCache() right
// after it commits, so in the normal case the cache is never more than milliseconds stale; the
// 24h TTL only guards against a hypothetical missed invalidation, not correctness.
// getAccessStatus() is the read-only path for the "Check My Access" embed — always fresh, never
// spends a credit, so checking your status can never itself cost you a day.

const SubscriptionModel = require('./models/Subscription');

// Cost (in credits) of the Nth extra day post-trial — index 0 is "the next unbought day" when
// creditDaysUsed is 0, etc. 70 credits total buys all 7 rungs, matching the spec's "max 7 days
// extra via credits, 70 credits total."
const LADDER = [2, 3, 5, 8, 12, 17, 23];
const TRIAL_DAYS = 7;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// discordId -> { result, cachedAt }
const cache = new Map();

function invalidateCache(discordId) {
  cache.delete(discordId);
}

function utcDateString(date) {
  return date.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// Atomic check-and-spend for "today's" rung, in one aggregation-pipeline update so there's no
// read-then-write gap: the query's creditDaySpentDate:{$ne:todayStr} guard means only one of two
// concurrent calls for the same discordId can ever match and write — the loser gets null back,
// which checkAccess resolves by re-reading rather than assuming failure (see below).
async function spendCreditForToday(discordId, todayStr) {
  return SubscriptionModel.findOneAndUpdate(
    {
      discordId,
      creditDaysUsed: { $lt: LADDER.length },
      creditDaySpentDate: { $ne: todayStr },
      $expr: { $gte: ['$creditsEarned', { $arrayElemAt: [LADDER, '$creditDaysUsed'] }] },
    },
    [
      {
        $set: {
          creditsEarned: { $subtract: ['$creditsEarned', { $arrayElemAt: [LADDER, '$creditDaysUsed'] }] },
          creditDaysUsed: { $add: ['$creditDaysUsed', 1] },
          creditDaySpentDate: todayStr,
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true }
  );
}

function hasActiveSubscription(doc, now) {
  return !!doc.subscriptionExpiry
    && doc.subscriptionExpiry > now
    && (doc.status === 'active' || doc.status === 'cancelled');
}

async function computeAccess(discordId) {
  const now = new Date();

  let doc = await SubscriptionModel.findOne({ discordId });

  if (!doc) {
    doc = await SubscriptionModel.create({ discordId, trialStartDate: now });
    console.log(`[access] ${discordId} — trial started (first-ever queue attempt)`);
    return { allowed: true, reason: 'trial_started', trialEndsAt: addDays(now, TRIAL_DAYS) };
  }

  // Legacy safety net: a doc could in principle exist with no trial ever started (e.g. a
  // credit-only record from before gating existed). Start it now rather than getting stuck.
  if (!doc.trialStartDate) {
    await SubscriptionModel.updateOne({ discordId }, { $set: { trialStartDate: now } });
    return { allowed: true, reason: 'trial_started', trialEndsAt: addDays(now, TRIAL_DAYS) };
  }

  // Trial first — checked before Stripe is even glanced at, since the trial is bot-managed and
  // deliberately has zero Stripe involvement.
  const trialEndsAt = addDays(doc.trialStartDate, TRIAL_DAYS);
  if (now < trialEndsAt) {
    return { allowed: true, reason: 'trial', trialEndsAt };
  }

  // Subscription next — checked BEFORE attempting to spend a credit-day, not after. Spec order
  // lists trial -> credits -> subscription, but checking credits first would mean a paying
  // subscriber who also happens to have banked credits (e.g. earned post-subscription from
  // creative play) gets those credits silently drained every day for access they already have
  // for free. Checking subscription first costs nothing when there's no subscription (one field
  // comparison) and only changes behaviour in that one case, always in the player's favour.
  if (hasActiveSubscription(doc, now)) {
    return { allowed: true, reason: 'subscription', subscriptionExpiry: doc.subscriptionExpiry };
  }

  // Trial is over, no active subscription — the credit-day ladder.
  if (doc.creditDaysUsed >= LADDER.length) {
    return { allowed: false, reason: 'credits_exhausted' };
  }

  const today = utcDateString(now);
  if (doc.creditDaySpentDate === today) {
    return { allowed: true, reason: 'already_paid_today' };
  }

  const spent = await spendCreditForToday(discordId, today);
  if (spent) {
    invalidateCache(discordId);
    console.log(`[access] ${discordId} — spent credits for today (rung ${spent.creditDaysUsed}/${LADDER.length}), ${spent.creditsEarned} credits left`);
    return { allowed: true, reason: 'credits_spent' };
  }

  // The write didn't match — could be a concurrent call that just spent it, or genuinely
  // insufficient credits/exhausted ladder. Re-read rather than assume the worst.
  const recheck = await SubscriptionModel.findOne({ discordId });
  if (recheck.creditDaySpentDate === today) {
    return { allowed: true, reason: 'already_paid_today' };
  }
  if (recheck.creditDaysUsed >= LADDER.length) {
    return { allowed: false, reason: 'credits_exhausted' };
  }
  return {
    allowed: false,
    reason: 'insufficient_credits',
    needed: LADDER[recheck.creditDaysUsed],
    have: recheck.creditsEarned,
  };
}

async function checkAccess(discordId) {
  const cached = cache.get(discordId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = await computeAccess(discordId);
  cache.set(discordId, { result, cachedAt: Date.now() });
  return result;
}

// Read-only status for the "Check My Access" embed — bypasses the cache (never show a stale
// number here) and never spends a credit, so looking never costs you a day.
async function getAccessStatus(discordId) {
  const now = new Date();
  const doc = await SubscriptionModel.findOne({ discordId });

  if (!doc) {
    return { kind: 'new', creditsEarned: 0, creditDaysUsed: 0, creditDaysRemaining: LADDER.length };
  }

  // Same precedence as computeAccess: trial, then subscription, then credits — so this status
  // display can never disagree with what checkAccess actually decided.
  const trialEndsAt = doc.trialStartDate ? addDays(doc.trialStartDate, TRIAL_DAYS) : null;
  if (trialEndsAt && now < trialEndsAt) {
    const trialDaysRemaining = Math.ceil((trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return { kind: 'trial', trialDaysRemaining, creditsEarned: doc.creditsEarned };
  }

  if (hasActiveSubscription(doc, now)) {
    return {
      kind: 'subscription',
      subscriptionStatus: doc.status,
      subscriptionExpiry: doc.subscriptionExpiry,
      plan: doc.plan,
    };
  }

  const creditDaysRemaining = LADDER.length - doc.creditDaysUsed;
  const nextRungCost = creditDaysRemaining > 0 ? LADDER[doc.creditDaysUsed] : null;
  const matchesNeededForNextDay = nextRungCost != null ? Math.max(0, nextRungCost - doc.creditsEarned) : null;

  return {
    kind: creditDaysRemaining > 0 ? 'credits_active' : 'no_access',
    creditsEarned: doc.creditsEarned,
    creditDaysUsed: doc.creditDaysUsed,
    creditDaysRemaining,
    nextRungCost,
    matchesNeededForNextDay,
  };
}

module.exports = { checkAccess, getAccessStatus, invalidateCache, LADDER, TRIAL_DAYS };
