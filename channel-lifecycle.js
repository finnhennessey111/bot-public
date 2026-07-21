// channel-lifecycle.js - Auto-deletion scheduling for private match channels (text, or
// text+voice pairs), shared by 1v1/2v2 creative matches, 6s/8s team matches, and tournament
// matches.
//
// Deletion timestamps are persisted to data.json/MongoDB (store.js's matchChannels) so timers
// survive a bot restart — restoreScheduledDeletions() re-derives the remaining delay from the
// stored deleteAt instead of resetting the clock, and deletes immediately anything already
// overdue. The shared category channel is likewise persisted, per-guild, in guild-config.js's
// categoryIds.match (guild-config.js's seedLegacyGuildFromEnv folds in the original single-guild
// deployment's MATCH_CATEGORY_ID once, so there's no env-var fallback needed here anymore).

const { EventEmitter } = require('events');
const { ChannelType } = require('discord.js');
const { matchChannels, save } = require('./store');
const { getCategoryId, setGuildConfig } = require('./guild-config');

const WARNING_MS = 60 * 1000;

const channelLifecycleEvents = new EventEmitter();

async function getOrCreateMatchCategory(guild) {
  const existingId = getCategoryId(guild.id, 'match');
  if (existingId) {
    try {
      const existing = await guild.channels.fetch(existingId);
      if (existing) return existing;
    } catch (err) {
      console.warn('Stored match categoryId no longer valid, re-resolving:', err.message);
    }
  }

  const created = await guild.channels.create({ name: 'Matches', type: ChannelType.GuildCategory });
  await setGuildConfig(guild.id, { categoryIds: { match: created.id } });
  return created;
}

// kind is informational only (used by the channelDeleted event so listeners — e.g. index.js
// cleaning up team-match-lifecycle.js's state — know what was auto-deleted).
function scheduleChannelDeletion({ client, guildId, textChannelId, voiceChannelId = null, deleteAtMs, kind }) {
  const record = {
    textChannelId,
    voiceChannelId,
    guildId,
    kind,
    deleteAt: new Date(deleteAtMs).toISOString(),
    warned: false,
  };
  matchChannels[textChannelId] = record;
  save(guildId);

  armTimers(client, record);
}

function armTimers(client, record) {
  // Re-reads matchChannels[textChannelId] at fire time (not the closed-over `record`) so a
  // cancellation in between (early close via the button) is respected.
  const msUntilDelete = new Date(record.deleteAt).getTime() - Date.now();

  if (msUntilDelete <= 0) {
    performDeletion(client, record.textChannelId).catch(console.error);
    return;
  }

  const msUntilWarning = msUntilDelete - WARNING_MS;
  if (!record.warned) {
    setTimeout(
      () => sendWarning(client, record.textChannelId).catch(console.error),
      Math.max(msUntilWarning, 0)
    );
  }

  setTimeout(() => performDeletion(client, record.textChannelId).catch(console.error), msUntilDelete);
}

async function sendWarning(client, textChannelId) {
  const record = matchChannels[textChannelId];
  if (!record || record.warned) return; // cancelled early, or already warned across a restart

  record.warned = true;
  save(record.guildId);

  try {
    const channel = await client.channels.fetch(textChannelId);
    await channel.send('⚠️ This channel deletes in 1 minute.');
  } catch (err) {
    console.error('Failed to send channel deletion warning:', err.message);
  }
}

async function performDeletion(client, textChannelId) {
  const record = matchChannels[textChannelId];
  if (!record) return; // cancelled early via the close button

  delete matchChannels[textChannelId];
  save(record.guildId);

  for (const id of [record.textChannelId, record.voiceChannelId].filter(Boolean)) {
    try {
      const channel = await client.channels.fetch(id);
      await channel.delete();
    } catch (err) {
      console.error(`Failed to auto-delete channel ${id}:`, err.message);
    }
  }

  channelLifecycleEvents.emit('channelDeleted', {
    textChannelId: record.textChannelId,
    voiceChannelId: record.voiceChannelId,
    kind: record.kind,
  });
}

// Called by the existing "Close Channel" button — cancels the scheduled auto-deletion and
// returns the record (so the caller can delete the paired voice channel too) without waiting
// for the timer.
function cancelChannelDeletion(textChannelId) {
  const record = matchChannels[textChannelId];
  if (!record) return null;
  delete matchChannels[textChannelId];
  save(record.guildId);
  return record;
}

// No guild filtering needed — every record already resolves via client.channels.fetch, which
// works regardless of which guild the channel belongs to, so re-arming every record globally
// (across every guild) on restart is correct and simpler than filtering.
function restoreScheduledDeletions(client) {
  for (const record of Object.values(matchChannels)) {
    armTimers(client, record);
  }
}

module.exports = {
  getOrCreateMatchCategory,
  scheduleChannelDeletion,
  cancelChannelDeletion,
  restoreScheduledDeletions,
  channelLifecycleEvents,
};
