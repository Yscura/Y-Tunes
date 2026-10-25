const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const { streamAudio, formatDuration } = require('./youtube');

/** One player (connection + queue) per guild. */
const players = new Map();

class GuildPlayer {
  constructor(voiceChannel, textChannel) {
    this.guildId = voiceChannel.guild.id;
    this.textChannel = textChannel;
    this.queue = [];
    this.current = null;
    this.process = null;

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

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => this.playNext());
    this.audioPlayer.on('error', (err) => {
      console.error('Audio player error:', err.message);
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

  /** Add tracks to the queue. Returns false if playback started now, true if they were queued behind something. */
  async enqueue(tracks) {
    this.queue.push(...tracks);
    if (!this.current) {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
      this.playNext();
      return false;
    }
    return true;
  }

  playNext() {
    this.killProcess();
    const track = this.queue.shift();
    this.current = track ?? null;
    if (!track) return;

    this.process = streamAudio(track.url);
    this.process.catch(() => {}); // exit code is irrelevant once we stop reading
    const resource = createAudioResource(this.process.stdout);
    this.audioPlayer.play(resource);

    this.textChannel
      .send(`🎶 Now playing: **${track.title}** (${formatDuration(track.duration)}) — requested by ${track.requestedBy}`)
      .catch(() => {});
  }

  skip() {
    // Stopping triggers Idle, which plays the next track.
    return this.audioPlayer.stop(true);
  }

  killProcess() {
    if (this.process && !this.process.killed) this.process.kill();
    this.process = null;
  }

  destroy() {
    this.queue = [];
    this.current = null;
    this.killProcess();
    this.audioPlayer.stop(true);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    players.delete(this.guildId);
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

module.exports = { getPlayer, getOrCreatePlayer };
