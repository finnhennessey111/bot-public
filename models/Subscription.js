// models/Subscription.js - A player's global access/billing record, keyed by Discord ID alone —
// NOT scoped per guild. Access (trial/credits/subscription) is intentionally global: it works
// identically in every server the bot is in, and a mod in one server has no way to grant or fake
// it, since it lives here rather than as a Discord role. See access.js for the read/write logic
// that owns this collection; credits.js only ever touches creditsEarned/lastCreditEarned.

const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  discordId: { type: String, required: true, unique: true },
  // First guild this player was ever seen in — debugging/analytics only, never read by any
  // access-control logic (access is global, not guild-scoped).
  firstSeenGuildId: { type: String, default: null },

  // Trial — 7 days from first-ever queue attempt (access.js sets this on a brand new record).
  trialStartDate: { type: Date, default: null },

  // Paid subscription (Stripe-backed). `status: 'cancelled'` still grants access as long as
  // subscriptionExpiry hasn't passed — see access.js's "end of billing period access" rule.
  plan: { type: String, enum: ['monthly', 'yearly'], default: null },
  status: { type: String, enum: ['active', 'cancelled', 'expired'], default: null },
  subscriptionStart: { type: Date, default: null },
  subscriptionExpiry: { type: Date, default: null },
  stripeCustomerId: { type: String, default: null },
  // Correlates a customer.subscription.deleted webhook back to this record.
  stripeSubscriptionId: { type: String, default: null },

  // Credit ledger — earned only from creative-queue matches played *during the trial*
  // (credits.js checks isInTrial before awarding). Zeroed out on credit-window expiry (true
  // forfeiture, not just "inaccessible") — see access.js/notifications.js.
  creditsEarned: { type: Number, default: 0 },
  lastCreditEarned: { type: Date, default: null },

  // The manual, "use it or lose it" post-trial window — starts on the player's first interaction
  // with the bot *after* their trial ends (a queue attempt or a Check My Access click; see
  // access.js's ensureCreditWindowStarted), not automatically from trial end. Credits can only be
  // spent (via the "Use Credits for Today" button) while now is between these two timestamps;
  // once creditWindowExpiry passes, any remaining creditsEarned is forfeited.
  creditWindowStart: { type: Date, default: null },
  creditWindowExpiry: { type: Date, default: null },

  // Credit-day ladder — how many of the 7 escalating-cost extra days (post-trial) this player has
  // ever bought with credits via the "Use Credits for Today" button. Resets to 0 if they
  // subscribe and their subscription later expires (see notifications.js) — a lapsed subscriber's
  // next credit purchase starts back at the cheap end of the ladder. creditDaySpentDate (UTC
  // 'YYYY-MM-DD') is the day access was last bought with credits — access lasts until UTC
  // midnight, which falls out of comparing this string to today's rather than a separate timer.
  creditDaysUsed: { type: Number, default: 0 },
  creditDaySpentDate: { type: String, default: null },

  // One-time DM idempotency flags (notifications.js). trialExpiringSoonDmSent is a pure lifetime
  // flag. creditWindowExpiryWarningDmSent/creditWindowExpiredDmSent are lifetime too — the credit
  // window itself is a one-shot, non-repeating event per player. midnightReminderSentDate (UTC
  // 'YYYY-MM-DD') is different: it recurs once per day a credit-day is bought, so it's a date
  // string rather than a boolean. subscriptionExpiredDmSent resets to false on every fresh
  // checkout.session.completed so a resubscribe->lapse cycle still DMs on every lapse.
  trialExpiringSoonDmSent: { type: Boolean, default: false },
  creditWindowExpiryWarningDmSent: { type: Boolean, default: false },
  creditWindowExpiredDmSent: { type: Boolean, default: false },
  midnightReminderSentDate: { type: String, default: null },
  subscriptionExpiredDmSent: { type: Boolean, default: false },
});

// discordId's `unique: true` above already creates this index — no separate schema.index() call
// needed (a second one would just log a duplicate-index warning at startup).

module.exports = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
