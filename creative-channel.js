// creative-channel.js - Lifecycle for the four Fortnite Creative queue channels (1v1, 2v2, 6s,
// 8s). Set up via /setup-creative-1v1/2v2/6s/8s. 1v1/2v2's channel is wherever the command was
// run (same pattern as /setup-tournament); 6s/8s always target their fixed
// CREATIVE_6S_CHANNEL_ID/CREATIVE_8S_CHANNEL_ID env var, resolved by the caller in index.js.
// Each channel has a single pinned embed that's edited in place on every join/leave.
//
// Decoupled from which matching engine backs a category — the caller passes `modes` (the
// mode-name list for this category) and `countFn(mode, region)` explicitly, since 1v1/2v2 are
// backed by creative-queue.js and 6s/8s by creative-team-queue.js.

const { buildCreativeQueueEmbed, buildCreativeQueueComponents } = require('./embeds');
const { REGIONS } = require('./creative-queue');
const { creativeChannels, save: saveStore } = require('./store');

function buildCounts(modes, countFn) {
  const counts = {};
  for (const mode of modes) {
    counts[mode] = {};
    for (const region of REGIONS) {
      counts[mode][region] = countFn(mode, region);
    }
  }
  return counts;
}

async function postCreativeQueueChannel(channel, category, { modes, countFn, queueButtonPrefix, leaveButtonId }) {
  const embed = buildCreativeQueueEmbed(category, buildCounts(modes, countFn), modes);
  const components = buildCreativeQueueComponents(category, modes, queueButtonPrefix, leaveButtonId);
  const msg = await channel.send({ embeds: [embed], components });
  await msg.pin();

  creativeChannels[category] = { channelId: channel.id, messageId: msg.id };
  saveStore();

  return msg;
}

async function updateCreativeQueueEmbed(client, category, { modes, countFn }) {
  const stored = creativeChannels[category];
  if (!stored?.channelId || !stored?.messageId) return;

  try {
    const channel = await client.channels.fetch(stored.channelId);
    const msg = await channel.messages.fetch(stored.messageId);
    const embed = buildCreativeQueueEmbed(category, buildCounts(modes, countFn), modes);
    await msg.edit({ embeds: [embed], components: msg.components });
  } catch (err) {
    console.error(`Failed to update creative queue embed (${category}):`, err.message);
  }
}

module.exports = { postCreativeQueueChannel, updateCreativeQueueEmbed };
