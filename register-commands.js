require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('matchmaker-setup')
    .setDescription('Set up all roles, categories, channels and starter embeds MatchMaker needs (admin-only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('yunite-token').setDescription('Your Yunite API token').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setup-tournament')
    .setDescription('Create the queue embed for a tournament channel')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament name').setRequired(true))
    .addStringOption(o => o.setName('region').setDescription('Region').setRequired(true)
      .addChoices(
        { name: 'EU', value: 'EU' },
        { name: 'NA Central', value: 'NAC' },
        { name: 'Middle East', value: 'ME' },
      ))
    .addBooleanOption(o => o.setName('trios').setDescription('Is this a trios tournament?').setRequired(false)),

  new SlashCommandBuilder()
    .setName('setup-roles')
    .setDescription('Post the roles selection embed in this channel'),

  new SlashCommandBuilder()
    .setName('cancel-tournament')
    .setDescription('Cancel tournament and delete this channel'),

  new SlashCommandBuilder()
    .setName('check-tournaments')
    .setDescription('Manually check for upcoming tournaments and create channels'),

  new SlashCommandBuilder()
    .setName('party-invite')
    .setDescription('Invite another player to your party, up to 5 members (use in #form-party)')
    .addUserOption(o => o.setName('user').setDescription('Player to invite').setRequired(true)),

  new SlashCommandBuilder()
    .setName('party-leave')
    .setDescription('Leave/disband your current party'),

  new SlashCommandBuilder()
    .setName('party-status')
    .setDescription('Check your current party status'),

  new SlashCommandBuilder()
    .setName('setup-party-channel')
    .setDescription('Post the pinned party-forming instructions in this channel (run once in #form-party)'),

  new SlashCommandBuilder()
    .setName('setup-creative-1v1')
    .setDescription('Post the pinned Creative 1v1 queue embed in this channel (run once)'),

  new SlashCommandBuilder()
    .setName('setup-creative-2v2')
    .setDescription('Post the pinned Creative 2v2 queue embed in this channel (run once)'),

  new SlashCommandBuilder()
    .setName('setup-creative-6s')
    .setDescription('Post the pinned Creative 6s (3v3) queue embed in this channel (run once)'),

  new SlashCommandBuilder()
    .setName('setup-creative-8s')
    .setDescription('Post the pinned Creative 8s (4v4) queue embed in this channel (run once)'),

  new SlashCommandBuilder()
    .setName('setup-howto')
    .setDescription('Post the pinned "How to Use MatchMaker" embed in this channel'),

  new SlashCommandBuilder()
    .setName('votekick')
    .setDescription('Start a vote to kick a player from this 6s/8s match channel')
    .addUserOption(o => o.setName('player').setDescription('Player to vote-kick').setRequired(true)),

  new SlashCommandBuilder()
    .setName('refresh-stats')
    .setDescription('Force a rescrape of your Fortnite Tracker stats (once per hour)'),

  // ── MOD DEBUG COMMANDS (MatchMaker Mod role only) ──────────────────────────
  new SlashCommandBuilder()
    .setName('bot-status')
    .setDescription('[Mod] Show bot uptime, MongoDB/Yunite connectivity, and active queue/match/party counts'),

  new SlashCommandBuilder()
    .setName('queue-status')
    .setDescription('[Mod] List all active queues across every tournament and creative mode'),

  new SlashCommandBuilder()
    .setName('player-lookup')
    .setDescription('[Mod] Look up a player\'s stored stats')
    .addUserOption(o => o.setName('user').setDescription('Player to look up').setRequired(true)),

  new SlashCommandBuilder()
    .setName('clear-queue')
    .setDescription('[Mod] Empty a specific tournament queue')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('force-refresh')
    .setDescription('[Mod] Force a fresh Fortnite Tracker scrape for a player, ignoring the 24h cache')
    .addUserOption(o => o.setName('user').setDescription('Player to refresh').setRequired(true)),

].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('❌ Error:', err);
  }
})();