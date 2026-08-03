// Verifies post-match-feedback.js's post-match outcome/difficulty survey (creative matches only):
//   1. recordMatchParticipants + sendPromptsIfNeeded — the prompt actually gets sent (DMed to every
//      real participant), and is idempotent (never double-sent — the atomic prompted:false guard).
//   2. submitResponse — a submitted answer is stored correctly (matchId, discordId, outcome,
//      difficulty mapped from its short customId token, timestamp).
//   3. THE CRITICAL CONSTRAINT: nothing in this feature ever feeds a player's own answer back into
//      their own score. Verified two ways — a static check that the real scoring/matching pipeline
//      never even references this module/model, AND a behavioral check that computeMatchScoreBreakdown
//      produces the exact same output before and after a real feedback response is recorded for
//      that same player.
//
// Same "stub the Model with a small real in-memory collection, not the module" precedent as
// test/channel-deletion-undo.test.js — the actual production post-match-feedback.js code runs
// unmodified against realistic query/update semantics, including the atomic prompted:false guard.
//
// discord-dm.js's dmUser is destructured at require time inside post-match-feedback.js, so (same
// as test/tournament-approval.test.js's note on tournament-approval.js) it's exercised via a fake
// `client` object at the real boundary (client.users.fetch(id).send(payload)) rather than
// monkey-patching the already-bound dmUser reference, which wouldn't be seen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PostMatchFeedback = require('../models/PostMatchFeedback');
const postMatchFeedback = require('../post-match-feedback');
const { computeMatchScoreBreakdown } = require('../scraper');

function makeFakeClient() {
  const sentDMs = [];
  return {
    sentDMs,
    users: {
      async fetch(discordId) {
        return { async send(payload) { sentDMs.push({ discordId, payload }); return { id: `dm-${discordId}` }; } };
      },
    },
  };
}

function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([key, val]) => doc[key] === val);
}

function makeFakeCollection() {
  const docs = [];
  return {
    docs,
    create: async (fields) => {
      const doc = { prompted: false, responses: [], players: [], ...fields };
      docs.push(doc);
      return { ...doc };
    },
    findOneAndUpdate: (filter, update) => ({
      lean: async () => {
        const doc = docs.find(d => matchesFilter(d, filter));
        if (!doc) return null;
        const pre = { ...doc }; // Mongoose's default findOneAndUpdate returns the PRE-update doc
        if (update.$set) Object.assign(doc, update.$set);
        return pre;
      },
    }),
    updateOne: async (filter, update) => {
      const doc = docs.find(d => matchesFilter(d, filter));
      if (!doc) return { matchedCount: 0 };
      if (update.$push) {
        for (const [field, value] of Object.entries(update.$push)) {
          doc[field] = [...(doc[field] ?? []), value];
        }
      }
      return { matchedCount: 1 };
    },
  };
}

function withFakeModel(fn) {
  return async () => {
    const fake = makeFakeCollection();
    const originalCreate = PostMatchFeedback.create;
    const originalFindOneAndUpdate = PostMatchFeedback.findOneAndUpdate;
    const originalUpdateOne = PostMatchFeedback.updateOne;
    PostMatchFeedback.create = fake.create;
    PostMatchFeedback.findOneAndUpdate = fake.findOneAndUpdate;
    PostMatchFeedback.updateOne = fake.updateOne;
    try {
      await fn(fake);
    } finally {
      PostMatchFeedback.create = originalCreate;
      PostMatchFeedback.findOneAndUpdate = originalFindOneAndUpdate;
      PostMatchFeedback.updateOne = originalUpdateOne;
    }
  };
}

// ── 1. PROMPT FIRES, AND ONLY ONCE ────────────────────────────────────────────
test('post-match-feedback: recordMatchParticipants + sendPromptsIfNeeded DMs every real participant exactly once', withFakeModel(async () => {
  const client = makeFakeClient();
  const matchId = 'match_test_1';
  const players = [{ discordId: 'p1' }, { discordId: 'p2' }];
  await postMatchFeedback.recordMatchParticipants({ matchId, kind: 'creative-pairwise', mode: '1v1 Realistics', region: 'EU', players });

  await postMatchFeedback.sendPromptsIfNeeded(matchId, client);

  assert.equal(client.sentDMs.length, 2, 'both real participants must be DMed');
  assert.deepEqual(client.sentDMs.map(c => c.discordId).sort(), ['p1', 'p2']);
  assert.ok(client.sentDMs[0].payload.embeds?.length > 0, 'must include the survey embed');
  assert.ok(client.sentDMs[0].payload.components?.length > 0, 'must include the outcome buttons');

  // Second conclusion path firing for the SAME match (e.g. explicit close cancels the auto-timer,
  // but this proves the guarantee holds even if both somehow fired) must NOT double-DM anyone.
  await postMatchFeedback.sendPromptsIfNeeded(matchId, client);
  assert.equal(client.sentDMs.length, 2, 'a second call for the same match must be a no-op — never double-prompt');
}));

