// match-channels.js - Creates the private per-guild channel(s) for a duo/trio or creative
// 1v1/2v2 match the moment it's found, replacing the old DM-then-channel-on-accept flow. A
// same-server match gets one channel; a cross-server match gets one *per guild involved*, each
// shown to that guild's own players (Discord permissions are guild-scoped — a channel can't be
// shared across servers), with the other side's players rendered as a text-only cross-server
// card instead of a pingable member.

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const channelLifecycle = require('./channel-lifecycle');
const matching = require('./matching');
const { getRoleId } = require('./guild-config');
const {
  buildMatchCard, buildCreativeMatchCard, buildCrossServerPlayerCard, buildMatchButtons,
} = require('./embeds');

function groupPlayersByGuildId(players) {
  const byGuild = new Map();
  for (const p of players) {
    if (!byGuild.has(p.guildId)) byGuild.set(p.guildId, []);
    byGuild.get(p.guildId).push(p);
  }
  return byGuild;
}

function buildPlayerCard(player, viewingGuildId, kind, label) {
  if (player.guildId === viewingGuildId) {
    return kind === 'creative' ? buildCreativeMatchCard(player) : buildMatchCard(player, label);
  }
  return buildCrossServerPlayerCard(player, kind);
}

// allPlayers is the full match roster (both units combined). Creates one channel per distinct
// guildId present in allPlayers, registers the result against the pending match (matchId) so
// accept/reject/expire can broadcast to every one of them, and returns that same map.
async function createMatchChannelsForMatch(matchId, allPlayers, { client, kind, label }) {
  const byGuild = groupPlayersByGuildId(allPlayers);
  const channelsByGuildId = new Map();

  for (const [guildId, localPlayers] of byGuild) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      console.error(`Cannot create match channel — bot is not in guild ${guildId} (player(s): ${localPlayers.map(p => p.discordUsername).join(', ')})`);
      continue;
    }

    const modRoleId = getRoleId(guildId, 'mod');
    const category = await channelLifecycle.getOrCreateMatchCategory(guild);
    const channelName = `${kind === 'creative' ? 'creative' : 'match'}-${localPlayers.map(p => p.epicUsername).join('-')}`
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 100);

    let channel;
    try {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          ...localPlayers.map(p => ({ id: p.discordId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] })),
          ...(modRoleId ? [{ id: modRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] : []),
        ],
      });
    } catch (err) {
      console.error(`Failed to create match channel in guild ${guildId}:`, err.message);
      continue;
    }

    const msg = await channel.send({
      content: localPlayers.map(p => `<@${p.discordId}>`).join(' '),
      embeds: allPlayers.map(p => buildPlayerCard(p, guildId, kind, label)),
      components: [buildMatchButtons(matchId)],
    }).catch(err => {
      console.error(`Failed to post match card in guild ${guildId}:`, err.message);
      return null;
    });

    channelsByGuildId.set(guildId, { channelId: channel.id, messageId: msg?.id ?? null });
  }

  matching.attachMatchChannels(matchId, channelsByGuildId);
  return channelsByGuildId;
}

module.exports = { createMatchChannelsForMatch, groupPlayersByGuildId };
