// team-match-lifecycle.js - Post-formation lifecycle for 6s/8s creative team matches:
// private channel creation -> lock -> leader pin -> unlock -> ready check -> auto-backfill,
// plus the vote-kick moderation system. Owns all state for "confirmed" matches — once
// creative-team-queue.js emits 'matchFormed', that engine is done with these players; this
// module takes over until the channel is eventually closed.
//
// In-memory only (not persisted), same precedent as matching.js's pendingMatches and
// party.js's pendingInvites — a restart loses any in-progress lock/ready-check/vote state.

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('./config');
const { toLogPR, getCreativeWideningTier } = require('./creative-queue');
const creativeTeamQueue = require('./creative-team-queue');
const channelLifecycle = require('./channel-lifecycle');
const {
  buildCreativeMatchConfirmedEmbed, buildCloseChannelButton,
  buildReadyCheckEmbed, buildReadyButton,
  buildTeamMethodVoteEmbed, buildTeamMethodVoteButtons,
  buildTeamChoiceEmbed, buildTeamChoiceButtons,
  buildTeamsAnnouncementEmbed,
} = require('./embeds');

// channelId -> matchState. matchState.players is the live, mutable roster (shrinks/grows as
// people are removed/backfilled); matchState.votekick tracks the one-vote-per-player cap,
// per-target fail cooldowns, and the currently active vote (if any).
const activeTeamMatches = new Map();

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function getMatchByChannelId(channelId) {
  return activeTeamMatches.get(channelId) ?? null;
}

function isPlayerInActiveTeamMatch(discordId) {
  for (const matchState of activeTeamMatches.values()) {
    if (matchState.players.some(p => p.discordId === discordId)) return true;
  }
  return false;
}

function endTeamMatch(channelId) {
  activeTeamMatches.delete(channelId);
}

async function startTeamMatch(units, mode, region, guild, client) {
  const players = units.flatMap(u => u.players);
  const category = creativeTeamQueue.categoryForMode(mode);
  const shortId = Math.random().toString(36).slice(2, 7);
  const matchCategory = await channelLifecycle.getOrCreateMatchCategory(guild);

  let channel;
  let voiceChannel;
  try {
    const modRoleId = process.env.MOD_ROLE_ID;

    channel = await guild.channels.create({
      name: `team-${category}-${shortId}`,
      type: ChannelType.GuildText,
      parent: matchCategory.id,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ...players.map(p => ({
          id: p.discordId,
          allow: [PermissionFlagsBits.ViewChannel],
          deny: [PermissionFlagsBits.SendMessages], // locked until unlockAndStartReadyCheck
        })),
        ...(modRoleId ? [{ id: modRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] : []),
      ],
    });

    const voiceName = `vc-${category}-${players[0].epicUsername}`
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 100);

    voiceChannel = await guild.channels.create({
      name: voiceName,
      type: ChannelType.GuildVoice,
      parent: matchCategory.id,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
        ...players.map(p => ({ id: p.discordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] })),
        ...(modRoleId ? [{ id: modRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
      ],
    });
  } catch (err) {
    console.error('Failed to create team match channel(s):', err.message);
    return;
  }

  const leader = players.reduce((best, p) => (p.totalPR > best.totalPR ? p : best));

  const matchState = {
    matchId: generateId('team'),
    channelId: channel.id,
    voiceChannelId: voiceChannel.id,
    mode,
    region,
    units: [...units],
    players: [...players],
    leaderId: leader.discordId,
    createdAt: new Date(),
    readyBy: new Set(),
    readyCheckActive: false,
    teams: null,
    votekick: { initiatedBy: new Set(), failCooldownByTarget: new Map(), activeVote: null },
    // Anyone ever removed from this specific match (vote-kicked or a ready-check no-show) —
    // excluded from backfilling back into it, see removePlayerAndBackfill.
    removedPlayerIds: new Set(),
  };
  activeTeamMatches.set(channel.id, matchState);

  try {
    await channel.send({
      content: players.map(p => `<@${p.discordId}>`).join(' '),
      embeds: [buildCreativeMatchConfirmedEmbed(players, mode)],
      components: [buildCloseChannelButton()],
    });

    const deletionPinMsg = await channel.send('⏰ This channel and voice channel will automatically delete in 2 hours.');
    await deletionPinMsg.pin();
  } catch (err) {
    console.error('Failed to post/pin confirmed match/deletion messages:', err.message);
  }

  channelLifecycle.scheduleChannelDeletion({
    client, guildId: guild.id, textChannelId: channel.id, voiceChannelId: voiceChannel.id,
    deleteAtMs: Date.now() + 2 * 60 * 60 * 1000, kind: 'creative-team',
  });

  // Teams have to be settled before the lock/ready-check timer starts — startTeamMethodVote's
  // chain (vote -> [team choice] -> announceTeams) posts the leader-lock message and arms that
  // timer itself once team assignment is finalised.
  await startTeamMethodVote(matchState, guild, client, channel);
}

