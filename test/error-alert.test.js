// Verifies error-alert.js's alertError in isolation: DMs BOT_OWNER_DISCORD_ID and/or
// JACOB_DISCORD_ID (whichever are actually set), never throws when neither is set, and
// deduplicates repeat alerts for the same area within the cooldown window so a crash-looping
// error can't flood both recipients' DMs.
//
// BOT_OWNER_DISCORD_ID/JACOB_DISCORD_ID are read into module-level constants at require time
// (same pattern already used by suggestions.js/tournament-approval.js for BOT_OWNER_DISCORD_ID),
// so each scenario needs its own fresh require after setting process.env — same require.cache
// reset technique test/matchmaker-setup-partial-failure.test.js uses for guild-config.
const test = require('node:test');
const assert = require('node:assert/strict');

function makeFakeClient() {
  const sentDMs = [];
  const client = {
    users: {
      async fetch(discordId) {
        return {
          async send(payload) {
            sentDMs.push({ discordId, payload });
            return { id: `dm-${sentDMs.length}`, channelId: `chan-${discordId}` };
          },
        };
      },
    },
  };
  return { client, sentDMs };
}

async function withFreshErrorAlert({ botOwnerId, jacobId }, fn) {
  const errorAlertPath = require.resolve('../error-alert');
  const previous = require.cache[errorAlertPath];
  delete require.cache[errorAlertPath];

  const originalOwner = process.env.BOT_OWNER_DISCORD_ID;
  const originalJacob = process.env.JACOB_DISCORD_ID;
  if (botOwnerId === undefined) delete process.env.BOT_OWNER_DISCORD_ID; else process.env.BOT_OWNER_DISCORD_ID = botOwnerId;
  if (jacobId === undefined) delete process.env.JACOB_DISCORD_ID; else process.env.JACOB_DISCORD_ID = jacobId;

  try {
    const { alertError } = require('../error-alert');
    return await fn(alertError);
  } finally {
    delete require.cache[errorAlertPath];
    if (previous) require.cache[errorAlertPath] = previous;
    if (originalOwner === undefined) delete process.env.BOT_OWNER_DISCORD_ID; else process.env.BOT_OWNER_DISCORD_ID = originalOwner;
    if (originalJacob === undefined) delete process.env.JACOB_DISCORD_ID; else process.env.JACOB_DISCORD_ID = originalJacob;
  }
}

test('alertError: DMs both BOT_OWNER_DISCORD_ID and JACOB_DISCORD_ID when both are set', async () => {
  await withFreshErrorAlert({ botOwnerId: 'owner-1', jacobId: 'jacob-1' }, async (alertError) => {
    const { client, sentDMs } = makeFakeClient();
    await alertError(client, { area: 'test-both-set', summary: 'Something genuinely broke.' });

    assert.equal(sentDMs.length, 2);
    assert.deepEqual(sentDMs.map(d => d.discordId).sort(), ['jacob-1', 'owner-1']);
    for (const dm of sentDMs) {
      const embed = dm.payload.embeds[0];
      assert.match(embed.title, /test-both-set/);
      assert.equal(embed.description, 'Something genuinely broke.');
    }
  });
});

test('alertError: DMs only the owner when JACOB_DISCORD_ID is unset', async () => {
  await withFreshErrorAlert({ botOwnerId: 'owner-1' }, async (alertError) => {
    const { client, sentDMs } = makeFakeClient();
    await alertError(client, { area: 'test-owner-only', summary: 'x' });

    assert.equal(sentDMs.length, 1);
    assert.equal(sentDMs[0].discordId, 'owner-1');
  });
});

test('alertError: sends nothing and never throws when neither ID is set', async () => {
  await withFreshErrorAlert({}, async (alertError) => {
    const { client, sentDMs } = makeFakeClient();
    await assert.doesNotReject(() => alertError(client, { area: 'test-neither-set', summary: 'x' }));
    assert.equal(sentDMs.length, 0);
  });
});

test('alertError: a second alert for the SAME area within the cooldown window is suppressed, but a different area still sends', async () => {
  await withFreshErrorAlert({ botOwnerId: 'owner-1' }, async (alertError) => {
    const { client, sentDMs } = makeFakeClient();

    await alertError(client, { area: 'test-cooldown-area', summary: 'first' });
    await alertError(client, { area: 'test-cooldown-area', summary: 'second, should be suppressed' });
    assert.equal(sentDMs.length, 1, 'the repeat alert for the same area within the cooldown window must not send a second DM');

    await alertError(client, { area: 'test-cooldown-area-2', summary: 'different area, should send' });
    assert.equal(sentDMs.length, 2, 'a different area is a separate cooldown bucket and must still send');
  });
});

test('alertError: the DM body is a concise summary, not a raw stack trace dump', async () => {
  await withFreshErrorAlert({ botOwnerId: 'owner-1' }, async (alertError) => {
    const { client, sentDMs } = makeFakeClient();
    const err = new Error('Connection refused');
    await alertError(client, { area: 'test-no-stack', summary: `Something failed: ${err.message}` });

    const embed = sentDMs[0].payload.embeds[0];
    assert.equal(embed.description, 'Something failed: Connection refused');
    assert.doesNotMatch(embed.description, /at .*\(.*:\d+:\d+\)/, 'must not contain stack-trace frames');
    assert.ok(embed.description.length < 300, 'a concise summary, not a dump');
  });
});
