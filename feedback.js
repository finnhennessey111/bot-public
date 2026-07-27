// feedback.js - Data capture for match feedback (models/MatchFeedback.js). Two triggers:
//   - creative (1v1/2v2/6s/8s): recordCreativeMatch is called the moment a match forms, snapshotting
//     both/all involved players' scoring inputs. getPendingCreativeFeedback is then checked the
//     next time a player joins a queue for that same mode — if their most recent match in that
//     mode has no feedback from them yet, index.js prompts them for it before/alongside the normal
//     queue-join confirmation. submitCreativeRating/submitCreativeNotGreatReason record the answer.
//   - tournament (matching.js's rejectMatch): recordTournamentReject + submitTournamentRejectReason
//     both fire at reject time — there's no deferred "next queue join" step for tournaments, only a
//     reject actually produces a doc at all (an accepted tournament match never does).
//
// Every write here is non-fatal to its caller — a feedback-capture failure should never break
// queueing, matching, or rejecting, so every Mongo call is wrapped and logged, never thrown.
// No aggregation/dashboard reads this collection yet — that's separate future work.

const MatchFeedback = require('./models/MatchFeedback');

function snapshotPlayers(players) {
  return players.map(p => ({
    discordId: p.discordId,
    totalPR: p.totalPR ?? null,
    thisSeasonPR: p.thisSeasonPR ?? null,
    matchScore: p.matchScore ?? null,
    soloModifier: p.soloModifier ?? null,
  }));
}

async function recordCreativeMatch({ matchId, mode, region, players }) {
  try {
    await MatchFeedback.create({ matchId, kind: 'creative', mode, region, players: snapshotPlayers(players) });
  } catch (err) {
    console.error(`[feedback] Failed to record creative match ${matchId}:`, err.message);
  }
}

async function recordTournamentReject({ matchId, mode, region, players }) {
  try {
    await MatchFeedback.create({ matchId, kind: 'tournament', mode, region, players: snapshotPlayers(players) });
  } catch (err) {
    console.error(`[feedback] Failed to record tournament reject ${matchId}:`, err.message);
  }
}

async function submitCreativeRating(matchId, discordId, rating) {
  try {
    await MatchFeedback.updateOne(
      { matchId },
      { $push: { feedback: { discordId, rating, respondedAt: new Date() } } }
    );
  } catch (err) {
    console.error(`[feedback] Failed to record rating for match ${matchId}:`, err.message);
  }
}

async function submitCreativeNotGreatReason(matchId, discordId, notGreatReason) {
  try {
    await MatchFeedback.updateOne(
      { matchId },
      { $push: { feedback: { discordId, rating: 'not_great', notGreatReason, respondedAt: new Date() } } }
    );
  } catch (err) {
    console.error(`[feedback] Failed to record not-great reason for match ${matchId}:`, err.message);
  }
}

async function submitTournamentRejectReason(matchId, discordId, rejectReason) {
  try {
    await MatchFeedback.updateOne(
      { matchId },
      { $push: { feedback: { discordId, rejectReason, respondedAt: new Date() } } }
    );
  } catch (err) {
    console.error(`[feedback] Failed to record reject reason for match ${matchId}:`, err.message);
  }
}

// "Their most recent match in that mode has no feedback yet" — literally the single latest
// creative match doc this discordId appears in for this exact mode string, checked only for
// whether THIS player has already responded (each player in a match answers independently, so a
// teammate/opponent already responding doesn't count). Returns that match's id, or null if
// there's no such match or they've already responded to it.
async function getPendingCreativeFeedback(discordId, mode) {
  try {
    const latest = await MatchFeedback.findOne({ kind: 'creative', mode, 'players.discordId': discordId })
      .sort({ createdAt: -1 })
      .lean();
    if (!latest) return null;
    const alreadyResponded = latest.feedback.some(f => f.discordId === discordId);
    return alreadyResponded ? null : latest.matchId;
  } catch (err) {
    console.error(`[feedback] Failed to check pending feedback for ${discordId}/${mode}:`, err.message);
    return null;
  }
}

module.exports = {
  recordCreativeMatch,
  recordTournamentReject,
  submitCreativeRating,
  submitCreativeNotGreatReason,
  submitTournamentRejectReason,
  getPendingCreativeFeedback,
};
