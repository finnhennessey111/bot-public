// Verifies the dead "Looking for 1" button (queue_lf1) is gone from Trios queue embeds. It had
// no working handler — the party-forming flow it depended on was already fully removed — so it
// was a broken, unreachable button in the UI.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildQueueButtons } = require('../embeds');

test('buildQueueButtons(isTrios=true): no longer includes the dead queue_lf1 button', () => {
  const row = buildQueueButtons(true).toJSON();
  const customIds = row.components.map(c => c.custom_id);
  assert.ok(!customIds.includes('queue_lf1'), 'queue_lf1 should have been removed');
  assert.ok(customIds.includes('queue_lf2'), 'queue_lf2 should still be present');
});

test('buildQueueButtons(isTrios=false): duo queue button unaffected', () => {
  const row = buildQueueButtons(false).toJSON();
  const customIds = row.components.map(c => c.custom_id);
  assert.deepEqual(customIds, ['queue_duo']);
});
