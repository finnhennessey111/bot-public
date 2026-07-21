// creative-channel.js - Lifecycle for the four Fortnite Creative queue channels (1v1, 2v2, 6s,
// 8s), scoped per guild. Set up via /setup-creative-1v1/2v2/6s/8s — every category now posts
// wherever the command was run (same pattern for all four; 6s/8s no longer target a fixed env-
// var channel, since there's no per-guild equivalent of that once env vars are gone).
// Each channel has a single pinned embed that's edited in place on every join/leave.
//
// Decoupled from which matching engine backs a category — the caller passes `modes` (the
// mode-name list for this category) and `countFn(guildId, mode, region)` explicitly, since
// 1v1/2v2 are backed by creative-queue.js and 6s/8s by creative-team-queue.js.

const { buildCreativeQueueEmbed, buildCreativeQueueComponents } = require('./embeds');
const { REGIONS } = require('./creative-queue');
const { getCreativeChannelInfo, setGuildConfig } = require('./guild-config');

function buildCounts(guildId, modes, countFn) {
  const counts = {};
  for (const mode of modes) {
    counts[mode] = {};
    for (const region of REGIONS) {
      counts[mode][region] = countFn(guildId, mode, region);
    }
  }
  return counts;
}

async function postCreativeQueueChannel(guildId, channel, category, { modes, countFn, queueButtonPrefix, leaveButtonId }) {
  const embed = buildCreativeQueueEmbed(category, buildCounts(guildId, modes, countFn), modes);
  const components = buildCreativeQueueComponents(category, modes, queueButtonPrefix, leaveButtonId);
  const msg = await channel.send({ embeds: [embed], components });
  await msg.pin();

  await setGuildConfig(guildId, { creativeChannels: { [category]: { channelId: channel.id, messageId: msg.id } } });

  return msg;
}

async function updateCreativeQueueEmbed(guildId, client, category, { modes, countFn }) {
  const stored = getCreativeChannelInfo(guildId, category);
  if (!stored?.channelId || !stored?.messageId) return;

  try {
    const channel = await client.channels.fetch(stored.channelId);
    const msg = await channel.messages.fetch(stored.messageId);
    const embed = buildCreativeQueueEmbed(category, buildCounts(guildId, modes, countFn), modes);
    await msg.edit({ embeds: [embed], components: msg.components });
  } catch (err) {
    console.error(`Failed to update creative queue embed (${category}):`, err.message);
  }
}

module.exports = { postCreativeQueueChannel, updateCreativeQueueEmbed };
