const {
  ActionRowBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { resolve, search, formatDuration, parseTime } = require('./youtube');
const { LOOP_MODES, getPlayer, getOrCreatePlayer } = require('./player');
const playlists = require('./playlists');
const settings = require('./settings');
const sessions = require('./sessions');

const QUEUE_PAGE_SIZE = 10;

const queryOption = (opt) =>
  opt.setName('query').setDescription('Search terms, a YouTube video URL or a playlist URL').setRequired(true);
const playlistNameOption = (opt) =>
  opt.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(50).setAutocomplete(true);

const definitions = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Search YouTube and play the first result')
    .addStringOption(queryOption),
  new SlashCommandBuilder()
    .setName('playnext')
    .setDescription('Like /play, but puts the song at the front of the queue')
    .addStringOption(queryOption),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search YouTube and pick which result to queue')
    .addStringOption((opt) => opt.setName('query').setDescription('Search terms').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and leave. The queue is saved for /resume'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback, or continue the queue saved by /stop'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song and its progress'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current queue')
    .addIntegerOption((opt) => opt.setName('page').setDescription('Page number').setMinValue(1)),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a song from the queue')
    .addIntegerOption((opt) =>
      opt.setName('position').setDescription('Position in /queue').setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear the queue, including one saved by /stop (the current song keeps playing)'),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Repeat the current song or the whole queue')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('What to repeat')
        .setRequired(true)
        .addChoices(...LOOP_MODES.map((mode) => ({ name: mode, value: mode }))),
    ),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Show or set the volume')
    .addIntegerOption((opt) => opt.setName('level').setDescription('0–100').setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Jump to a time in the current song')
    .addStringOption((opt) => opt.setName('time').setDescription('e.g. 1:30 or 90').setRequired(true)),
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Save and load playlists')
    .addSubcommand((sub) =>
      sub.setName('save').setDescription('Save the current song and queue as a playlist').addStringOption(playlistNameOption),
    )
    .addSubcommand((sub) =>
      sub.setName('load').setDescription('Add a saved playlist to the queue').addStringOption(playlistNameOption),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List saved playlists'))
    .addSubcommand((sub) =>
      sub.setName('show').setDescription('Show the songs in a saved playlist').addStringOption(playlistNameOption),
    )
    .addSubcommand((sub) =>
      sub.setName('delete').setDescription('Delete a saved playlist').addStringOption(playlistNameOption),
    ),
  new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Keep playing related songs when the queue runs out')
    .addBooleanOption((opt) => opt.setName('enabled').setDescription('On or off').setRequired(true)),
  new SlashCommandBuilder()
    .setName('sponsorblock')
    .setDescription('Skip non-music sections, sponsors and subscribe reminders (via SponsorBlock)')
    .addBooleanOption((opt) => opt.setName('enabled').setDescription('On or off').setRequired(true)),
  new SlashCommandBuilder()
    .setName('dj')
    .setDescription('Limit playback controls to a DJ role')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Only members with this role can control playback')
        .addRoleOption((opt) => opt.setName('role').setDescription('The DJ role').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('clear').setDescription('Let everyone control playback again')),
  new SlashCommandBuilder().setName('settings').setDescription("Show this server's music settings"),
].map((cmd) => cmd.toJSON());

function replyPrivately(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The voice channel to play in, or an error if the user can't start playback. */
function joinableChannel(interaction) {
  const channel = interaction.member.voice.channel;
  if (!channel) return { error: 'Join a voice channel first.' };
  const botChannel = interaction.guild.members.me.voice.channel;
  if (getPlayer(interaction.guildId) && botChannel && botChannel.id !== channel.id) {
    return { error: `I'm already playing in ${botChannel}.` };
  }
  return { channel };
}

/**
 * Whether the user may use DJ controls: always when no DJ role is set; otherwise if they
 * have the role, have Manage Server, or are the only one listening.
 */
function isDJ(interaction) {
  const { djRoleId } = settings.get(interaction.guildId);
  if (!djRoleId) return true;
  if (interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (interaction.member.roles.cache.has(djRoleId)) return true;
  const channel = getPlayer(interaction.guildId)?.voiceChannel;
  return (
    channel?.id === interaction.member.voice.channelId && channel.members.filter((m) => !m.user.bot).size === 1
  );
}

function replyNotDJ(interaction) {
  const { djRoleId } = settings.get(interaction.guildId);
  return replyPrivately(interaction, `Only members with the <@&${djRoleId}> role can do that.`);
}

/** Songs you requested (and autoplay picks) can be skipped or removed without being a DJ. */
const canSkip = (interaction, track) => !track.requesterId || track.requesterId === interaction.user.id;

/** The guild's player if the user may control it; otherwise replies with why not and returns null. */
function controllablePlayer(interaction, { needsTrack = true, dj = true } = {}) {
  const player = getPlayer(interaction.guildId);
  if (!player || (needsTrack && !player.current)) {
    replyPrivately(interaction, 'Nothing is playing.');
    return null;
  }
  if (interaction.member.voice.channelId !== player.voiceChannel?.id) {
    replyPrivately(interaction, 'Join my voice channel to control playback.');
    return null;
  }
  if (dj && !isDJ(interaction)) {
    replyNotDJ(interaction);
    return null;
  }
  return player;
}

/** Enqueue tracks and report back. The interaction must already be deferred. */
async function queueTracks(interaction, voiceChannel, tracks, { playlistTitle = null, next = false } = {}) {
  for (const track of tracks) {
    track.requestedBy = interaction.user.toString();
    track.requesterId = interaction.user.id;
  }

  const player = getOrCreatePlayer(voiceChannel, interaction.channel);
  let queued;
  try {
    queued = await player.enqueue(tracks, { next });
  } catch (err) {
    console.error('Failed to connect:', err.message);
    player.destroy();
    return interaction.editReply({ content: 'Could not join the voice channel.', components: [] });
  }

  let content;
  if (playlistTitle) {
    content = `📃 Added **${tracks.length}** songs from **${playlistTitle}** ${next ? 'to the front of' : 'to'} the queue`;
  } else if (!queued) {
    content = `🔎 Found **${tracks[0].title}**`;
  } else {
    const where = next ? 'up next' : `position ${player.queue.length}`;
    content = `➕ Queued **${tracks[0].title}** (${formatDuration(tracks[0].duration)}) — ${where}`;
  }
  return interaction.editReply({ content, components: [] });
}

const stopMessage = (text, saved) =>
  saved ? `${text} Saved ${saved} songs: \`/resume\` continues, \`/clear\` discards them.` : text;

/** Rejoin with the queue saved by /stop. */
async function resumeStopped(interaction, session) {
  const { channel, error } = joinableChannel(interaction);
  if (error) return replyPrivately(interaction, error);
  if (!isDJ(interaction)) return replyNotDJ(interaction);

  await interaction.deferReply();
  const player = getOrCreatePlayer(channel, interaction.channel);
  try {
    await player.restore(session);
  } catch (err) {
    console.error('Failed to resume:', err.message);
    player.destroy();
    return interaction.editReply('Could not join the voice channel.');
  }
  sessions.clearStopped(interaction.guildId);
  return interaction.editReply(`▶️ Resumed the saved queue (${1 + session.queue.length} songs)`);
}

async function playQuery(interaction, { next }) {
  const { channel, error } = joinableChannel(interaction);
  if (error) return replyPrivately(interaction, error);
  if (next && !isDJ(interaction)) return replyNotDJ(interaction);

  await interaction.deferReply();
  const query = interaction.options.getString('query', true);

  let result;
  try {
    result = await resolve(query);
  } catch (err) {
    console.error('Search failed:', err.message);
    return interaction.editReply('Search failed, try again.');
  }
  if (!result.tracks.length) return interaction.editReply(`No results for **${query}**.`);
  return queueTracks(interaction, channel, result.tracks, { playlistTitle: result.playlistTitle, next });
}

function canManagePlaylist(interaction, playlist) {
  return (
    playlist.createdBy === interaction.user.id || interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
  );
}

const playlistHandlers = {
  async save(interaction) {
    const name = interaction.options.getString('name', true);
    const player = getPlayer(interaction.guildId);
    const tracks = player?.current ? [player.current, ...player.queue] : [];
    if (!tracks.length) return replyPrivately(interaction, 'Nothing to save. Queue some songs first.');

    const existing = playlists.get(interaction.guildId, name);
    if (existing && !canManagePlaylist(interaction, existing)) {
      return replyPrivately(interaction, `**${existing.name}** belongs to <@${existing.createdBy}>. Pick another name.`);
    }
    playlists.save(interaction.guildId, name, tracks, interaction.user.id);
    return interaction.reply(`💾 ${existing ? 'Updated' : 'Saved'} playlist **${name.trim()}** (${tracks.length} songs)`);
  },

  async load(interaction) {
    const playlist = playlists.get(interaction.guildId, interaction.options.getString('name', true));
    if (!playlist) return replyPrivately(interaction, 'No playlist with that name. See `/playlist list`.');

    const { channel, error } = joinableChannel(interaction);
    if (error) return replyPrivately(interaction, error);
    await interaction.deferReply();
    return queueTracks(interaction, channel, playlist.tracks, { playlistTitle: playlist.name });
  },

  async list(interaction) {
    const all = playlists.list(interaction.guildId);
    if (!all.length) return replyPrivately(interaction, 'No saved playlists yet. Use `/playlist save`.');
    const lines = all
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `• **${p.name}** (${p.tracks.length} songs) by <@${p.createdBy}>`);
    return interaction.reply({ content: `**Saved playlists**\n${lines.join('\n')}`, allowedMentions: { parse: [] } });
  },

  async show(interaction) {
    const playlist = playlists.get(interaction.guildId, interaction.options.getString('name', true));
    if (!playlist) return replyPrivately(interaction, 'No playlist with that name. See `/playlist list`.');
    const lines = playlist.tracks.slice(0, 15).map((t, i) => `${i + 1}. ${t.title} (${formatDuration(t.duration)})`);
    if (playlist.tracks.length > 15) lines.push(`…and ${playlist.tracks.length - 15} more`);
    return interaction.reply(`📃 **${playlist.name}** (${playlist.tracks.length} songs)\n${lines.join('\n')}`);
  },

  async delete(interaction) {
    const playlist = playlists.get(interaction.guildId, interaction.options.getString('name', true));
    if (!playlist) return replyPrivately(interaction, 'No playlist with that name. See `/playlist list`.');
    if (!canManagePlaylist(interaction, playlist)) {
      return replyPrivately(interaction, 'Only the creator or someone with Manage Server can delete this playlist.');
    }
    playlists.remove(interaction.guildId, playlist.name);
    return interaction.reply(`🗑️ Deleted playlist **${playlist.name}**`);
  },
};

const commandHandlers = {
  play: (interaction) => playQuery(interaction, { next: false }),
  playnext: (interaction) => playQuery(interaction, { next: true }),

  async search(interaction) {
    await interaction.deferReply();
    const query = interaction.options.getString('query', true);

    let results;
    try {
      results = await search(query, 5);
    } catch (err) {
      console.error('Search failed:', err.message);
      return interaction.editReply('Search failed, try again.');
    }
    if (!results.length) return interaction.editReply(`No results for **${query}**.`);

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`search:${interaction.user.id}`)
      .setPlaceholder('Pick a song to queue')
      .addOptions(
        results.map((t) => ({
          label: truncate(t.title, 100),
          description: truncate(`${formatDuration(t.duration)} · ${t.channel ?? 'Unknown channel'}`, 100),
          value: t.url,
        })),
      );
    return interaction.editReply({
      content: `🔎 Results for **${query}**:`,
      components: [new ActionRowBuilder().addComponents(menu)],
    });
  },

  async skip(interaction) {
    const current = getPlayer(interaction.guildId)?.current;
    const player = controllablePlayer(interaction, { dj: !current || !canSkip(interaction, current) });
    if (!player) return;
    const title = player.current.title;
    player.skip();
    return interaction.reply(`⏭️ Skipped **${title}**`);
  },

  async stop(interaction) {
    const player = controllablePlayer(interaction, { needsTrack: false });
    if (!player) return;
    const saved = player.destroy({ saveQueue: true });
    return interaction.reply(stopMessage('⏹️ Stopped and left the channel.', saved));
  },

  async pause(interaction) {
    const player = controllablePlayer(interaction);
    if (!player) return;
    if (!player.pause()) return replyPrivately(interaction, 'Already paused.');
    player.refreshNowPlaying();
    return interaction.reply('⏸️ Paused');
  },

  async resume(interaction) {
    if (!getPlayer(interaction.guildId)?.current) {
      const saved = sessions.getStopped(interaction.guildId);
      if (!saved) return replyPrivately(interaction, 'Nothing to resume.');
      return resumeStopped(interaction, saved);
    }
    const player = controllablePlayer(interaction);
    if (!player) return;
    if (!player.resume()) return replyPrivately(interaction, 'Not paused.');
    player.refreshNowPlaying();
    return interaction.reply('▶️ Resumed');
  },

  async nowplaying(interaction) {
    const player = getPlayer(interaction.guildId);
    if (!player?.current) return replyPrivately(interaction, 'Nothing is playing.');
    return interaction.reply({ embeds: [player.nowPlayingEmbed({ progress: true })] });
  },

  async queue(interaction) {
    const player = getPlayer(interaction.guildId);
    if (!player?.current) return replyPrivately(interaction, 'The queue is empty.');

    const pages = Math.max(1, Math.ceil(player.queue.length / QUEUE_PAGE_SIZE));
    const page = Math.min(interaction.options.getInteger('page') ?? 1, pages);
    const start = (page - 1) * QUEUE_PAGE_SIZE;
    const total = player.queue.reduce((sum, t) => sum + (t.duration ?? 0), 0);

    const lines = [`**Now playing:** ${player.current.title} (${formatDuration(player.current.duration)})`];
    if (player.queue.length) {
      lines.push('', `**Up next:** ${player.queue.length} songs, ${formatDuration(total)}`);
      player.queue
        .slice(start, start + QUEUE_PAGE_SIZE)
        .forEach((t, i) => lines.push(`${start + i + 1}. ${t.title} (${formatDuration(t.duration)})`));
    }
    lines.push('', `Page ${page}/${pages} · Loop: ${player.loop}`);
    return interaction.reply(lines.join('\n'));
  },

  async shuffle(interaction) {
    const player = controllablePlayer(interaction);
    if (!player) return;
    if (player.queue.length < 2) return replyPrivately(interaction, 'Need at least 2 songs in the queue to shuffle.');
    player.shuffle();
    return interaction.reply(`🔀 Shuffled ${player.queue.length} songs`);
  },

  async remove(interaction) {
    const player = controllablePlayer(interaction, { dj: false });
    if (!player) return;
    const position = interaction.options.getInteger('position', true);
    if (position > player.queue.length) {
      return replyPrivately(interaction, `The queue only has ${player.queue.length} songs.`);
    }
    if (!canSkip(interaction, player.queue[position - 1]) && !isDJ(interaction)) return replyNotDJ(interaction);
    const removed = player.remove(position - 1);
    return interaction.reply(`🗑️ Removed **${removed.title}**`);
  },

  async clear(interaction) {
    if (!getPlayer(interaction.guildId)?.current) {
      const saved = sessions.getStopped(interaction.guildId);
      if (!saved) return replyPrivately(interaction, 'The queue is already empty.');
      if (!isDJ(interaction)) return replyNotDJ(interaction);
      sessions.clearStopped(interaction.guildId);
      return interaction.reply(`🧹 Discarded the saved queue (${1 + saved.queue.length} songs)`);
    }
    const player = controllablePlayer(interaction);
    if (!player) return;
    const count = player.clear();
    const discarded = sessions.clearStopped(interaction.guildId);
    return interaction.reply(
      `🧹 Cleared ${count} song${count === 1 ? '' : 's'} from the queue${discarded ? ' and discarded the queue saved by `/stop`' : ''}`,
    );
  },

  async loop(interaction) {
    const player = controllablePlayer(interaction);
    if (!player) return;
    player.setLoop(interaction.options.getString('mode', true));
    player.refreshNowPlaying();
    return interaction.reply(`🔁 Loop: **${player.loop}**`);
  },

  async volume(interaction) {
    const level = interaction.options.getInteger('level');
    if (level === null) {
      const player = getPlayer(interaction.guildId);
      return replyPrivately(interaction, `🔊 Volume is ${player?.volume ?? 100}%`);
    }
    const player = controllablePlayer(interaction);
    if (!player) return;
    player.setVolume(level);
    player.refreshNowPlaying();
    return interaction.reply(`🔊 Volume set to ${level}%`);
  },

  async seek(interaction) {
    const player = controllablePlayer(interaction);
    if (!player) return;
    const seconds = parseTime(interaction.options.getString('time', true));
    if (seconds === null) return replyPrivately(interaction, 'Use a time like `1:30` or `90`.');
    const { duration } = player.current;
    if (duration == null) return replyPrivately(interaction, "Can't seek in a live stream.");
    if (seconds >= duration) {
      return replyPrivately(interaction, `That's past the end of the song (${formatDuration(duration)}).`);
    }
    player.seek(seconds);
    player.refreshNowPlaying();
    return interaction.reply(`⏩ Jumped to ${formatDuration(seconds)}`);
  },

  playlist: (interaction) => playlistHandlers[interaction.options.getSubcommand()](interaction),

  autoplay: (interaction) => toggleSetting(interaction, 'autoplay', '📻 Autoplay'),
  sponsorblock: (interaction) => toggleSetting(interaction, 'sponsorblock', '⏩ SponsorBlock'),

  async dj(interaction) {
    if (interaction.options.getSubcommand() === 'clear') {
      settings.set(interaction.guildId, { djRoleId: null });
      return interaction.reply('🎧 DJ role cleared. Everyone can control playback.');
    }
    const role = interaction.options.getRole('role', true);
    settings.set(interaction.guildId, { djRoleId: role.id });
    return interaction.reply({
      content: `🎧 Only members with ${role} (or Manage Server) can now control playback. Anyone can still queue songs and skip their own.`,
      allowedMentions: { parse: [] },
    });
  },

  async settings(interaction) {
    const { autoplay, sponsorblock, djRoleId } = settings.get(interaction.guildId);
    const onOff = (value) => (value ? 'on' : 'off');
    return replyPrivately(
      interaction,
      [
        `📻 Autoplay: **${onOff(autoplay)}**`,
        `⏩ SponsorBlock: **${onOff(sponsorblock)}**`,
        `🎧 DJ role: ${djRoleId ? `<@&${djRoleId}>` : '**none** (everyone can control playback)'}`,
      ].join('\n'),
    );
  },
};

function toggleSetting(interaction, key, label) {
  if (!isDJ(interaction)) return replyNotDJ(interaction);
  const enabled = interaction.options.getBoolean('enabled', true);
  settings.set(interaction.guildId, { [key]: enabled });
  getPlayer(interaction.guildId)?.onSettingsChanged();
  return interaction.reply(`${label} ${enabled ? 'on' : 'off'}`);
}

async function handleCommand(interaction) {
  const handler = commandHandlers[interaction.commandName];
  if (handler) await handler(interaction);
}

/** Buttons on the now-playing message. */
async function handleButton(interaction) {
  const action = interaction.customId.split(':')[1];
  const current = getPlayer(interaction.guildId)?.current;
  const ownSkip = action === 'skip' && current && canSkip(interaction, current);
  const player = controllablePlayer(interaction, { needsTrack: action !== 'stop', dj: !ownSkip });
  if (!player) return;
  const name = interaction.member.displayName;

  switch (action) {
    case 'toggle':
      if (player.paused) player.resume();
      else player.pause();
      return interaction.update({ embeds: [player.nowPlayingEmbed()], components: [player.controls()] });
    case 'loop':
      player.cycleLoop();
      return interaction.update({ embeds: [player.nowPlayingEmbed()], components: [player.controls()] });
    case 'skip': {
      const title = player.current.title;
      await interaction.deferUpdate();
      player.skip();
      return interaction.followUp(`⏭️ **${name}** skipped **${title}**`);
    }
    case 'stop':
      await interaction.deferUpdate();
      return interaction.followUp(stopMessage(`⏹️ **${name}** stopped playback.`, player.destroy({ saveQueue: true })));
    case 'shuffle':
      if (player.queue.length < 2) return replyPrivately(interaction, 'Need at least 2 songs in the queue to shuffle.');
      player.shuffle();
      return interaction.reply(`🔀 **${name}** shuffled ${player.queue.length} songs`);
  }
}

/** The /search result picker. */
async function handleSelect(interaction) {
  const userId = interaction.customId.split(':')[1];
  if (interaction.user.id !== userId) {
    return replyPrivately(interaction, 'Only the person who searched can pick a result.');
  }
  const { channel, error } = joinableChannel(interaction);
  if (error) return replyPrivately(interaction, error);

  await interaction.deferUpdate();
  let result;
  try {
    result = await resolve(interaction.values[0]);
  } catch (err) {
    console.error('Resolve failed:', err.message);
    return interaction.editReply({ content: 'Could not load that video, try again.', components: [] });
  }
  return queueTracks(interaction, channel, result.tracks);
}

/** Suggest saved playlist names. */
async function handleAutocomplete(interaction) {
  const typed = interaction.options.getFocused().toLowerCase();
  const matches = playlists
    .list(interaction.guildId)
    .filter((p) => p.name.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((p) => ({ name: p.name, value: p.name }));
  return interaction.respond(matches);
}

module.exports = { definitions, handleCommand, handleButton, handleSelect, handleAutocomplete };
