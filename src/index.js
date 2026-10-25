require('dotenv').config();
const { Client, Events, GatewayIntentBits, REST, Routes } = require('discord.js');
const { definitions, handlers } = require('./commands');

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

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
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  const handler = handlers[interaction.commandName];
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (err) {
    console.error(`/${interaction.commandName} failed:`, err);
    const reply = { content: 'Something went wrong.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