// ── TEAM ASSIGNMENT ──────────────────────────────────────────────────────────
// Runs once, right after channel creation and before the lock/ready-check timer: a vote on how
// to split into two teams, then (depending on the result) either a per-player pick phase or an
// immediate PR-balanced split. Always finishes by calling announceTeams, which is what actually
// starts the pre-existing lock/ready-check flow.

function unitTotalPR(unit) {
  return unit.players.reduce((sum, p) => sum + p.totalPR, 0);
}

function teamTotalPR(team) {
  return team.reduce((sum, p) => sum + p.totalPR, 0);
}

// Places every unit (party or solo) into one of two equal-size teams, keeping each unit
// together whenever it fits in one team's remaining room. A unit too large to fit whole in
// either team is split as evenly as possible across both — the only way partied players end up
// on different teams. seedTeam1/seedTeam2 let callers pre-seed with already-decided placements
// (e.g. manual picks) and have this only place the remaining units around them.
function assignPartyAwareTeams(units, halfSize, seedTeam1 = [], seedTeam2 = []) {
  const team1 = [...seedTeam1];
  const team2 = [...seedTeam2];

  const sortedUnits = [...units].sort((a, b) =>
    b.players.length - a.players.length || unitTotalPR(b) - unitTotalPR(a)
  );

  for (const unit of sortedUnits) {
    const room1 = halfSize - team1.length;
    const room2 = halfSize - team2.length;
    const size = unit.players.length;
    const fitsTeam1 = size <= room1;
    const fitsTeam2 = size <= room2;

    if (fitsTeam1 && fitsTeam2) {
      (teamTotalPR(team1) <= teamTotalPR(team2) ? team1 : team2).push(...unit.players);
    } else if (fitsTeam1) {
      team1.push(...unit.players);
    } else if (fitsTeam2) {
      team2.push(...unit.players);
    } else {
      // Doesn't fit whole in either — split across both, filling whatever room remains and
      // handing the higher-PR half of the party to whichever team is currently lower on PR.
      const playersDesc = [...unit.players].sort((a, b) => b.totalPR - a.totalPR);
      for (const p of playersDesc) {
        const r1 = halfSize - team1.length;
        const r2 = halfSize - team2.length;
        if (r1 <= 0) team2.push(p);
        else if (r2 <= 0) team1.push(p);
        else (teamTotalPR(team1) <= teamTotalPR(team2) ? team1 : team2).push(p);
      }
    }
  }

  return { team1, team2 };
}

// Last-resort correction for the "Choose Own Teams" path: conflicting individual picks can
// leave team sizes unequal even though every unit stayed together on its picked side. Moves one
// player at a time from the oversized team to the undersized one — preferring a solo (unpartied)
// player so an honored party pick isn't broken unless there's no other way — choosing whichever
// move best closes the PR gap at each step. The size difference between two teams summing to an
// even target is always even, so this always converges to equal sizes.
function equalizeTeamSizes(team1, team2, unitByDiscordId) {
  while (team1.length !== team2.length) {
    const [bigger, smaller] = team1.length > team2.length ? [team1, team2] : [team2, team1];

    const soloCandidates = bigger.filter(p => (unitByDiscordId.get(p.discordId)?.players.length ?? 1) === 1);
    const candidates = soloCandidates.length > 0 ? soloCandidates : bigger;

    let bestPlayer = candidates[0];
    let bestGap = Infinity;
    for (const p of candidates) {
      const gap = Math.abs((teamTotalPR(bigger) - p.totalPR) - (teamTotalPR(smaller) + p.totalPR));
      if (gap < bestGap) { bestGap = gap; bestPlayer = p; }
    }

    bigger.splice(bigger.indexOf(bestPlayer), 1);
    smaller.push(bestPlayer);
  }
}

