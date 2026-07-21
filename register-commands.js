require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
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
    .setDescription('Post the pinned Creative 6s (3v3) queue embed into CREATIVE_6S_CHANNEL_ID'),

  new SlashCommandBuilder()
    .setName('setup-creative-8s')
    .setDescription('Post the pinned Creative 8s (4v4) queue embed into CREATIVE_8S_CHANNEL_ID'),

  new SlashCommandBuilder()
    .setName('setup-howto')
    .setDescription('Post the pinned "How to Use MatchMaker" embed into HOWTO_CHANNEL_ID'),

  new SlashCommandBuilder()
    .setName('votekick')
    .setDescription('Start a vote to kick a player from this 6s/8s match channel')
    .addUserOption(o => o.setName('player').setDescription('Player to vote-kick').setRequired(true)),

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