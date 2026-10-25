const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const { createAudioStream, formatDuration, thumbnailFor } = require('./youtube');

const IDLE_TIMEOUT_MS = 3 * 60_000;
const LOOP_MODES = ['off', 'song', 'queue'];

/** One player (connection + queue) per guild. */
const players = new Map();

function progressBar(position, duration) {
  if (duration == null) return '🔴 Live';
  const size = 15;
  const filled = Math.min(size - 1, Math.round((position / duration) * (size - 1)));
  return `${'▬'.repeat(filled)}🔘${'▬'.repeat(size - 1 - filled)}\n${formatDuration(position)} / ${formatDuration(duration)}`;
}

class GuildPlayer {
  constructor(voiceChannel, textChannel) {
    this.guild = voiceChannel.guild;
    this.textChannel = textChannel;
    this.queue = [];
    this.current = null;
    this.audio = null;
    this.resource = null;
    this.offset = 0; // seconds into the track where the current stream started (for /seek)
    this.loop = 'off';
    this.volume = 100;
    this.skipCurrent = false; // true when the current track must not be repeated by loop
    this.nowPlayingMessage = null;
    this.leaveTimer = null;
    this.destroyed = false;

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.connection.subscribe(this.audioPlayer);

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => this.onTrackEnd());
    this.audioPlayer.on('error', (err) => {
      console.error('Audio player error:', err.message);
      this.skipCurrent = true;
      this.textChannel.send(`⚠️ Error playing **${this.current?.title}**, skipping.`).catch(() => {});
    });

    // Recover from brief disconnects (e.g. being moved); otherwise clean up.
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });
  }

  get voiceChannel() {
    return this.guild.members.me?.voice.channel ?? null;
  }

  get paused() {
    return this.audioPlayer.state.status === AudioPlayerStatus.Paused;
  }

  /** Seconds into the current track. */
  get position() {
    return this.offset + (this.resource ? this.resource.playbackDuration / 1000 : 0);
  }

  /** Add tracks to the queue. Returns false if playback started now, true if they were queued behind something. */
  async enqueue(tracks, { next = false } = {}) {
    if (next) this.queue.unshift(...tracks);
    else this.queue.push(...tracks);
    if (this.current) {
      this.checkIdle();
      return true;
    }
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    this.playNext();
    return false;
  }

  onTrackEnd() {
    if (this.destroyed) return;
    const finished = this.current;
    if (finished) {
      if (this.loop === 'song' && !this.skipCurrent) this.queue.unshift(finished);
      else if (this.loop === 'queue') this.queue.push(finished);
    }
    this.playNext();
  }

  playNext() {
    const previous = this.current;
    const track = this.queue.shift();
    this.current = track ?? null;
    this.skipCurrent = false;
    this.checkIdle();

    if (!track) {
      this.stopStream();
      this.clearControls();
      return;
    }
    this.startStream(0);

    // A looping track keeps its existing message instead of posting a new one each time.
    if (track === previous && this.nowPlayingMessage) return;
    this.clearControls();
    this.textChannel
      .send({ embeds: [this.nowPlayingEmbed()], components: [this.controls()] })
      .then((message) => {
        if (this.current === track) this.nowPlayingMessage = message;
        else message.edit({ components: [] }).catch(() => {});
      })
      .catch(() => {});
  }

  startStream(offset) {
    this.stopStream();
    this.audio = createAudioStream(this.current.url, offset);
    this.offset = offset;
    this.resource = createAudioResource(this.audio.stream, { inputType: StreamType.Raw, inlineVolume: true });
    this.resource.volume.setVolumeLogarithmic(this.volume / 100);
    this.audioPlayer.play(this.resource);
  }

  stopStream() {
    this.audio?.kill();
    this.audio = null;
    this.resource = null;
  }

  skip() {
    this.skipCurrent = true;
    // Stopping triggers Idle, which plays the next track.
    return this.audioPlayer.stop(true);
  }

  pause() {
    return this.audioPlayer.pause();
  }

  resume() {
    return this.audioPlayer.unpause();
  }

  seek(seconds) {
    this.startStream(seconds);
  }

  setVolume(volume) {
    this.volume = volume;
    this.resource?.volume?.setVolumeLogarithmic(volume / 100);
  }

  setLoop(mode) {
    this.loop = mode;
  }

  cycleLoop() {
    this.loop = LOOP_MODES[(LOOP_MODES.indexOf(this.loop) + 1) % LOOP_MODES.length];
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  /** Remove the track at a 0-based queue index and return it. */
  remove(index) {
    return this.queue.splice(index, 1)[0];
  }

  clear() {
    const count = this.queue.length;
    this.queue = [];
    return count;
  }

  nowPlayingEmbed({ progress = false } = {}) {
    const track = this.current;
    const footer = [`Loop: ${this.loop}`, `Volume: ${this.volume}%`];
    if (this.paused) footer.push('Paused');
    return new EmbedBuilder()
      .setColor(0xff0000)
      .setAuthor({ name: 'Now playing' })
      .setTitle(track.title)
      .setURL(track.url)
      .setThumbnail(thumbnailFor(track.url))
      .setDescription(
        [
          progress ? progressBar(this.position, track.duration) : `Duration: ${formatDuration(track.duration)}`,
          `Requested by ${track.requestedBy}`,
        ].join('\n'),
      )
      .setFooter({ text: footer.join(' · ') });
  }

  controls() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('player:toggle')
        .setEmoji(this.paused ? '▶️' : '⏸️')
        .setLabel(this.paused ? 'Resume' : 'Pause')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('player:skip').setEmoji('⏭️').setLabel('Skip').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('player:stop').setEmoji('⏹️').setLabel('Stop').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('player:shuffle').setEmoji('🔀').setLabel('Shuffle').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('player:loop')
        .setEmoji(this.loop === 'song' ? '🔂' : '🔁')
        .setLabel(`Loop: ${this.loop}`)
        .setStyle(this.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Primary),
    );
  }

  /** Re-render the now-playing message after state changed outside of its buttons. */
  refreshNowPlaying() {
    if (!this.current) return;
    this.nowPlayingMessage?.edit({ embeds: [this.nowPlayingEmbed()], components: [this.controls()] }).catch(() => {});
  }

  clearControls() {
    this.nowPlayingMessage?.edit({ components: [] }).catch(() => {});
    this.nowPlayingMessage = null;
  }

  /** Leave after a while if nothing is playing or nobody is listening. */
  checkIdle() {
    if (this.destroyed) return;
    const listeners = this.voiceChannel?.members.filter((m) => !m.user.bot).size ?? 0;
    if (this.current && listeners > 0) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
      return;
    }
    if (this.leaveTimer) return;
    this.leaveTimer = setTimeout(() => {
      this.textChannel.send('👋 Left the voice channel due to inactivity.').catch(() => {});
      this.destroy();
    }, IDLE_TIMEOUT_MS);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.leaveTimer);
    this.queue = [];
    this.current = null;
    this.stopStream();
    this.clearControls();
    this.audioPlayer.stop(true);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    players.delete(this.guild.id);
  }
}

function getPlayer(guildId) {
  return players.get(guildId);
}

function getOrCreatePlayer(voiceChannel, textChannel) {
  let player = players.get(voiceChannel.guild.id);
  if (!player) {
    player = new GuildPlayer(voiceChannel, textChannel);
    players.set(voiceChannel.guild.id, player);
  }
  player.textChannel = textChannel;
  return player;
}

module.exports = { LOOP_MODES, getPlayer, getOrCreatePlayer };
