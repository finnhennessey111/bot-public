require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  // No setDefaultMemberPermissions here — same as the "[Mod]" commands below. A Discord-level
  // permission bit can't express "the MatchMaker Mod role, OR Manage Server if that role doesn't
  // exist yet" (a static bitfield has no way to reference a per-guild custom role at all), so this
  // is gated entirely at runtime in index.js's handler instead. See that handler's comment for why.
  new SlashCommandBuilder()
    .setName('matchmaker-setup')
    .setDescription('Set up all roles, categories, channels and starter embeds MatchMaker needs (mods or Manage Server)'),

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

  new SlashCommandBuilder()
    .setName('unlink-epic')
    .setDescription('Unlink your Epic account — use this before linking a different one, or to remove your link entirely'),

  // ── MOD DEBUG COMMANDS (MatchMaker Mod role only) ──────────────────────────
  new SlashCommandBuilder()
    .setName('bot-status')
    .setDescription('[Mod] Show bot uptime, MongoDB/Epic OAuth connectivity, and active queue/match counts'),

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

  new SlashCommandBuilder()
    .setName('grant-mod')
    .setDescription('[Owner only] Grant the MatchMaker Mod role to a user')
    .addUserOption(o => o.setName('user').setDescription('User to grant MatchMaker Mod').setRequired(true)),

  new SlashCommandBuilder()
    .setName('test-webhook')
    .setDescription('Simulate a successful Stripe payment to test subscription activation (mod only)')
    .addUserOption(o => o.setName('user').setDescription('User to simulate the subscription for (defaults to you)').setRequired(false))
    .addStringOption(o => o.setName('plan').setDescription('Plan to simulate (defaults to monthly)').setRequired(false)
      .addChoices(
        { name: 'Monthly', value: 'monthly' },
        { name: 'Yearly', value: 'yearly' },
      )),

].map(c => c.toJSON());

// Discord's PUT applicationCommands endpoint is idempotent — it just overwrites the app's entire
// command set with `commands`, so this is safe to call on every bot startup (index.js's ready
// handler does exactly that) as well as standalone via `node register-commands.js` below. No diffing
// needed: an unchanged command set PUT again is a harmless no-op from Discord's side.
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  console.log('Registering slash commands...');
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );
  console.log(`✅ Slash commands registered! (${commands.length} commands)`);
}

module.exports = { registerCommands };

if (require.main === module) {
  registerCommands().catch(err => {
    console.error('❌ Error:', err);
    process.exitCode = 1;
  });
}