async function startTeamMethodVote(matchState, guild, client, channel) {
  matchState.teamMethodVote = { votes: new Map(), resolved: false };

  try {
    const msg = await channel.send({
      embeds: [buildTeamMethodVoteEmbed(0, 0, matchState.players.length)],
      components: [buildTeamMethodVoteButtons()],
    });
    matchState.teamMethodVoteMessageId = msg.id;
  } catch (err) {
    console.error('Failed to post team method vote:', err.message);
  }

  setTimeout(
    () => resolveTeamMethodVote(matchState, guild, client, channel).catch(console.error),
    config.teamQueue.teamMethodVoteSeconds * 1000
  );
}

function tallyTeamMethodVote(matchState) {
  let chooseCount = 0;
  let balancedCount = 0;
  for (const v of matchState.teamMethodVote.votes.values()) {
    if (v === 'choose') chooseCount++; else balancedCount++;
  }
  return { chooseCount, balancedCount };
}

function handleTeamMethodVoteButton(channelId, discordId, choice) {
  const matchState = activeTeamMatches.get(channelId);
  if (!matchState || !matchState.teamMethodVote || matchState.teamMethodVote.resolved) {
    return { status: 'not_found' };
  }
  if (!matchState.players.some(p => p.discordId === discordId)) return { status: 'not_participant' };

  matchState.teamMethodVote.votes.set(discordId, choice);
  const { chooseCount, balancedCount } = tallyTeamMethodVote(matchState);

  return { status: 'ok', chooseCount, balancedCount, totalCount: matchState.players.length };
}

async function resolveTeamMethodVote(matchState, guild, client, channel) {
  if (!activeTeamMatches.has(matchState.channelId)) return;
  if (!matchState.teamMethodVote || matchState.teamMethodVote.resolved) return;
  matchState.teamMethodVote.resolved = true;

  const { chooseCount, balancedCount } = tallyTeamMethodVote(matchState);
  const method = chooseCount > balancedCount ? 'choose' : 'balanced';
  const tieNote = chooseCount === balancedCount ? ' — tied, defaulting to PR Balanced Teams' : '';

  await channel.send(
    `🗳️ Vote result: **${method === 'choose' ? 'Choose Own Teams' : 'PR Balanced Teams'}** wins `
    + `(👥${chooseCount} / ⚡${balancedCount})${tieNote}.`
  ).catch(console.error);

  if (method === 'choose') {
    await startTeamChoicePhase(matchState, guild, client, channel);
  } else {
    const halfSize = creativeTeamQueue.targetSizeForMode(matchState.mode) / 2;
    const { team1, team2 } = assignPartyAwareTeams(matchState.units, halfSize);
    await announceTeams(matchState, guild, client, channel, team1, team2);
  }
}

function findUnitForPlayer(matchState, discordId) {
  return matchState.units.find(u => u.players.some(p => p.discordId === discordId)) ?? null;
}

// Rosters reflect *unit* picks — if any member of a party has picked a team, every member of
// that party shows on that team's list, per "always keep partied players together".
function currentTeamChoiceRosters(matchState) {
  const team1 = [];
  const team2 = [];
  const undecided = [];

  for (const unit of matchState.units) {
    const pick = matchState.teamChoice.picks.get(unit.unitId);
    if (pick === 1) team1.push(...unit.players);
    else if (pick === 2) team2.push(...unit.players);
    else undecided.push(...unit.players);
  }

  return { team1, team2, undecided };
}

async function startTeamChoicePhase(matchState, guild, client, channel) {
  matchState.teamChoice = { picks: new Map(), resolved: false }; // unitId -> 1 | 2

  try {
    const msg = await channel.send({
      embeds: [buildTeamChoiceEmbed([], [], matchState.players)],
      components: [buildTeamChoiceButtons()],
    });
    matchState.teamChoiceMessageId = msg.id;
  } catch (err) {
    console.error('Failed to post team choice prompt:', err.message);
  }

  setTimeout(
    () => resolveTeamChoicePhase(matchState, guild, client, channel).catch(console.error),
    config.teamQueue.teamChoiceSeconds * 1000
  );
}

// Clicking Join Team 1/2 assigns the player's *whole unit* (their party, if any) to that team —
// so a party always moves together regardless of which member happens to click. Re-clicking (by
// the same or a different member of the same party) just overwrites the unit's pick.
function handleTeamPickButton(channelId, discordId, teamNumber) {
  const matchState = activeTeamMatches.get(channelId);
  if (!matchState || !matchState.teamChoice || matchState.teamChoice.resolved) {
    return { status: 'not_found' };
  }

  const unit = findUnitForPlayer(matchState, discordId);
  if (!unit) return { status: 'not_participant' };

  matchState.teamChoice.picks.set(unit.unitId, teamNumber);
  const { team1, team2, undecided } = currentTeamChoiceRosters(matchState);

  return { status: 'ok', team1, team2, undecided };
}

