// tournament-approval.js - Manual-approval gate before a genuinely new tournament (by Fortnite
// Tracker's own eventId — the same stable per-region identity channel-manager.js already uses for
// dedup/rename) gets a channel created across every server. Global, not per-guild: one shared
// scrape (tournament-scraper.js) already fans out to every guild, so the approval decision follows
// the same "decide once, apply everywhere" shape rather than asking per-guild — gateTournaments is
// called exactly once per tick (channel-manager.js's runTournamentCheckTick, before the per-guild
// loop), not once per guild, so a brand-new eventId only ever produces one pending record/DM no
// matter how many servers the bot is in.
//
// On a genuinely new eventId, DMs BOT_OWNER_DISCORD_ID (same env var + discord-dm.js's dmUser
// helper suggestions.js already established as this bot's "reach the developer" pattern) with the
// tournament's details and Approve/Reject buttons (index.js's tournament_approve_/
// tournament_reject_ handlers). Nothing gets created anywhere until approved.
//
// Edge case: a pending tournament whose own start time passes with no decision is marked
// 'expired', NOT auto-approved. Auto-approving on timeout would mean anything — including
// something the owner specifically would have rejected — launches bot-wide just because the owner
// was asleep or busy, which defeats the entire point of a manual review gate: its failure mode
// would become "review is optional if you wait long enough." Marking it 'expired' instead fails
// safe (nothing ever goes live without an actual approval) at the cost of occasionally missing a
// legitimate short-notice tournament — an accepted, deliberate tradeoff. See expirePendingApprovals.

const TournamentApprovalModel = require('./models/TournamentApproval');
const { dmUser } = require('./discord-dm');
const { buildTournamentApprovalEmbed, buildTournamentApprovalButtons } = require('./embeds');

const BOT_OWNER_DISCORD_ID = process.env.BOT_OWNER_DISCORD_ID || null;

async function getRecord(eventId) {
  return TournamentApprovalModel.findOne({ eventId }).lean();
}

// Seeds an already-'approved' record with no DM for an eventId that already has a live channel —
// either from before this feature shipped, or created earlier this same process — so a
// pre-existing tournament is never retroactively gated or DMed for "approval" it effectively
// already has. Non-destructive rollout, same philosophy as the earlier 6s/8s setup change.
async function seedApprovedIfMissing(eventId, tournament) {
  await TournamentApprovalModel.updateOne(
    { eventId },
    { $setOnInsert: { eventId, status: 'approved', tournament, createdAt: new Date(), decidedAt: new Date() } },
    { upsert: true }
  );
}

// DMs the owner and creates the 'pending' record — called at most once per eventId (gateTournaments
// below only calls this when no record exists yet at all). Never throws on a DM failure (owner
// DMs closed, BOT_OWNER_DISCORD_ID unset, etc.) — the record is still created as pending either
// way, so the tournament isn't silently lost, just unapproved until someone notices or it expires.
async function requestApproval(client, tournament) {
  await TournamentApprovalModel.create({ eventId: tournament.eventId, status: 'pending', tournament });

  if (!BOT_OWNER_DISCORD_ID) {
    console.warn(`[tournament-approval] BOT_OWNER_DISCORD_ID not set — "${tournament.name}" (${tournament.region}) is pending but nobody was DMed.`);
    return;
  }

  const msg = await dmUser(client, BOT_OWNER_DISCORD_ID, {
    embeds: [buildTournamentApprovalEmbed(tournament)],
    components: [buildTournamentApprovalButtons(tournament.eventId)],
  });

  if (msg) {
    await TournamentApprovalModel.updateOne(
      { eventId: tournament.eventId },
      { $set: { dmChannelId: msg.channelId, dmMessageId: msg.id } }
    );
  }
}

