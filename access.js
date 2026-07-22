// access.js - The single gate every queue attempt (tournament and creative alike) goes through.
// Access is global per Discord ID, never per guild: a 7-day free trial starting on a player's
// first-ever queue attempt, then a manual, "use it or lose it" 7-day credit window (funded only
// by creative-queue play during the trial — see credits.js), then a paid Stripe subscription for
// unlimited access. See models/Subscription.js for the record shape this owns.
//
// Credits are never auto-spent. Once the trial ends, checkAccess() is a pure read — does today's
// UTC date match creditDaySpentDate, and is the credit window still open? — with exactly one
// side effect: starting the credit window on the player's first post-trial touch (a queue
// attempt or a Check My Access click). Actually spending a credit-day only ever happens via the
// explicit "Use Credits for Today" button — see useCreditsForToday().

const SubscriptionModel = require('./models/Subscription');

// Cost (in credits) of the Nth extra day post-trial — index 0 is "the next unbought day" when
// creditDaysUsed is 0, etc. 70 credits total buys all 7 rungs.
const LADDER = [2, 3, 5, 8, 12, 17, 23];
const TRIAL_DAYS = 7;
const CREDIT_WINDOW_DAYS = 7;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// discordId -> { result, cachedAt } — only ever populated for `allowed: true` results (see
// checkAccess). A blocked result is never cached, since the one-time "credit window just
// started" signal on a blocked result must never be replayed from a stale cache entry.
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

