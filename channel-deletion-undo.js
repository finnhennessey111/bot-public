// channel-deletion-undo.js - Undo system for accidental tournament channel deletion. Before this
// existed, a mod deleting a bot-created tournament channel had no way to keep it deleted on purpose
// — channel-manager.js's checkAndCreateChannels finds no existing channel for the tournament's
// eventId on its next tick and just creates a fresh one, silently undoing the deletion.
//
// Flow: a deletion of a tracked, scraper-managed tournament channel (one with a tournamentEventId —
// see pinnedMessages) that this bot did NOT itself just perform (self-deletion-tracker.js's
// markSelfDeletion/consumeSelfDeletion is the shared signal for that) creates a
// models/DeletedTournamentChannel record and DMs whoever the audit log says deleted it, with a
// Restore button and a 24h window. Restore recreates the channel exactly as it was (from the
// pinnedMessages snapshot taken at deletion time, since that's the only place the data still exists
// once the channel is gone). No response within the window, or no identifiable deleter at all, both
// settle the record as 'permanently_deleted' — channel-manager.js's createTournamentChannel checks
// this before ever creating a channel for a given (guildId, eventId) again. Deliberately fails
// toward "stays deleted" rather than "recreate it anyway": an unidentifiable deleter is exactly the
// case where silently recreating it would be the same bug this module exists to fix, just via a
// different gap (nobody to ask, so nothing was ever confirmed intentional OR accidental — but
// recreating unasked is the one behavior actually reported as the bug).
//
// /restore-channel (index.js) is the fallback for a missed/closed DM — same records, same
// restoreChannel()/customId scheme, just listed and clicked from inside the server instead.

const { AuditLogEvent } = require('discord.js');
const DeletedTournamentChannelModel = require('./models/DeletedTournamentChannel');
const { dmUser } = require('./discord-dm');
const { pinnedMessages, savePinnedMessages } = require('./store');
const { consumeSelfDeletion } = require('./self-deletion-tracker');
const { createTournamentChannel, CHANNEL_DELETE_BUFFER_MS } = require('./channel-manager');
const { buildChannelDeletionUndoEmbed, buildChannelDeletionUndoButton } = require('./embeds');

const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

// How often the expiry sweep runs — own interval (not piggybacked on channel-manager.js's
// tournament-check tick) specifically to avoid a require cycle: this module already needs
// channel-manager.js's createTournamentChannel to restore a channel, so channel-manager.js can't
// also require this module to trigger the sweep without a circular require between them. 20 minutes
// is the same granularity tournament-approval.js's expirePendingApprovals uses for its own 20-min-
// piggybacked sweep — being off by up to that much against a 24h deadline is immaterial.
const EXPIRY_SWEEP_INTERVAL_MS = 20 * 60 * 1000;

// Same audit-log-lookup shape as index.js's guardModRoleGrant (MatchMaker Mod role grants) — most
// recent matching entry for this exact channel id, since the channel itself is gone from cache by
// the time this runs (GuildAuditLogsEntry falls back to a bare {id} target for a delete entry).
async function findDeletionExecutor(guild, channelId, client) {
  try {
    const auditLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 5 });
    const entry = auditLogs.entries.find(e => e.target?.id === channelId);
    const executor = entry?.executor ?? null;
    // Shouldn't be reachable — self-deletion-tracker.js's mark already filters out every deletion
    // this bot performs itself — but never attribute a deletion to the bot as if it were a person
    // who needs to confirm intent.
    if (executor?.id === client.user.id) return null;
    return executor;
  } catch (err) {
    console.error('[channel-deletion-undo] Failed to fetch audit logs for channel deletion:', err.message);
    return null;
  }
}

// Rebuilds the tournament shape channel-manager.js's createTournamentChannel expects, from a
// pinnedMessages snapshot — the only data that still exists once the channel itself is gone.
// lastBeginTime isn't stored on pinnedMessages directly, but it's exactly what deleteAt was derived
// from at creation time (deleteAt = lastBeginTime + CHANNEL_DELETE_BUFFER_MS), so it's recoverable
// for a non-permanent tournament; permanent tournaments never had a deleteAt at all and
// createTournamentChannel never reads lastBeginTime for them, so beginTime is a safe placeholder.
function snapshotToTournament(snapshot) {
  const lastBeginTime = (snapshot.permanent || !snapshot.deleteAt)
    ? snapshot.beginTime
    : new Date(snapshot.deleteAt - CHANNEL_DELETE_BUFFER_MS).toISOString();

  return {
    name: snapshot.tournamentName,
    region: snapshot.region,
    beginTime: snapshot.beginTime,
    lastBeginTime,
    isTrios: !!snapshot.isTrios,
    consoleOnly: !!snapshot.consoleOnly,
    isPermanent: !!snapshot.permanent,
    isRankedCup: !!snapshot.isRankedCup,
    eventId: snapshot.tournamentEventId,
  };
}

// Atomically transitions a record OUT of 'pending_confirmation' — same double-click/race-safety
// shape as tournament-approval.js's settlePending: the status filter means only the first
// transition actually matches and applies.
async function settleStatus(recordId, newStatus) {
  return DeletedTournamentChannelModel.findOneAndUpdate(
    { _id: recordId, status: 'pending_confirmation' },
    { $set: { status: newStatus, decidedAt: new Date() } },
    { returnDocument: 'after' }
  ).lean();
}