// Filters a scrape's tournaments down to only the ones actually cleared to have channels created
// this tick (approved, or already-live pre-existing ones) — gating happens here, once, BEFORE
// channel-manager.js's per-guild checkAndCreateChannels loop, so a brand-new eventId only ever
// triggers one DM regardless of guild count. Called from both the scheduled tick and the
// /check-tournaments manual command (index.js) — same gate either way, no bypass.
async function gateTournaments(client, tournaments, pinnedMessages) {
  const approved = [];

  for (const tournament of tournaments) {
    if (!tournament.eventId) {
      // No stable identity to gate on — not reachable from real Fortnite Tracker data (every real
      // session carries an eventId, see tournament-scraper.js), but fail open rather than silently
      // dropping a tournament the rest of the pipeline would otherwise have created.
      approved.push(tournament);
      continue;
    }

    const record = await getRecord(tournament.eventId);

    if (!record) {
      const alreadyLive = Object.values(pinnedMessages).some(p => p.tournamentEventId === tournament.eventId);
      if (alreadyLive) {
        await seedApprovedIfMissing(tournament.eventId, tournament);
        approved.push(tournament);
        continue;
      }

      await requestApproval(client, tournament);
      continue; // pending as of just now — never approved same-tick
    }

    if (record.status === 'approved') approved.push(tournament);
    // 'pending' -> still waiting, skip silently (no re-DM this tick)
    // 'rejected' / 'expired' -> skip forever
  }

  return approved;
}

// Atomically transitions a record OUT of 'pending' — the `status: 'pending'` filter is what makes
// a double-click (or a race against expirePendingApprovals) a safe no-op: only the first
// transition actually matches and applies, everything after finds no matching document and gets
// null back.
async function settlePending(eventId, newStatus) {
  return TournamentApprovalModel.findOneAndUpdate(
    { eventId, status: 'pending' },
    { $set: { status: newStatus, decidedAt: new Date() } },
    { returnDocument: 'after' }
  ).lean();
}

// Called by index.js's tournament_approve_/tournament_reject_ button handlers. For an approve
// whose tournament's start time has already passed by the time someone actually clicks the
// button, this settles it as 'expired' instead of 'approved' — approving something that's already
// started (or already over) would create a channel nobody can meaningfully use, same "missed it"
// philosophy as the timeout path below, just triggered at decision time instead of by the sweep.
async function decide(eventId, decision) {
  if (decision === 'reject') {
    const settled = await settlePending(eventId, 'rejected');
    return { applied: !!settled, status: 'rejected', tournament: settled?.tournament ?? null };
  }

  const pending = await TournamentApprovalModel.findOne({ eventId, status: 'pending' }).lean();
  if (!pending) return { applied: false, status: null, tournament: null };

  const startMs = new Date(pending.tournament.beginTime).getTime();
  const tooLate = !pending.tournament.isPermanent && startMs <= Date.now();
  const finalStatus = tooLate ? 'expired' : 'approved';

  const settled = await settlePending(eventId, finalStatus);
  return { applied: !!settled, status: finalStatus, tournament: settled?.tournament ?? pending.tournament };
}

// Sweeps every still-pending record whose tournament's own start time has passed and marks it
// 'expired' — see this module's doc comment for why this doesn't auto-approve instead. Piggybacks
// on channel-manager.js's existing tournament-check tick (TOURNAMENT_CHECK_INTERVAL_MS, 4 hours as
// of this writing) rather than its own timer; missing a start time by up to that long is still
// immaterial here — a still-PENDING record was never approved, so no channel was ever live for it
// regardless of how promptly this sweep runs. This is pure "stop showing stale Approve/Reject
// buttons on an old DM" bookkeeping, not anything that gates a real channel's timing.
async function expirePendingApprovals(client) {
  const overdue = await TournamentApprovalModel.find({
    status: 'pending',
    'tournament.isPermanent': { $ne: true },
    'tournament.beginTime': { $lte: new Date().toISOString() },
  }).lean();

  for (const record of overdue) {
    const settled = await settlePending(record.eventId, 'expired');
    if (!settled) continue; // already decided/expired by something else between the query and here

    console.log(`[tournament-approval] "${record.tournament.name}" (${record.tournament.region}) expired unactioned — start time passed with no decision.`);

    if (!record.dmChannelId || !record.dmMessageId) continue;
    try {
      const channel = await client.channels.fetch(record.dmChannelId);
      const msg = await channel.messages.fetch(record.dmMessageId);
      await msg.edit({ embeds: [buildTournamentApprovalEmbed(record.tournament, 'expired')], components: [] });
    } catch (err) {
      console.error(`[tournament-approval] Failed to edit expired DM for ${record.eventId}:`, err.message);
    }
  }
}

module.exports = {
  gateTournaments,
  decide,
  expirePendingApprovals,
  BOT_OWNER_DISCORD_ID,
};
