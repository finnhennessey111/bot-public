// channel-lifecycle.js - Auto-deletion scheduling for private match channels (text, or
// text+voice pairs), shared by 1v1/2v2 creative matches, 6s/8s team matches, and tournament
// matches.
//
// Deletion timestamps are persisted to data.json (store.js's matchChannels) so timers survive a
// bot restart — restoreScheduledDeletions() re-derives the remaining delay from the stored
// deleteAt instead of resetting the clock, and deletes immediately anything already overdue.
// The shared category channel (MATCH_CATEGORY_ID, auto-created if unset/missing) is likewise
// persisted (store.js's settings.matchCategoryId) so it's only created once.

const { EventEmitter } = require('events');
const { ChannelType } = require('discord.js');
const { matchChannels, settings, save } = require('./store');

const WARNING_MS = 60 * 1000;

const channelLifecycleEvents = new EventEmitter();

async function getOrCreateMatchCategory(guild) {
  if (settings.matchCategoryId) {
    try {
      const existing = await guild.channels.fetch(settings.matchCategoryId);
      if (existing) return existing;
    } catch (err) {
      console.warn('Stored matchCategoryId no longer valid, re-resolving:', err.message);
    }
  }

  const envId = process.env.MATCH_CATEGORY_ID;
  if (envId) {
    try {
      const envCategory = await guild.channels.fetch(envId);
      if (envCategory) {
        settings.matchCategoryId = envId;
        save();
        return envCategory;
      }
    } catch (err) {
      console.warn('MATCH_CATEGORY_ID set but channel not found, creating a new category:', err.message);
    }
  }

  const created = await guild.channels.create({ name: 'Matches', type: ChannelType.GuildCategory });
  settings.matchCategoryId = created.id;
  save();
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
  save();

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
  save();

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
  save();

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
  save();
  return record;
}

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
