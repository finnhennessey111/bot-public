// creative-channel.js - Lifecycle for the four Fortnite Creative queue channels (1v1, 2v2, 6s,
// 8s), scoped per guild. Set up via /setup-creative-1v1/2v2/6s/8s — every category now posts
// wherever the command was run (same pattern for all four; 6s/8s no longer target a fixed env-
// var channel, since there's no per-guild equivalent of that once env vars are gone).
// Each channel has a single pinned embed that's edited in place on every join/leave.
//
// Decoupled from which matching engine backs a category — the caller passes `modes` (the
// mode-name list for this category) and `countFn(guildId, mode, region)` explicitly, since
// 1v1/2v2 are backed by creative-queue.js and 6s/8s by creative-team-queue.js.

const { buildCreativeQueueEmbed, buildCreativeQueueComponents, buildCreativeComingSoonEmbed } = require('./embeds');
const { REGIONS } = require('./creative-queue');
const { getCreativeChannelInfo, setGuildConfig } = require('./guild-config');
const { COMING_SOON_CREATIVE_CATEGORIES } = require('./creative-channel-configs');

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

// 6s/8s during the current free period (embeds.js's buildCreativeComingSoonEmbed) — no
// components, no queue button, nothing to join yet. Persists {channelId, messageId} into
// guild-config the same way postCreativeQueueChannel does, so the future real-launch change just
// has to edit this same message in place rather than create/delete anything.
async function postComingSoonCreativeChannel(guildId, channel, category) {
  const embed = buildCreativeComingSoonEmbed(category);
  const msg = await channel.send({ embeds: [embed] });
  await msg.pin();

  await setGuildConfig(guildId, { creativeChannels: { [category]: { channelId: channel.id, messageId: msg.id } } });

  return msg;
}

// Ensures a COMING_SOON_CREATIVE_CATEGORIES channel's pinned message actually shows the coming-
// soon embed — EDITS an existing message in place if it doesn't already (rather than only ever
// posting fresh ones), so a channel that predates the coming-soon change and still shows the old
// real queue embed+buttons gets fixed too. Without this, matchmaker-setup.js's ensureCreativeChannel
// would find the channel+message already exist and leave them exactly as they were forever — this
// is what actually closes that gap, called both from ensureCreativeChannel's re-run path and
// repairComingSoonCreativeChannels' one-time startup sweep below.
async function ensureComingSoonCreativeChannel(guildId, channel, category, existingMessageId) {
  const embed = buildCreativeComingSoonEmbed(category);

  if (existingMessageId) {
    try {
      const msg = await channel.messages.fetch(existingMessageId);
      // Skip the edit if it's already showing coming-soon content with no components — avoids a
      // needless API call on every single /matchmaker-setup re-run once a channel is fixed.
      const alreadyComingSoon = msg.embeds[0]?.title?.includes('Coming Soon') && (msg.components?.length ?? 0) === 0;
      if (!alreadyComingSoon) {
        await msg.edit({ embeds: [embed], components: [] });
        console.log(`  🩹 Repaired #${channel.name} (creative-${category}) — switched to the Coming Soon embed`);
      }
      await setGuildConfig(guildId, { creativeChannels: { [category]: { channelId: channel.id, messageId: msg.id } } });
      return msg;
    } catch {
      // Pinned message is gone — fall through and post a fresh one below.
    }
  }

  const msg = await channel.send({ embeds: [embed] });
  await msg.pin();
  await setGuildConfig(guildId, { creativeChannels: { [category]: { channelId: channel.id, messageId: msg.id } } });
  return msg;
}

// One-time startup self-heal (index.js's clientReady, same placement/precedent as guild-config.js's
// runGuildConfigMigrations) — fixes every already-deployed 6s/8s channel that was set up before the
// coming-soon change shipped, WITHOUT needing an admin to manually re-run /matchmaker-setup. Only
// touches channels guild-config already knows about; a guild with no 6s/8s channel at all is
// untouched (nothing to repair).
async function repairComingSoonCreativeChannels(client) {
  for (const guild of client.guilds.cache.values()) {
    for (const category of COMING_SOON_CREATIVE_CATEGORIES) {
      const info = getCreativeChannelInfo(guild.id, category);
      if (!info?.channelId) continue;

      try {
        const channel = await guild.channels.fetch(info.channelId).catch(() => null);
        if (!channel) continue;
        await ensureComingSoonCreativeChannel(guild.id, channel, category, info.messageId);
      } catch (err) {
        console.error(`Failed to repair coming-soon creative channel (${category}) for guild ${guild.id}:`, err.message);
      }
    }
  }
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

module.exports = {
  postCreativeQueueChannel, postComingSoonCreativeChannel, ensureComingSoonCreativeChannel,
  repairComingSoonCreativeChannels, updateCreativeQueueEmbed,
};