async function resolveTeamChoicePhase(matchState, guild, client, channel) {
  if (!activeTeamMatches.has(matchState.channelId)) return;
  if (!matchState.teamChoice || matchState.teamChoice.resolved) return;
  matchState.teamChoice.resolved = true;

  const halfSize = creativeTeamQueue.targetSizeForMode(matchState.mode) / 2;
  let { team1, team2, undecided } = currentTeamChoiceRosters(matchState);

  const undecidedUnits = matchState.units.filter(u => !matchState.teamChoice.picks.has(u.unitId));
  if (undecidedUnits.length > 0) {
    ({ team1, team2 } = assignPartyAwareTeams(undecidedUnits, halfSize, team1, team2));
  }

  const unitByDiscordId = new Map();
  for (const unit of matchState.units) {
    for (const p of unit.players) unitByDiscordId.set(p.discordId, unit);
  }
  equalizeTeamSizes(team1, team2, unitByDiscordId);

  if (undecided.length > 0) {
    await channel.send(
      `⏱️ Team pick closed. Auto-assigned to balance: ${undecided.map(p => `**${p.epicUsername}**`).join(', ')}.`
    ).catch(console.error);
  }

  await announceTeams(matchState, guild, client, channel, team1, team2);
}

// Shared finalisation for both team-decision paths: records the split, announces it, then hands
// off to the pre-existing lock/ready-check flow (unchanged from before team assignment existed).
async function announceTeams(matchState, guild, client, channel, team1, team2) {
  matchState.teams = { 1: team1, 2: team2 };

  try {
    const msg = await channel.send({ embeds: [buildTeamsAnnouncementEmbed(team1, team2)] });
    await msg.pin().catch(err => console.error('Failed to pin teams announcement:', err.message));
  } catch (err) {
    console.error('Failed to post teams announcement:', err.message);
  }

  const leader = matchState.players.find(p => p.discordId === matchState.leaderId);

  try {
    const pinMsg = await channel.send(
      `🔒 Channel locked for ${config.teamQueue.lockSeconds}s. Add **${leader.epicUsername}** in game.`
    );
    await pinMsg.pin();
  } catch (err) {
    console.error('Failed to post/pin leader message:', err.message);
  }

  setTimeout(
    () => unlockAndStartReadyCheck(matchState, guild, client, channel).catch(console.error),
    config.teamQueue.lockSeconds * 1000
  );
}

async function unlockAndStartReadyCheck(matchState, guild, client, channel) {
  if (!activeTeamMatches.has(matchState.channelId)) return; // channel closed in the meantime

  for (const p of matchState.players) {
    try {
      await channel.permissionOverwrites.edit(p.discordId, { SendMessages: true });
    } catch (err) {
      console.error('Failed to unlock permissions for player:', err.message);
    }
  }

  matchState.readyCheckActive = true;
  matchState.readyBy = new Set();

  try {
    const msg = await channel.send({
      content: matchState.players.map(p => `<@${p.discordId}>`).join(' '),
      embeds: [buildReadyCheckEmbed(0, matchState.players.length)],
      components: [buildReadyButton()],
    });
    matchState.readyCheckMessageId = msg.id;
  } catch (err) {
    console.error('Failed to post ready-check message:', err.message);
  }

  setTimeout(
    () => resolveReadyCheck(matchState, guild, client, channel).catch(console.error),
    config.teamQueue.readyCheckSeconds * 1000
  );
}

function handleReadyButton(channelId, discordId) {
  const matchState = activeTeamMatches.get(channelId);
  if (!matchState) return { status: 'not_found' };
  if (!matchState.readyCheckActive) return { status: 'not_active' };
  if (!matchState.players.some(p => p.discordId === discordId)) return { status: 'not_participant' };

  matchState.readyBy.add(discordId);
  return { status: 'ok', readyCount: matchState.readyBy.size, totalCount: matchState.players.length };
}

async function resolveReadyCheck(matchState, guild, client, channel) {
  if (!activeTeamMatches.has(matchState.channelId)) return;
  matchState.readyCheckActive = false;

  const nonResponders = matchState.players.filter(p => !matchState.readyBy.has(p.discordId));

  for (const p of nonResponders) {
    await removePlayerAndBackfill(matchState, p.discordId, guild, client, channel);
  }

  if (nonResponders.length > 0) {
    await channel.send(
      `⏱️ Ready check closed. Removed and re-queued: ${nonResponders.map(p => `**${p.discordUsername}**`).join(', ')}.`
    ).catch(console.error);
  } else {
    await channel.send('✅ Everyone is ready!').catch(console.error);
  }
}

