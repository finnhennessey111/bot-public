// Verifies the "go free for now" toggle (access.js's ACCESS_GATING_ENABLED): every Discord ID must
// be allowed through with no per-user data changes, and the underlying billing/Stripe code must be
// completely untouched so flipping the flag back is all re-enabling takes.
//
// No MONGODB_URI is set in this sandbox (db.js never connects — confirmed by reading db.js: it
// warns and skips connecting when the env var is absent), so mongoose queries here would buffer
// forever waiting for a connection that never arrives. That's what makes this a real, meaningful
// test rather than a mock: checkAccess/getAccessStatus resolving at all (let alone instantly, for
// an arbitrary never-seen-before Discord ID with no existing Subscription doc) is only possible if
// the gate genuinely short-circuits before ever touching SubscriptionModel — a broken bypass would
// hang this test until the suite's own timeout, not fail cleanly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const access = require('../access');
const { buildAccessStatusEmbed } = require('../embeds');
const { CHANNEL_SPECS } = require('../matchmaker-setup');

test('access.js: ACCESS_GATING_ENABLED is currently false (free-access testing period)', () => {
  assert.equal(access.ACCESS_GATING_ENABLED, false);
});

test('checkAccess: allows an arbitrary, never-seen Discord ID with no DB connection required', async () => {
  const result = await access.checkAccess(`never-seen-${Date.now()}`);
  assert.deepEqual(result, { allowed: true, reason: 'free_access_mode' });
});

test('checkAccess: allows every ID the same way — bypass is global, not a per-user allowlist', async () => {
  const ids = ['user-a', 'user-b', 'user-c'];
  for (const id of ids) {
    const result = await access.checkAccess(id);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'free_access_mode');
  }
});

test('getAccessStatus: reports free_access_mode with no DB connection required', async () => {
  const status = await access.getAccessStatus(`never-seen-${Date.now()}`);
  assert.deepEqual(status, { kind: 'free_access_mode' });
});

test('buildAccessStatusEmbed: renders a clear message for free_access_mode (not the no_access fallback)', () => {
  const embed = buildAccessStatusEmbed({ kind: 'free_access_mode' }).toJSON();
  assert.match(embed.title, /free/i);
  assert.doesNotMatch(embed.title, /no access/i);
});

test('matchmaker-setup: #access channel is skipped from CHANNEL_SPECS while gating is disabled', () => {
  assert.equal(CHANNEL_SPECS.some(s => s.key === 'access'), false);
});

// billing.js/webhook-server.js must be completely untouched by the toggle — re-enabling access
// gating later must be a pure flip of ACCESS_GATING_ENABLED, not a rebuild of Stripe integration.
test('billing.js: does not import access.js (fully independent of the gating toggle)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'billing.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\/access['"]\)/);
});

test('billing.js: createCheckoutSession and Stripe config helpers are still exported, unchanged', () => {
  const billing = require('../billing');
  assert.equal(typeof billing.createCheckoutSession, 'function');
  assert.equal(typeof billing.isStripeConfigured, 'function');
});

test('webhook-server.js: Stripe webhook route still exists (source-level check — the process itself is not started by this test)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'webhook-server.js'), 'utf8');
  assert.match(source, /webhook/i);
  assert.doesNotMatch(source, /ACCESS_GATING_ENABLED/);
});
