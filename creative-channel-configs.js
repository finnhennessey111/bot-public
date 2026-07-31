// creative-channel-configs.js - Per-category config for creative-channel.js's shared queue-
// channel lifecycle (1v1/2v2 backed by creative-queue.js's pairwise engine, 6s/8s by
// creative-team-queue.js's partial-fill engine). Shared between index.js (button/select-menu
// handling) and matchmaker-setup.js (initial channel creation) — pulled out of index.js so
// matchmaker-setup.js can use the same config without a circular require (index.js already
// requires matchmaker-setup.js for the /matchmaker-setup command handler).

const { MODES: CREATIVE_MODES, getCreativeQueueCount } = require('./creative-queue');
const creativeTeamQueue = require('./creative-team-queue');

const QUEUE_CHANNEL_CONFIGS = {
  '1v1': {
    modes: CREATIVE_MODES['1v1'], countFn: getCreativeQueueCount,
    queueButtonPrefix: 'creative_queue_', leaveButtonId: 'creative_leave_queue',
  },
  '2v2': {
    modes: CREATIVE_MODES['2v2'], countFn: getCreativeQueueCount,
    queueButtonPrefix: 'creative_queue_', leaveButtonId: 'creative_leave_queue',
  },
  '6s': {
    modes: creativeTeamQueue.MODES['6s'], countFn: creativeTeamQueue.getTeamQueueWaitingCount,
    queueButtonPrefix: 'team_queue_', leaveButtonId: 'team_leave_queue',
  },
  '8s': {
    modes: creativeTeamQueue.MODES['8s'], countFn: creativeTeamQueue.getTeamQueueWaitingCount,
    queueButtonPrefix: 'team_queue_', leaveButtonId: 'team_leave_queue',
  },
};

function categoryForAnyMode(mode) {
  return Object.keys(QUEUE_CHANNEL_CONFIGS).find(category => QUEUE_CHANNEL_CONFIGS[category].modes.includes(mode));
}

// 6s/8s is a planned premium feature, not available during the current free-for-everyone period —
// matchmaker-setup.js's ensureCreativeChannel posts embeds.js's buildCreativeComingSoonEmbed (no
// queue button) into these categories' channels instead of the real queue embed. The channel
// itself still gets created normally; only the posted content differs. Remove an entry here once
// that category actually launches — ensureCreativeChannel falls back to the real queue embed for
// anything not listed.
const COMING_SOON_CREATIVE_CATEGORIES = ['6s', '8s'];

module.exports = { QUEUE_CHANNEL_CONFIGS, categoryForAnyMode, COMING_SOON_CREATIVE_CATEGORIES };