function daysUntil(future, now) {
  return Math.max(0, Math.ceil((new Date(future).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

function trialEndsAt(doc) {
  return doc.trialStartDate ? addDays(doc.trialStartDate, TRIAL_DAYS) : null;
}

function isInTrial(doc, now) {
  const endsAt = trialEndsAt(doc);
  return !!endsAt && now < endsAt;
}

function hasActiveSubscription(doc, now) {
  return !!doc.subscriptionExpiry
    && doc.subscriptionExpiry > now
    && (doc.status === 'active' || doc.status === 'cancelled');
}

function nextRungCost(doc) {
  return doc.creditDaysUsed < LADDER.length ? LADDER[doc.creditDaysUsed] : null;
}

function isCreditWindowExpired(doc, now) {
  return !doc.creditWindowExpiry || now >= new Date(doc.creditWindowExpiry);
}

// Simulates forward through the (non-linear) ladder from a player's current
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

// Starts the credit window the first time a player touches the bot after their trial ends (a
// queue attempt or a Check My Access click — see index.js's call sites) — no-ops if already
// started. The conditional filter (creditWindowStart: null) makes this atomic across concurrent
// calls, so exactly one caller ever sees justStarted: true and is responsible for firing the
// one-time "your trial has ended" DM — this module never touches Discord directly.
async function ensureCreditWindowStarted(discordId, now) {
  const creditWindowExpiry = addDays(now, CREDIT_WINDOW_DAYS);
  const updated = await SubscriptionModel.findOneAndUpdate(
    { discordId, creditWindowStart: null },
    { $set: { creditWindowStart: now, creditWindowExpiry } },
    { returnDocument: 'after' }
  );

  if (!updated) return { justStarted: false };

  invalidateCache(discordId);
  console.log(`[access] ${discordId} — credit window started, expires ${creditWindowExpiry.toISOString()}`);
  return {
    justStarted: true,
    creditsEarned: updated.creditsEarned,
    estimatedDays: estimateDaysFromCredits(updated.creditsEarned, updated.creditDaysUsed),
  };
}

async function computeAccess(discordId) {
  const now = new Date();

  let doc = await SubscriptionModel.findOne({ discordId });

  if (!doc) {
    doc = await SubscriptionModel.create({ discordId, trialStartDate: now });
    console.log(`[access] ${discordId} — trial started (first-ever queue attempt)`);
    return { allowed: true, reason: 'trial_started', trialEndsAt: addDays(now, TRIAL_DAYS) };
  }

  // Legacy safety net: a doc could in principle exist with no trial ever started.
  if (!doc.trialStartDate) {
    await SubscriptionModel.updateOne({ discordId }, { $set: { trialStartDate: now } });
    return { allowed: true, reason: 'trial_started', trialEndsAt: addDays(now, TRIAL_DAYS) };
  }

  if (isInTrial(doc, now)) {
    return { allowed: true, reason: 'trial', trialEndsAt: trialEndsAt(doc) };
  }

  // Subscription checked before the credit window — a subscriber with banked credits (e.g.
  // earned during trial, subscribed before using them) shouldn't have those credits touched.
  if (hasActiveSubscription(doc, now)) {
    return { allowed: true, reason: 'subscription', subscriptionExpiry: doc.subscriptionExpiry };
  }

  // Trial's over, no subscription — starts the credit window on first touch (no other effect).
  const windowResult = await ensureCreditWindowStarted(discordId, now);
  if (windowResult.justStarted) {
    doc = await SubscriptionModel.findOne({ discordId }); // re-read post-write for a fresh doc
  }

  if (isCreditWindowExpired(doc, now)) {
    return {
      allowed: false,
      reason: 'post_trial_no_access',
      creditsAvailable: doc.creditsEarned,
      creditWindowJustStarted: windowResult.justStarted,
      windowStartInfo: windowResult.justStarted ? windowResult : null,
    };
  }

  const today = utcDateString(now);
  if (doc.creditDaySpentDate === today) {
    return { allowed: true, reason: 'already_paid_today' };
  }

  // Window's open, but today hasn't been bought — no auto-spend anymore. Blocked until the
  // player explicitly clicks "Use Credits for Today" in #access.
  return {
    allowed: false,
    reason: 'post_trial_no_access',
    creditsAvailable: doc.creditsEarned,
    creditWindowJustStarted: windowResult.justStarted,
    windowStartInfo: windowResult.justStarted ? windowResult : null,
  };
}

// Perf cache for the hot path (every queue click) — only ever caches `allowed: true` results.
// Blocked results are always recomputed fresh, both because they're cheap (no ladder math to
// cache) and because a blocked result can carry the one-time creditWindowJustStarted signal,
// which must never be replayed from a stale cache entry.
async function checkAccess(discordId) {
  const cached = cache.get(discordId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = await computeAccess(discordId);
  if (result.allowed) {
    cache.set(discordId, { result, cachedAt: Date.now() });
  }
  return result;
}

// Read-only status for the "Check My Access" embed — always fresh, never spends a credit. Can
// still start the credit window as a side effect (Check My Access is an explicit trigger for
// that per spec), but that's recording a clock start, not spending anything.
//
// allowWindowStart is false for the one non-player-initiated caller (/player-lookup, a mod
// looking up someone else's status) — a mod's admin lookup isn't "the player interacting with
// the bot," so it must never silently start that player's 7-day clock on their behalf.
async function getAccessStatus(discordId, { allowWindowStart = true } = {}) {
  const now = new Date();
  let doc = await SubscriptionModel.findOne({ discordId });

  if (!doc) {
    return { kind: 'new' };
  }

  if (isInTrial(doc, now)) {
    return { kind: 'trial', trialDaysRemaining: daysUntil(trialEndsAt(doc), now), creditsEarned: doc.creditsEarned };
  }

  if (hasActiveSubscription(doc, now)) {
    return {
      kind: 'subscription',
      subscriptionStatus: doc.status,
      subscriptionExpiry: doc.subscriptionExpiry,
      plan: doc.plan,
    };
  }

  const windowResult = allowWindowStart
    ? await ensureCreditWindowStarted(discordId, now)
    : { justStarted: false };
  if (windowResult.justStarted) {
    doc = await SubscriptionModel.findOne({ discordId });
  }

  if (!doc.creditWindowStart) {
    // Window genuinely hasn't started yet (only reachable when allowWindowStart is false) —
    // trial's over but nothing's been forfeited or bought yet, so this isn't quite 'no_access'
    // (which implies a window that opened and closed); a mod looking this up should see the
    // player simply hasn't touched #access or queued since their trial ended.
    return { kind: 'trial_ended_window_not_started', creditsEarned: doc.creditsEarned };
  }

  if (isCreditWindowExpired(doc, now)) {
    return { kind: 'no_access', creditWindowJustStarted: windowResult.justStarted, windowStartInfo: windowResult.justStarted ? windowResult : null };
  }

  const daysLeftInWindow = daysUntil(doc.creditWindowExpiry, now);
  const today = utcDateString(now);

  if (doc.creditDaySpentDate === today) {
    return { kind: 'credits_active_already_bought_today', creditsEarned: doc.creditsEarned, daysLeftInWindow };
  }

  const cost = nextRungCost(doc);
  const canAfford = cost != null && doc.creditsEarned >= cost;

  if (canAfford) {
    return {
      kind: 'credits_active_can_buy',
      creditsEarned: doc.creditsEarned,
      nextRungCost: cost,
      daysLeftInWindow,
      creditWindowJustStarted: windowResult.justStarted,
      windowStartInfo: windowResult.justStarted ? windowResult : null,
    };
  }

  // Either the ladder's fully spent (cost === null) or there aren't enough credits for the next
  // rung — functionally identical to having no usable credits left.
  return { kind: 'no_access', creditWindowJustStarted: windowResult.justStarted, windowStartInfo: windowResult.justStarted ? windowResult : null };
}

// The explicit "Use Credits for Today" action — the only way to spend a credit-day now. Atomic
// check-and-spend via an aggregation-pipeline update, same race-safety shape as the old
// auto-spend: the query's guards (creditDaysUsed/creditDaySpentDate/creditWindowExpiry/the
// $expr balance check) mean only one of two concurrent clicks can ever match and write.
async function useCreditsForToday(discordId) {
  const now = new Date();
  const doc = await SubscriptionModel.findOne({ discordId });
  if (!doc) return { status: 'not_eligible' };

  if (isInTrial(doc, now) || hasActiveSubscription(doc, now)) {
    return { status: 'not_needed' };
  }

  if (isCreditWindowExpired(doc, now)) {
    return { status: 'window_expired' };
  }

  const today = utcDateString(now);
  if (doc.creditDaySpentDate === today) {
    return { status: 'already_bought_today' };
  }

  if (doc.creditDaysUsed >= LADDER.length) {
    return { status: 'ladder_exhausted' };
  }

  const cost = LADDER[doc.creditDaysUsed];
  if (doc.creditsEarned < cost) {
    return { status: 'insufficient_credits', needed: cost, have: doc.creditsEarned };
  }

  const spent = await SubscriptionModel.findOneAndUpdate(
    {
      discordId,
      creditDaysUsed: { $lt: LADDER.length },
      creditDaySpentDate: { $ne: today },
      creditWindowExpiry: { $gt: now },
      $expr: { $gte: ['$creditsEarned', { $arrayElemAt: [LADDER, '$creditDaysUsed'] }] },
    },
    [
      {
        $set: {
          creditsEarned: { $subtract: ['$creditsEarned', { $arrayElemAt: [LADDER, '$creditDaysUsed'] }] },
          creditDaysUsed: { $add: ['$creditDaysUsed', 1] },
          creditDaySpentDate: today,
        },
      },
    ],
    { returnDocument: 'after' }
  );

  if (!spent) {
    // Lost a race, or state moved between the read above and now — recheck rather than assume.
    const recheck = await SubscriptionModel.findOne({ discordId });
    if (recheck.creditDaySpentDate === today) return { status: 'already_bought_today' };
    if (isCreditWindowExpired(recheck, now)) return { status: 'window_expired' };
    return { status: 'insufficient_credits', needed: cost, have: recheck.creditsEarned };
  }

  invalidateCache(discordId);
  console.log(`[access] ${discordId} — bought today's access for ${cost} credits (rung ${spent.creditDaysUsed}/${LADDER.length}), ${spent.creditsEarned} left`);
  return {
    status: 'purchased',
    creditsRemaining: spent.creditsEarned,
    daysLeftInWindow: daysUntil(spent.creditWindowExpiry, now),
  };
}

module.exports = {
  checkAccess,
  getAccessStatus,
  useCreditsForToday,
  invalidateCache,
  isInTrial,
  estimateDaysFromCredits,
  LADDER,
  TRIAL_DAYS,
  CREDIT_WINDOW_DAYS,
};