// Shared removal path for both ready-check timeout and a passed vote-kick: drop the player,
// re-queue them as a solo unit, then try to backfill the vacancy straight from the team queue.
// No fresh ready-check for backfilled players — they just joined the queue, so they're
// presumed present; only players who were already in the match go through lock/ready.
async function removePlayerAndBackfill(matchState, discordId, guild, client, channel) {
  const removedPlayer = matchState.players.find(p => p.discordId === discordId);
  if (!removedPlayer) return;

  matchState.players = matchState.players.filter(p => p.discordId !== discordId);
  matchState.removedPlayerIds.add(discordId);

  if (matchState.teams) {
    matchState.teams[1] = matchState.teams[1].filter(p => p.discordId !== discordId);
    matchState.teams[2] = matchState.teams[2].filter(p => p.discordId !== discordId);
  }

  try {
    await channel.permissionOverwrites.edit(discordId, { ViewChannel: false, SendMessages: false });
  } catch (err) {
    console.error('Failed to remove permissions for departed player:', err.message);
  }

  creativeTeamQueue.queueUnit([removedPlayer], matchState.mode, matchState.region);

  await backfillVacancies(matchState, guild, client, channel);
}

// Keeps retrying every teamQueue.backfillRetrySeconds until the match is back at full size or
// the channel is closed (activeTeamMatches no longer has it) — a single attempt right after a
// removal will often find nobody waiting yet, so this re-checks the queue periodically instead
// of leaving the match permanently short-handed. matchState.backfillRetryScheduled guards
// against stacking multiple parallel retry chains if removals happen close together.
async function backfillVacancies(matchState, guild, client, channel) {
  const targetSize = creativeTeamQueue.targetSizeForMode(matchState.mode);
  const vacantCount = targetSize - matchState.players.length;

  if (vacantCount > 0 && matchState.players.length > 0) {
    const age = (Date.now() - new Date(matchState.createdAt).getTime()) / 1000;
    const tier = getCreativeWideningTier(age);
    const groupAvg = matchState.players.reduce((sum, p) => sum + toLogPR(p.totalPR), 0) / matchState.players.length;
    const groupPlats = new Set(matchState.players.map(p => p.platform));

    const pulledUnits = creativeTeamQueue.pullReplacementUnits(
      matchState.mode, matchState.region, vacantCount, groupAvg, groupPlats, tier, matchState.removedPlayerIds
    );
    const newPlayers = pulledUnits.flatMap(u => u.players);

    if (newPlayers.length > 0) {
      matchState.players.push(...newPlayers);

      // Teams were already decided before this vacancy opened up — slot the replacement unit(s)
      // into whichever team keeps things balanced, same party-aware logic as initial assignment.
      let teamByDiscordId = null;
      if (matchState.teams) {
        const halfSize = targetSize / 2;
        const { team1, team2 } = assignPartyAwareTeams(pulledUnits, halfSize, matchState.teams[1], matchState.teams[2]);
        matchState.teams[1] = team1;
        matchState.teams[2] = team2;
        teamByDiscordId = new Map([
          ...team1.map(p => [p.discordId, 1]),
          ...team2.map(p => [p.discordId, 2]),
        ]);
      }

      for (const p of newPlayers) {
        try {
          await channel.permissionOverwrites.edit(p.discordId, { ViewChannel: true, SendMessages: true });
        } catch (err) {
          console.error('Failed to grant permissions to backfilled player:', err.message);
        }
      }

      const mentionList = newPlayers.map(p => {
        const teamTag = teamByDiscordId ? ` (Team ${teamByDiscordId.get(p.discordId)})` : '';
        return `<@${p.discordId}>${teamTag}`;
      }).join(' ');

      await channel.send({
        content: `${mentionList} — added to fill an open slot. Welcome!`,
      }).catch(console.error);
    }
  }

  const stillShort = matchState.players.length > 0 && matchState.players.length < targetSize;
  if (stillShort && !matchState.backfillRetryScheduled) {
    matchState.backfillRetryScheduled = true;
    setTimeout(() => {
      matchState.backfillRetryScheduled = false;
      if (!activeTeamMatches.has(matchState.channelId)) return; // channel closed, stop retrying
      backfillVacancies(matchState, guild, client, channel).catch(console.error);
    }, config.teamQueue.backfillRetrySeconds * 1000);
  }
}