test('post-match-feedback: sendPromptsIfNeeded is a safe no-op for a matchId with no recorded participants (e.g. capture failed earlier)', withFakeModel(async () => {
  await assert.doesNotReject(() => postMatchFeedback.sendPromptsIfNeeded('match_never_recorded', {}));
}));

// ── 2. SUBMITTED RESPONSE IS STORED CORRECTLY ─────────────────────────────────
test('post-match-feedback: submitResponse records matchId, discordId, outcome, and the difficulty token mapped to its full enum value', withFakeModel(async (fake) => {
  const matchId = 'match_test_2';
  await PostMatchFeedback.create({ matchId, kind: 'creative-pairwise', mode: '2v2 Realistics', region: 'NAC', players: [{ discordId: 'p1' }] });

  await postMatchFeedback.submitResponse(matchId, 'p1', 'win', 'hard');

  const doc = fake.docs.find(d => d.matchId === matchId);
  assert.equal(doc.responses.length, 1);
  const response = doc.responses[0];
  assert.equal(response.discordId, 'p1');
  assert.equal(response.outcome, 'win');
  assert.equal(response.difficulty, 'too_hard', 'the short "hard" customId token must map to the schema\'s "too_hard" enum value');
  assert.ok(response.respondedAt instanceof Date);
}));

test('post-match-feedback: submitResponse maps every real difficulty token correctly', withFakeModel(async (fake) => {
  const matchId = 'match_test_3';
  await PostMatchFeedback.create({ matchId, kind: 'creative-team', mode: '6s', region: 'EU', players: [{ discordId: 'p1' }] });

  await postMatchFeedback.submitResponse(matchId, 'p1', 'loss', 'easy');
  await postMatchFeedback.submitResponse(matchId, 'p1', 'loss', 'fair');

  const doc = fake.docs.find(d => d.matchId === matchId);
  assert.deepEqual(doc.responses.map(r => r.difficulty), ['too_easy', 'fair']);
}));

test('post-match-feedback: submitResponse with an unrecognized difficulty token is a safe no-op — never writes garbage', withFakeModel(async (fake) => {
  const matchId = 'match_test_4';
  await PostMatchFeedback.create({ matchId, kind: 'creative-pairwise', mode: '1v1 Realistics', region: 'EU', players: [{ discordId: 'p1' }] });

  await postMatchFeedback.submitResponse(matchId, 'p1', 'win', 'not_a_real_token');

  const doc = fake.docs.find(d => d.matchId === matchId);
  assert.equal(doc.responses.length, 0);
}));

// ── 3. THE CRITICAL CONSTRAINT: never feeds back into the reporting player's own score ────────
test('post-match-feedback: the real scoring/matching pipeline never references this feature at all (static check)', () => {
  const scoringFiles = ['scraper.js', 'queue.js', 'creative-queue.js', 'players.js', 'matching.js', 'creative-team-queue.js'];
  for (const file of scoringFiles) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(
      !source.includes('post-match-feedback') && !source.includes('PostMatchFeedback'),
      `${file} must never reference post-match-feedback.js or models/PostMatchFeedback.js — this collection must never feed the scoring/matching pipeline`
    );
  }
});

test('post-match-feedback: computeMatchScoreBreakdown produces the EXACT SAME score for a real player before and after their own feedback response is recorded', withFakeModel(async (fake) => {
  const playerData = {
    totalPR: 800, thisSeasonPR: 200,
    recentEvents: [
      { name: 'Solo Cash Cup', placement: 5, rosterSize: 1, elims: 30 },
    ],
  };

  const before = computeMatchScoreBreakdown(playerData, '__no_match__');

  // Record the most extreme possible feedback for this exact player — "too hard", a loss — the
  // scenario most likely to tempt a future "adjust their score down" shortcut, if one ever existed.
  const matchId = 'match_test_5';
  await PostMatchFeedback.create({ matchId, kind: 'creative-pairwise', mode: '1v1 Realistics', region: 'EU', players: [{ discordId: 'reporter-1' }] });
  await postMatchFeedback.submitResponse(matchId, 'reporter-1', 'loss', 'hard');

  const after = computeMatchScoreBreakdown(playerData, '__no_match__');

  assert.deepEqual(before, after, 'recording a feedback response must have ZERO effect on computeMatchScoreBreakdown\'s output for the same inputs');
}));
