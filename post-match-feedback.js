// post-match-feedback.js - Post-match outcome/difficulty survey for CREATIVE matches only
// (models/PostMatchFeedback.js). Two entry points:
//   - recordMatchParticipants: called at match-formation time (same moment feedback.js's
//     recordCreativeMatch already is, for the SAME creative matches — see index.js's
//     notifyCreativeMatchFound and team-match-lifecycle.js's startTeamMatch) — snapshots who's in
//     the match so there's someone to prompt later. Deliberately a separate collection/module from
//     feedback.js's existing creative rating system: different trigger point (this prompts
//     IMMEDIATELY once the match concludes, that one waits for the player's next queue join in the
//     same mode) and different questions (win/loss + skill-appropriate difficulty here, vs. a
//     great/okay/not-great rating there).
//   - sendPromptsIfNeeded: called from BOTH real match-conclusion points this codebase has for a
//     creative match channel — index.js's close_creative_channel handler (explicit close) and
//     channel-lifecycle.js's channelDeleted event (the channel's own auto-delete timer firing
//     instead). Idempotent via the atomic `prompted` flag, so whichever of those two fires first
//     for a given match is the only one that actually sends DMs.
//
// CRITICAL: every write here is purely for later manual review. Nothing in this file — or
// anywhere else in this codebase — reads `responses` to compute a score, a modifier, or feeds it
// into matching in any way. See models/PostMatchFeedback.js's doc comment and
// test/post-match-feedback.test.js, which asserts this directly.
//
// Every write here is non-fatal to its caller, same precedent as feedback.js — a capture/prompt
// failure must never break match creation, channel closing, or DM delivery elsewhere.

const PostMatchFeedback = require('./models/PostMatchFeedback');
const { dmUser } = require('./discord-dm');
const { buildPostMatchOutcomeEmbed, buildPostMatchOutcomeButtons } = require('./embeds');

async function recordMatchParticipants({ matchId, kind, mode, region, players }) {
  try {
    await PostMatchFeedback.create({
      matchId, kind, mode, region,
      players: players.map(p => ({ discordId: p.discordId })),
    });
  } catch (err) {
    console.error(`[post-match-feedback] Failed to record participants for match ${matchId}:`, err.message);
  }
}

// Atomic find-and-set on `prompted` — the actual guarantee that a match only ever gets DMed once,
// regardless of which conclusion path (or how many times, across a restart) calls this. Returns
// the PRE-update doc (findOneAndUpdate's default) so the caller still has the player list to DM
// from the exact call that "won" the race; every other/later call matches nothing (prompted is
// already true) and does nothing.
async function sendPromptsIfNeeded(matchId, client) {
  try {
    const doc = await PostMatchFeedback.findOneAndUpdate(
      { matchId, prompted: false },
      { $set: { prompted: true } }
    ).lean();
    if (!doc) return; // no record at all (capture failed earlier), or already prompted

    const embed = buildPostMatchOutcomeEmbed(doc.mode);
    const buttons = buildPostMatchOutcomeButtons(matchId);
    for (const player of doc.players) {
      dmUser(client, player.discordId, { embeds: [embed], components: [buttons] })
        .catch(err => console.error(`[post-match-feedback] Failed to DM ${player.discordId} for match ${matchId}:`, err.message));
    }
  } catch (err) {
    console.error(`[post-match-feedback] Failed to send prompts for match ${matchId}:`, err.message);
  }
}

// difficulty here is the SHORT customId token ('easy'/'fair'/'hard') — mapped to the schema's
// full enum value ('too_easy'/'fair'/'too_hard') right at the write boundary, so the customId
// parsing in index.js never has to deal with underscores inside a single dynamic segment.
const DIFFICULTY_TOKEN_TO_ENUM = { easy: 'too_easy', fair: 'fair', hard: 'too_hard' };

async function submitResponse(matchId, discordId, outcome, difficultyToken) {
  const difficulty = DIFFICULTY_TOKEN_TO_ENUM[difficultyToken];
  if (!difficulty) {
    console.error(`[post-match-feedback] Unknown difficulty token "${difficultyToken}" for match ${matchId}`);
    return;
  }
  try {
    await PostMatchFeedback.updateOne(
      { matchId },
      { $push: { responses: { discordId, outcome, difficulty, respondedAt: new Date() } } }
    );
  } catch (err) {
    console.error(`[post-match-feedback] Failed to record response for match ${matchId}/${discordId}:`, err.message);
  }
}

module.exports = {
  recordMatchParticipants,
  sendPromptsIfNeeded,
  submitResponse,
  DIFFICULTY_TOKEN_TO_ENUM,
};
