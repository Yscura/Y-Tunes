require('dotenv').config();
const { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } = require('discord.js');
const { definitions, handleCommand, handleButton, handleSelect, handleAutocomplete } = require('./commands');
const { getPlayer, restoreSessions, shutdownPlayers } = require('./player');
const { warmUp } = require('./youtube');

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

// Load yt-dlp while logging in, so the first search doesn't wait for it.
warmUp().then((mode) => console.log(`yt-dlp: ${mode}`));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  // Guild commands update instantly; global ones can take up to an hour.
  const rest = new REST().setToken(DISCORD_TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(c.user.id, GUILD_ID)
    : Routes.applicationCommands(c.user.id);
  await rest.put(route, { body: definitions });
  console.log(`Registered ${definitions.length} slash commands ${GUILD_ID ? `in guild ${GUILD_ID}` : 'globally'}`);

  await restoreSessions(c);
});

// Save what's playing on shutdown so the next start resumes it.
function shutdown() {
  console.log('Shutting down, saving sessions…');
  shutdownPlayers();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inGuild()) return;

  if (interaction.isAutocomplete()) {
    return handleAutocomplete(interaction).catch((err) => console.error('Autocomplete failed:', err));
  }

  let handler;
  if (interaction.isChatInputCommand()) handler = handleCommand;
  else if (interaction.isButton() && interaction.customId.startsWith('player:')) handler = handleButton;
  else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('search:')) handler = handleSelect;
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (err) {
    console.error(`Interaction ${interaction.commandName ?? interaction.customId} failed:`, err);
    const reply = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

// Auto-leave when the bot's channel empties out (or refills).
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  getPlayer(newState.guild.id)?.checkIdle();
});

client.login(DISCORD_TOKEN);
