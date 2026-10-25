const { SlashCommandBuilder } = require('discord.js');
const { resolve, formatDuration } = require('./youtube');
const { getPlayer, getOrCreatePlayer } = require('./player');

const definitions = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Search YouTube and play the first result')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Search terms, a YouTube video URL or a playlist URL').setRequired(true),
    ),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback, clear the queue and leave'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
].map((cmd) => cmd.toJSON());

const handlers = {
  async play(interaction) {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
    }

    await interaction.deferReply();
    const query = interaction.options.getString('query', true);

    let tracks, playlistTitle;
    try {
      ({ tracks, playlistTitle } = await resolve(query));
    } catch (err) {
      console.error('Search failed:', err.message);
      return interaction.editReply('Search failed, try again.');
    }
    if (!tracks.length) return interaction.editReply(`No results for **${query}**.`);
    for (const track of tracks) track.requestedBy = interaction.user.toString();

    const player = getOrCreatePlayer(voiceChannel, interaction.channel);
    try {
      const queued = await player.enqueue(tracks);
      if (playlistTitle) {
        return interaction.editReply(`📃 Added **${tracks.length}** songs from **${playlistTitle}** to the queue`);
      }
      const [track] = tracks;
      return interaction.editReply(
        queued
          ? `➕ Queued **${track.title}** (${formatDuration(track.duration)}) — position ${player.queue.length}`
          : `🔎 Found **${track.title}**`,
      );
    } catch (err) {
      console.error('Failed to connect:', err.message);
      player.destroy();
      return interaction.editReply('Could not join the voice channel.');
    }
  },

  async skip(interaction) {
    const player = getPlayer(interaction.guildId);
    if (!player?.current) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
    const title = player.current.title;
    player.skip();
    return interaction.reply(`⏭️ Skipped **${title}**`);
  },

  async stop(interaction) {
    const player = getPlayer(interaction.guildId);
    if (!player) return interaction.reply({ content: 'Not in a voice channel.', ephemeral: true });
    player.destroy();
    return interaction.reply('⏹️ Stopped and left the channel.');
  },

  async queue(interaction) {
    const player = getPlayer(interaction.guildId);
    if (!player?.current) return interaction.reply({ content: 'The queue is empty.', ephemeral: true });
    const lines = [`**Now playing:** ${player.current.title}`];
    player.queue.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title} (${formatDuration(t.duration)})`));
    if (player.queue.length > 10) lines.push(`…and ${player.queue.length - 10} more`);
    return interaction.reply(lines.join('\n'));
  },
};

module.exports = { definitions, handlers };