// ── VOTE KICK ───────────────────────────────────────────────────────────────────

function handleVoteKickCommand(channelId, initiatorId, targetId) {
  const matchState = activeTeamMatches.get(channelId);
  if (!matchState) return { status: 'not_in_match' };

  const age = (Date.now() - new Date(matchState.createdAt).getTime()) / 1000;
  if (age < config.teamQueue.voteKickMinChannelAgeSeconds) {
    return { status: 'too_early', remaining: Math.ceil(config.teamQueue.voteKickMinChannelAgeSeconds - age) };
  }
  if (!matchState.players.some(p => p.discordId === initiatorId)) return { status: 'not_participant' };
  if (initiatorId === targetId) return { status: 'self_target' };
  if (!matchState.players.some(p => p.discordId === targetId)) return { status: 'target_not_in_match' };
  if (matchState.votekick.initiatedBy.has(initiatorId)) return { status: 'already_initiated' };
  if (matchState.votekick.activeVote) return { status: 'vote_in_progress' };

  const cooldownUntil = matchState.votekick.failCooldownByTarget.get(targetId);
  if (cooldownUntil && Date.now() < cooldownUntil) {
    return { status: 'target_cooldown', remaining: Math.ceil((cooldownUntil - Date.now()) / 1000) };
  }

  matchState.votekick.initiatedBy.add(initiatorId);

  const voteId = generateId('vote');
  matchState.votekick.activeVote = { voteId, initiatorId, targetId, yes: new Set(), no: new Set() };

  return { status: 'started', voteId, targetId, initiatorId, eligibleCount: matchState.players.length - 1 };
}

function handleVoteKickButton(channelId, voteId, discordId, choice) {
  const matchState = activeTeamMatches.get(channelId);
  const vote = matchState?.votekick.activeVote;
  if (!vote || vote.voteId !== voteId) return { status: 'not_found' };
  if (discordId === vote.targetId) return { status: 'cannot_vote_self' };
  if (!matchState.players.some(p => p.discordId === discordId)) return { status: 'not_participant' };

  vote.yes.delete(discordId);
  vote.no.delete(discordId);
  (choice === 'yes' ? vote.yes : vote.no).add(discordId);

  return { status: 'ok', yesCount: vote.yes.size, noCount: vote.no.size };
}

function startVoteResolutionTimer(channelId, voteId, guild, client, channel) {
  setTimeout(
    () => resolveVoteKick(channelId, voteId, guild, client, channel).catch(console.error),
    config.teamQueue.voteKickWindowSeconds * 1000
  );
}

async function resolveVoteKick(channelId, voteId, guild, client, channel) {
  const matchState = activeTeamMatches.get(channelId);
  const vote = matchState?.votekick.activeVote;
  if (!vote || vote.voteId !== voteId) return;

  const eligibleCount = matchState.players.length - 1; // target excluded
  const threshold = Math.ceil(config.teamQueue.voteKickMajority * eligibleCount);
  const passed = vote.yes.size >= threshold;

  matchState.votekick.activeVote = null;

  const targetPlayer = matchState.players.find(p => p.discordId === vote.targetId);
  const targetLabel = targetPlayer?.discordUsername ?? vote.targetId;

  if (passed) {
    await channel.send(`✅ Vote passed (${vote.yes.size}/${eligibleCount}) — removing **${targetLabel}**.`).catch(console.error);
    if (targetPlayer) await removePlayerAndBackfill(matchState, targetPlayer.discordId, guild, client, channel);
  } else {
    matchState.votekick.failCooldownByTarget.set(vote.targetId, Date.now() + config.teamQueue.voteKickFailCooldownSeconds * 1000);
    const cooldownMinutes = config.teamQueue.voteKickFailCooldownSeconds / 60;
    await channel.send(
      `❌ Vote failed (${vote.yes.size}/${eligibleCount}) — **${targetLabel}** stays. No new vote against them for ${cooldownMinutes} minutes.`
    ).catch(console.error);
  }
}

module.exports = {
  startTeamMatch,
  getMatchByChannelId,
  isPlayerInActiveTeamMatch,
  endTeamMatch,
  handleReadyButton,
  handleTeamMethodVoteButton,
  handleTeamPickButton,
  handleVoteKickCommand,
  handleVoteKickButton,
  startVoteResolutionTimer,
};