// The channelDelete gateway listener (index.js) — client.on('channelDelete', channel =>
// handleChannelDelete(client, channel)). Fires for every deleted channel across every guild the bot
// is in; everything not a tracked, externally-deleted tournament channel is a fast no-op below.
async function handleChannelDelete(client, channel) {
  if (!channel.guild) return; // not a guild channel

  if (consumeSelfDeletion(channel.id)) return; // this bot's own expected deletion — see module doc

  const pinned = pinnedMessages[channel.id];
  if (!pinned || !pinned.tournamentEventId) return; // not a tracked, scraper-managed tournament channel

  const guild = channel.guild;
  const executor = await findDeletionExecutor(guild, channel.id, client);

  // Snapshot before clearing — once this entry is gone, this is the only place the data needed to
  // recreate the channel identically still exists.
  const snapshot = { ...pinned };
  delete pinnedMessages[channel.id];
  savePinnedMessages(guild.id);

  const deletedAt = new Date();
  const expiresAt = new Date(deletedAt.getTime() + RESTORE_WINDOW_MS);

  const record = await DeletedTournamentChannelModel.findOneAndUpdate(
    { guildId: guild.id, eventId: pinned.tournamentEventId },
    {
      $set: {
        status: 'pending_confirmation',
        tournamentName: pinned.tournamentName,
        region: pinned.region,
        snapshot,
        deletedBy: executor ? { id: executor.id, tag: executor.tag ?? executor.username ?? executor.id } : null,
        deletedAt,
        expiresAt,
        dmChannelId: null,
        dmMessageId: null,
        decidedAt: null,
      },
    },
    { upsert: true, returnDocument: 'after' }
  ).lean();

  console.log(
    `[channel-deletion-undo] "${pinned.tournamentName}" (${pinned.region}) channel deleted in guild ${guild.id}`
    + (executor ? ` by ${executor.tag ?? executor.id}` : ' — deleter could not be determined from audit logs')
  );

  if (!executor) {
    // Nobody to ask — fail toward "stays deleted" rather than silently recreating it. See this
    // module's doc comment for why.
    await settleStatus(record._id, 'permanently_deleted');
    console.warn(`[channel-deletion-undo] No identifiable deleter for "${pinned.tournamentName}" (${pinned.region}) — marked permanently deleted.`);
    return;
  }

  const msg = await dmUser(client, executor.id, {
    embeds: [buildChannelDeletionUndoEmbed(record)],
    components: [buildChannelDeletionUndoButton(record._id.toString())],
  });

  if (msg) {
    await DeletedTournamentChannelModel.updateOne({ _id: record._id }, { $set: { dmChannelId: msg.channelId, dmMessageId: msg.id } });
  } else {
    console.warn(`[channel-deletion-undo] Could not DM ${executor.id} about the "${pinned.tournamentName}" deletion (DMs closed?) — still restorable via /restore-channel until the window closes.`);
  }
}

// Called by index.js's restore_channel_ button handler — same customId/record either from the
// deleter's DM or from /restore-channel's fallback listing.
async function restoreChannel(client, recordId) {
  const settled = await settleStatus(recordId, 'restored');
  if (!settled) return { applied: false, record: null };

  const guild = await client.guilds.fetch(settled.guildId).catch(() => null);
  if (!guild) {
    console.error(`[channel-deletion-undo] Could not restore "${settled.tournamentName}" — guild ${settled.guildId} not found (bot no longer in that server?).`);
    return { applied: true, record: settled };
  }

  const tournament = snapshotToTournament(settled.snapshot);
  await createTournamentChannel(guild, tournament, pinnedMessages);

  return { applied: true, record: settled };
}

// Every pending record whose 24h window has passed, still undecided, gets settled as
// 'permanently_deleted' — mirrors tournament-approval.js's expirePendingApprovals shape (edits the
// original DM in place rather than sending a new message).
async function expireOverdueRestoreWindows(client) {
  const overdue = await DeletedTournamentChannelModel.find({
    status: 'pending_confirmation',
    expiresAt: { $lte: new Date() },
  }).lean();

  for (const record of overdue) {
    const settled = await settleStatus(record._id, 'permanently_deleted');
    if (!settled) continue; // already decided/restored by something else between the query and here

    console.log(`[channel-deletion-undo] Restore window expired for "${record.tournamentName}" (${record.region}, guild ${record.guildId}) — treated as intentional, won't be recreated.`);

    if (!record.dmChannelId || !record.dmMessageId) continue;
    try {
      const dmChannel = await client.channels.fetch(record.dmChannelId);
      const msg = await dmChannel.messages.fetch(record.dmMessageId);
      await msg.edit({ embeds: [buildChannelDeletionUndoEmbed(settled, 'permanently_deleted')], components: [] });
    } catch (err) {
      console.error(`[channel-deletion-undo] Failed to edit expired DM for record ${record._id}:`, err.message);
    }
  }
}

// /restore-channel's listing (index.js) — every tournament in this guild still within its restore
// window, for a mod to act on when the DM was missed or the deleter has DMs disabled.
async function listPendingForGuild(guildId) {
  return DeletedTournamentChannelModel.find({ guildId, status: 'pending_confirmation' }).sort({ deletedAt: -1 }).lean();
}

function startExpirySweepScheduler(client) {
  // Runs once immediately (same precedent as channel-manager.js's startScheduler) so a window that
  // expired while the bot was offline is swept right away instead of after up to 20 minutes' delay.
  expireOverdueRestoreWindows(client).catch(err => console.error('[channel-deletion-undo] Initial sweep failed:', err.message));

  setInterval(() => {
    expireOverdueRestoreWindows(client).catch(err => console.error('[channel-deletion-undo] Sweep failed:', err.message));
  }, EXPIRY_SWEEP_INTERVAL_MS);
}

module.exports = {
  handleChannelDelete, restoreChannel, expireOverdueRestoreWindows, listPendingForGuild,
  startExpirySweepScheduler, snapshotToTournament, RESTORE_WINDOW_MS,
};
