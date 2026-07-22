// channel-lifecycle.js - Auto-deletion scheduling for private match channel *groups*: one text
// (or text+voice) channel per guild involved in a match, tied together under one groupId — a
// same-server match is a group of one, a cross-server match is a group of two-or-more (one
// channel cluster per involved guild — see match-channels.js and team-match-lifecycle.js).
// Shared by 1v1/2v2 creative matches, 6s/8s team matches, and tournament matches.
//
// Deletion timestamps are persisted to data.json/MongoDB (store.js's matchChannels, keyed by
// groupId) so timers survive a bot restart — restoreScheduledDeletions() re-derives the
// remaining delay from the stored deleteAt instead of resetting the clock, and deletes
// immediately anything already overdue. The shared category channel is likewise persisted, per
// guild, in guild-config.js's categoryIds.match.

const { EventEmitter } = require('events');
const { ChannelType } = require('discord.js');
const { matchChannels, save } = require('./store');
const { getCategoryId, setGuildConfig } = require('./guild-config');

const WARNING_MS = 60 * 1000;

const channelLifecycleEvents = new EventEmitter();

// channelId -> groupId, for the one place (the "Close Channel" button) that only knows which
// single channel was clicked, not which match group it belongs to. Rebuilt from matchChannels on
// every schedule/restore, so it's always in sync with the persisted records.
const channelToGroupId = new Map();

function indexRecord(record) {
  for (const c of record.channels) {
    if (c.textChannelId) channelToGroupId.set(c.textChannelId, record.groupId);
    if (c.voiceChannelId) channelToGroupId.set(c.voiceChannelId, record.groupId);
  }
}

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

// channels: [{ guildId, textChannelId, voiceChannelId? }] — one entry per guild involved in the
// match. kind is informational only (used by the channelDeleted event so listeners — e.g.
// index.js cleaning up team-match-lifecycle.js's state — know what was auto-deleted).
function scheduleChannelDeletion({ client, groupId, channels, deleteAtMs, kind }) {
  const record = {
    groupId,
    channels,
    kind,
    deleteAt: new Date(deleteAtMs).toISOString(),
    warned: false,
  };
  matchChannels[groupId] = record;
  save();

  indexRecord(record);
  armTimers(client, record);
}

function armTimers(client, record) {
  // Re-reads matchChannels[groupId] at fire time (not the closed-over `record`) so a
  // cancellation in between (early close via the button) is respected.
  const msUntilDelete = new Date(record.deleteAt).getTime() - Date.now();

  if (msUntilDelete <= 0) {
    performDeletion(client, record.groupId).catch(console.error);
    return;
  }

  const msUntilWarning = msUntilDelete - WARNING_MS;
  if (!record.warned) {
    setTimeout(
      () => sendWarning(client, record.groupId).catch(console.error),
      Math.max(msUntilWarning, 0)
    );
  }

  setTimeout(() => performDeletion(client, record.groupId).catch(console.error), msUntilDelete);
}

async function sendWarning(client, groupId) {
  const record = matchChannels[groupId];
  if (!record || record.warned) return; // cancelled early, or already warned across a restart

  record.warned = true;
  save();

  for (const c of record.channels) {
    try {
      const channel = await client.channels.fetch(c.textChannelId);
      await channel.send('⚠️ This channel deletes in 1 minute.');
    } catch (err) {
      console.error(`Failed to send channel deletion warning to ${c.textChannelId}:`, err.message);
    }
  }
}

async function performDeletion(client, groupId) {
  const record = matchChannels[groupId];
  if (!record) return; // cancelled early via the close button

  delete matchChannels[groupId];
  save();

  for (const c of record.channels) {
    for (const id of [c.textChannelId, c.voiceChannelId].filter(Boolean)) {
      channelToGroupId.delete(id);
      try {
        const channel = await client.channels.fetch(id);
        await channel.delete();
      } catch (err) {
        console.error(`Failed to auto-delete channel ${id}:`, err.message);
      }
    }
  }

  channelLifecycleEvents.emit('channelDeleted', {
    groupId,
    channels: record.channels,
    kind: record.kind,
  });
}

// Called by the existing "Close Channel" button and by reject/expire — cancels the scheduled
// auto-deletion for the whole group and returns the record (so the caller can delete every
// channel across every involved guild) without waiting for the timer.
function cancelChannelDeletion(groupId) {
  const record = matchChannels[groupId];
  if (!record) return null;
  delete matchChannels[groupId];
  save();
  for (const c of record.channels) {
    if (c.textChannelId) channelToGroupId.delete(c.textChannelId);
    if (c.voiceChannelId) channelToGroupId.delete(c.voiceChannelId);
  }
  return record;
}

// Same as cancelChannelDeletion, but looked up from any one channel in the group — for the
// "Close Channel" button, which only knows the channel it was clicked in.
function cancelChannelDeletionByChannelId(channelId) {
  const groupId = channelToGroupId.get(channelId);
  if (!groupId) return null;
  return cancelChannelDeletion(groupId);
}

// No guild filtering needed — every record already resolves via client.channels.fetch, which
// works regardless of which guild the channel belongs to, so re-arming every record globally
// (across every guild) on restart is correct and simpler than filtering.
function restoreScheduledDeletions(client) {
  for (const record of Object.values(matchChannels)) {
    indexRecord(record);
    armTimers(client, record);
  }
}

module.exports = {
  getOrCreateMatchCategory,
  scheduleChannelDeletion,
  cancelChannelDeletion,
  cancelChannelDeletionByChannelId,
  restoreScheduledDeletions,
  channelLifecycleEvents,
};
