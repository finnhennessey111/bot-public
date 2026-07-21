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

  // Credit ledger — earned only from creative-queue matches (credits.js). Untouched by
  // subscription state.
  creditsEarned: { type: Number, default: 0 },
  lastCreditEarned: { type: Date, default: null },

  // Credit-day ladder — how many of the 7 escalating-cost extra days (post-trial) this player has
  // ever bought with credits. Lifetime counter, never resets on a gap day. creditDaySpentDate
  // (UTC 'YYYY-MM-DD') stops a second queue attempt on the same day from spending twice.
  creditDaysUsed: { type: Number, default: 0 },
  creditDaySpentDate: { type: String, default: null },

  // One-time DM idempotency flags (notifications.js). trialExpiringSoonDmSent/trialExpiredDmSent/
  // creditsLowDmSent/creditsExhaustedDmSent are pure lifetime flags — trial and the credit ladder
  // never recur, so there's nothing to reset them on. subscriptionExpiredDmSent is the one
  // exception, reset to false on every fresh checkout.session.completed so a resubscribe->lapse
  // cycle still DMs on every lapse, not just the first.
  trialExpiringSoonDmSent: { type: Boolean, default: false },
  trialExpiredDmSent: { type: Boolean, default: false },
  creditsLowDmSent: { type: Boolean, default: false },
  creditsExhaustedDmSent: { type: Boolean, default: false },
  subscriptionExpiredDmSent: { type: Boolean, default: false },
});

// discordId's `unique: true` above already creates this index — no separate schema.index() call
// needed (a second one would just log a duplicate-index warning at startup).

module.exports = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);
