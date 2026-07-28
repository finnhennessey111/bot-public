// Verifies the "queueing without a linked Epic account" fix:
//   - players.js's isEpicLinked (the real, exported predicate index.js's queue-join gates and
//     resolveEpicIdentity both now call) correctly identifies every unlinked-record shape.
//   - embeds.js's buildEpicLinkRequiredReply (the real, exported reply builder every queue-join
//     gate uses) produces a friendly message with a working Epic OAuth link, reusing epic-oauth.js
//     exactly the way #register's existing Link Epic Account button already does.
//   - A simulated queue-join, using those same real functions in the same order index.js's
//     handlers use them, short-circuits to the friendly reply and never reaches a stats scrape —
//     index.js itself can't be required directly in a test (it calls client.login() as a side
//     effect of loading), so this drives the actual exported gate/reply functions instead of
//     re-implementing their logic.
const test = require('node:test');
const assert = require('node:assert/strict');

const playerStore = require('../players');
const { buildEpicLinkRequiredReply } = require('../embeds');
const epicOAuth = require('../epic-oauth');

// --- players.js: isEpicLinked -----------------------------------------------------------------

test('isEpicLinked: false for no record at all (never registered)', () => {
  assert.equal(playerStore.isEpicLinked(null), false);
  assert.equal(playerStore.isEpicLinked(undefined), false);
});

test('isEpicLinked: false for a Registered player who never linked Epic (the actual bug scenario)', () => {
  // Shape of a real record for someone who completed #get-roles (region set, Registered role
  // granted) but never clicked Link Epic Account — or a legacy player from before Epic OAuth
  // gating existed at all.
  const record = { guildId: 'g1', discordId: 'd1', region: 'EU', epicOAuthLinked: undefined };
  assert.equal(playerStore.isEpicLinked(record), false);
});

test('isEpicLinked: false when only some of the three fields are present', () => {
  assert.equal(playerStore.isEpicLinked({ epicOAuthLinked: true }), false); // no epicId/epicUsername
  assert.equal(playerStore.isEpicLinked({ epicOAuthLinked: true, epicId: '123' }), false); // no epicUsername
  assert.equal(playerStore.isEpicLinked({ epicId: '123', epicUsername: 'Ninja' }), false); // flag not set
});

test('isEpicLinked: true once all three fields are present', () => {
  const record = { epicOAuthLinked: true, epicId: '12345', epicUsername: 'Ninja' };
  assert.equal(playerStore.isEpicLinked(record), true);
});

// --- embeds.js: buildEpicLinkRequiredReply --------------------------------------------------

test('buildEpicLinkRequiredReply: friendly "not set up" message when Epic OAuth isn\'t configured', () => {
  const previous = {
    id: process.env.EPIC_CLIENT_ID, secret: process.env.EPIC_CLIENT_SECRET, uri: process.env.EPIC_REDIRECT_URI,
  };
  delete process.env.EPIC_CLIENT_ID;
  delete process.env.EPIC_CLIENT_SECRET;
  delete process.env.EPIC_REDIRECT_URI;

  try {
    const reply = buildEpicLinkRequiredReply('guild1', 'user1');
    assert.match(reply.content, /link your epic account/i);
    assert.equal(reply.components, undefined); // nothing to click if there's no flow to send them into
  } finally {
    if (previous.id !== undefined) process.env.EPIC_CLIENT_ID = previous.id;
    if (previous.secret !== undefined) process.env.EPIC_CLIENT_SECRET = previous.secret;
    if (previous.uri !== undefined) process.env.EPIC_REDIRECT_URI = previous.uri;
  }
});

test('buildEpicLinkRequiredReply: reuses the real Epic OAuth flow when configured — same link #register\'s button produces', () => {
  const previous = {
    id: process.env.EPIC_CLIENT_ID, secret: process.env.EPIC_CLIENT_SECRET, uri: process.env.EPIC_REDIRECT_URI,
  };
  process.env.EPIC_CLIENT_ID = 'test-client-id';
  process.env.EPIC_CLIENT_SECRET = 'test-client-secret';
  process.env.EPIC_REDIRECT_URI = 'https://example.com/epic-callback';

  try {
    const reply = buildEpicLinkRequiredReply('guild-42', 'user-99');
    assert.match(reply.content, /link your epic account/i);
    assert.equal(reply.components.length, 1);

    // Pull the URL back out of the real ActionRowBuilder/ButtonBuilder the same way Discord.js
    // would serialize it, and confirm it's a genuine, decodable Epic authorize URL for this exact
    // discordId/guildId — i.e. this is the real epic-oauth.js flow, not a stand-in.
    const button = reply.components[0].toJSON().components[0];
    const url = new URL(button.url);
    assert.equal(url.origin + url.pathname, 'https://www.epicgames.com/id/authorize');
    assert.equal(url.searchParams.get('client_id'), 'test-client-id');

    const decoded = epicOAuth.decodeState(url.searchParams.get('state'));
    assert.deepEqual(decoded, { discordId: 'user-99', guildId: 'guild-42' });
  } finally {
    if (previous.id !== undefined) process.env.EPIC_CLIENT_ID = previous.id; else delete process.env.EPIC_CLIENT_ID;
    if (previous.secret !== undefined) process.env.EPIC_CLIENT_SECRET = previous.secret; else delete process.env.EPIC_CLIENT_SECRET;
    if (previous.uri !== undefined) process.env.EPIC_REDIRECT_URI = previous.uri; else delete process.env.EPIC_REDIRECT_URI;
  }
});

// --- Simulated queue-join: the actual gate order index.js's handlers use --------------------

// Mirrors the exact sequence every queue-join handler (queue_duo/queue_lf2, creative_queue_,
// finalizeTeamQueueJoin) now runs, using the real exported functions — Registered check, then
// isEpicLinked, only THEN would it call resolveEpicIdentity/getPlayerStats (stood in here by
// scrapeAttempted(), since actually invoking getPlayerStats would launch a real Puppeteer scrape).
function simulateQueueJoin({ isRegistered, playerRecord }) {
  let scrapeAttempted = false;

  if (!isRegistered) {
    return { blocked: 'not_registered', scrapeAttempted };
  }
  if (!playerStore.isEpicLinked(playerRecord)) {
    return { blocked: 'not_epic_linked', reply: buildEpicLinkRequiredReply('guild1', 'user1'), scrapeAttempted };
  }

  scrapeAttempted = true; // this is where resolveEpicIdentity/getPlayerStats would fire for real
  return { blocked: null, scrapeAttempted };
}

test('simulated queue-join: an unlinked-but-registered player is stopped before any scrape is attempted', () => {
  const result = simulateQueueJoin({ isRegistered: true, playerRecord: { region: 'EU' } }); // no Epic fields at all
  assert.equal(result.blocked, 'not_epic_linked');
  assert.equal(result.scrapeAttempted, false);
  assert.match(result.reply.content, /link your epic account/i);
});

test('simulated queue-join: a fully linked player passes the gate and proceeds to the (stubbed) scrape step', () => {
  const result = simulateQueueJoin({
    isRegistered: true,
    playerRecord: { region: 'EU', epicOAuthLinked: true, epicId: '1', epicUsername: 'Ninja' },
  });
  assert.equal(result.blocked, null);
  assert.equal(result.scrapeAttempted, true);
});
