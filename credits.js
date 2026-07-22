// credits.js - Credit-earning system for creative queue matches (1v1/2v2/6s/8s) only.
// Tournament matches never award credits — the two callers are index.js's accept-match handler
// (isCreative branch, for 1v1/2v2) and team-match-lifecycle.js's startTeamMatch (for 6s/8s).
//
// 5 minutes after a creative match's private channel is created, every player still in that
// match AND still within their free trial earns 1 credit each (models/Subscription.js's
// creditsEarned), gated by a 30-minute per-player cooldown (lastCreditEarned) so back-to-back
// matches can't farm credits. Closing the channel early via the Close Channel button cancels the
// timer before it fires — no credit. Credits only fund the manual post-trial credit window
// (access.js) — once the trial ends, playing creative queue no longer earns anything, so a
// player can't keep extending their access for free forever.
//
// Credits are global per Discord ID (access.js's whole access system is), not per guild — a
// credit earned in one server counts toward access in every server the bot is in.

const SubscriptionModel = require('./models/Subscription');
const access = require('./access');

const CREDIT_DELAY_MS = 5 * 60 * 1000;
const CREDIT_COOLDOWN_MS = 30 * 60 * 1000;

// channelId -> timer handle, so the Close Channel button (index.js) can cancel it by channelId
// alone, without needing to know which players were involved.
const creditTimers = new Map();

// getPlayers is called at fire time, not schedule time — for 6s/8s the roster can change
// between channel creation and the 5-minute mark (vote-kick, ready-check no-show + backfill), so
// this always credits whoever is actually in the match when the timer fires, not who joined it
// initially. Pairwise (1v1/2v2) matches have a fixed roster, so callers there just pass a
// closure returning the original player list.
function scheduleCreditTimer(channelId, getPlayers) {
  const timer = setTimeout(() => {
    creditTimers.delete(channelId);

    const players = getPlayers() ?? [];
    if (players.length === 0) {
      console.log(`[credits] Channel ${channelId} — no players present when credit timer fired, skipping`);
      return;
    }

    awardCredits(players).catch(err => console.error('[credits] Failed to award credits:', err.message));
  }, CREDIT_DELAY_MS);

  creditTimers.set(channelId, timer);
}

// Called from the Close Channel button — if the channel closes before the 5-minute mark, no
// credit is awarded at all (not even a partial one).
function cancelCreditTimer(channelId) {
  const timer = creditTimers.get(channelId);
  if (!timer) return false;
  clearTimeout(timer);
  creditTimers.delete(channelId);
  return true;
}

async function awardCredits(players) {
  await Promise.all(players.map(player => awardCreditToPlayer(player)));
}

async function awardCreditToPlayer(player) {
  const now = new Date();
  const cooldownCutoff = new Date(now.getTime() - CREDIT_COOLDOWN_MS);
  // "Still within trial" expressed as trialStartDate > (now - TRIAL_DAYS) — algebraically the
  // same as trialStartDate + TRIAL_DAYS > now (access.js's isInTrial), just as a plain Date
  // comparison the query can use directly instead of an aggregation $expr.
  const trialCutoff = new Date(now.getTime() - access.TRIAL_DAYS * 24 * 60 * 60 * 1000);

  try {
    // Atomic: only matches a record that's currently within its trial window AND whose
    // lastCreditEarned is unset or older than the cooldown window. No upsert — a player can only
    // ever be mid-creative-match after access.checkAccess has already created their Subscription
    // doc (trial start happens at first queue attempt, before any match can exist), so there's
    // nothing legitimate to create here; a query match of nothing just means "not in trial right
    // now" or "on cooldown," not an error.
    const updated = await SubscriptionModel.findOneAndUpdate(
      {
        discordId: player.discordId,
        trialStartDate: { $ne: null, $gt: trialCutoff },
        $or: [{ lastCreditEarned: null }, { lastCreditEarned: { $lte: cooldownCutoff } }],
      },
      { $inc: { creditsEarned: 1 }, $set: { lastCreditEarned: now } },
      { returnDocument: 'after' }
    );

    if (!updated) {
      console.log(`[credits] ${player.discordUsername} (${player.discordId}) — not currently in trial, or on cooldown — no credit awarded`);
      return;
    }

    access.invalidateCache(player.discordId);
    console.log(`[credits] Awarded 1 credit to ${player.discordUsername} (${player.discordId}) — new total: ${updated.creditsEarned}`);
  } catch (err) {
    console.error(`[credits] Failed to award credit to ${player.discordId}:`, err.message);
  }
}

module.exports = { scheduleCreditTimer, cancelCreditTimer };
