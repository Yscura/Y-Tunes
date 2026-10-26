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
const { createAudioStream, relatedTracks, formatDuration, thumbnailFor, videoIdOf } = require('./youtube');
const sponsorblock = require('./sponsorblock');
const settings = require('./settings');
const sessions = require('./sessions');

const IDLE_TIMEOUT_MS = 3 * 60_000;
const SESSION_SAVE_INTERVAL_MS = 5_000;
const LOOP_MODES = ['off', 'song', 'queue'];
const HISTORY_SIZE = 100;
const MAX_AUTOPLAY_SECONDS = 10 * 60; // prefer songs over hour-long mixes
// How long the stream may stall before giving up on it. @discordjs/voice defaults to 5 frames
// (100 ms), which turns any network hiccup into "song over" and skips through the queue.
const MAX_STALL_FRAMES = 50 * 10; // 10 s of 20 ms frames
// A track that stops further than this from its end (and wasn't skipped) failed mid-stream.
const EARLY_END_SECONDS = 10;

/** One player (connection + queue) per guild. */
const players = new Map();

function progressBar(position, duration) {
  if (duration == null) return '🔴 Live';
  const size = 15;
  const filled = Math.min(size - 1, Math.round((position / duration) * (size - 1)));
  return `${'▬'.repeat(filled)}🔘${'▬'.repeat(size - 1 - filled)}\n${formatDuration(position)} / ${formatDuration(duration)}`;
}

const storableTrack = ({ title, url, duration, requestedBy, requesterId }) => ({
  title,
  url,
  duration,
  requestedBy,
  requesterId,
});

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
    this.endedBySegment = false; // true when SponsorBlock cut off the rest of the track
    this.retried = false; // whether the current track already got its one retry after failing
    this.segments = []; // SponsorBlock segments of the current track
    this.history = []; // recently played video IDs, so autoplay doesn't repeat them
    this.autoplayPrefetch = null; // { seedId, promise } of related tracks
    this.nowPlayingMessage = null;
    this.leaveTimer = null;
    this.destroyed = false;
    this.segmentTimer = setInterval(() => this.checkSegments(), 500);

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: MAX_STALL_FRAMES },
    });
    this.connection.subscribe(this.audioPlayer);

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this.onTrackEnd().catch((err) => console.error('Failed to start next track:', err));
    });
    // Followed by Idle, where onTrackEnd retries or skips the track.
    this.audioPlayer.on('error', (err) => console.error(`Audio error on ${this.current?.title}:`, err.message));

    // Recover from brief disconnects (e.g. being moved); otherwise clean up.
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy({ saveQueue: true });
      }
    });
  }

  get settings() {
    return settings.get(this.guild.id);
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
      this.prefetch();
      return true;
    }
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    this.playNext();
    return false;
  }

  async onTrackEnd() {
    if (this.destroyed) return;
    const finished = this.current;
    if (finished && this.endedEarly(finished)) {
      const position = Math.floor(this.position);
      const details = this.audio?.diagnostics();
      console.warn(
        `Stream for ${finished.title} stopped at ${formatDuration(position)}` +
          (details ? `:\n${details}` : ' (no output from yt-dlp or ffmpeg)'),
      );
      if (!this.retried) {
        this.retried = true;
        console.warn('Retrying from the same spot');
        this.startStream(finished.duration == null ? 0 : position);
        return;
      }
      this.skipCurrent = true; // don't loop a track that keeps failing
      this.textChannel
        .send(`⚠️ Lost the stream for **${finished.title}** at ${formatDuration(position)}, skipping.`)
        .catch(() => {});
    }
    if (finished) {
      if (this.loop === 'song' && !this.skipCurrent) this.queue.unshift(finished);
      else if (this.loop === 'queue') this.queue.push(finished);
    }
    if (finished && !this.queue.length && this.settings.autoplay) {
      const related = await this.nextAutoplayTrack(finished);
      if (this.destroyed) return;
      // Something may have been queued while we were looking.
      if (related && !this.queue.length) this.queue.push(related);
    }
    this.playNext();
  }

  /** Play the next queued track. `offset` overrides where it starts (used when resuming). */
  playNext({ offset = null } = {}) {
    const previous = this.current;
    const track = this.queue.shift();
    this.current = track ?? null;
    this.skipCurrent = false;
    this.endedBySegment = false;
    this.retried = false;
    this.segments = [];
    this.checkIdle();

    if (!track) {
      this.stopStream();
      this.clearControls();
      return;
    }

    this.remember(videoIdOf(track.url));
    this.startStream(offset ?? this.introSkip(track));
    this.loadSegments(track);
    this.prefetch();

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

    // Log how long the audio took to start; slow hardware shows up here first.
    const { resource, current } = this;
    const startedAt = Date.now();
    resource.playStream.once('readable', () => {
      if (this.resource === resource) console.log(`Playing ${current.title} (audio ready after ${Date.now() - startedAt} ms)`);
    });
  }

  stopStream() {
    this.audio?.kill();
    this.audio = null;
    this.resource = null;
  }

  /** Whether the track stopped on its own well before its end, i.e. the stream failed. */
  endedEarly(track) {
    if (this.skipCurrent || this.endedBySegment) return false;
    if (track.duration == null) return true; // live streams don't end by themselves
    return this.position < track.duration - EARLY_END_SECONDS;
  }

  remember(videoId) {
    if (!videoId) return;
    this.history.push(videoId);
    if (this.history.length > HISTORY_SIZE) this.history.shift();
  }

  /** Warm caches for what plays next, so transitions don't wait on lookups. */
  prefetch() {
    const { sponsorblock: skipSegments, autoplay } = this.settings;
    if (skipSegments && this.queue[0]) sponsorblock.getSegments(videoIdOf(this.queue[0].url));
    if (autoplay && this.current && !this.queue.length) this.autoplayCandidates(this.current);
  }

  /** Call after the guild's settings change. */
  onSettingsChanged() {
    if (this.current) this.loadSegments(this.current);
    this.prefetch();
    this.refreshNowPlaying();
  }

  // --- SponsorBlock ---

  /** Where to start a track so a non-music intro is skipped, if its segments are already known. */
  introSkip(track) {
    if (!this.settings.sponsorblock) return 0;
    const intro = sponsorblock.peekSegments(videoIdOf(track.url))?.find((s) => s.start < 1);
    return intro && !this.endsTrack(intro, track) ? intro.end : 0;
  }

  endsTrack(segment, track) {
    return track.duration != null && segment.end >= track.duration - 1;
  }

  loadSegments(track) {
    if (!this.settings.sponsorblock) return;
    sponsorblock.getSegments(videoIdOf(track.url)).then((segments) => {
      if (this.current === track) this.segments = segments;
    });
  }

  checkSegments() {
    if (!this.segments.length || this.audioPlayer.state.status !== AudioPlayerStatus.Playing) return;
    if (!this.settings.sponsorblock) return;
    const position = this.position;
    const segment = this.segments.find((s) => position >= s.start && position < s.end - 1);
    if (!segment) return;
    // A segment running to the end means the song is over; treat it like a natural end (loops still apply).
    if (this.endsTrack(segment, this.current)) {
      this.endedBySegment = true;
      this.audioPlayer.stop(true);
    } else {
      this.seek(segment.end);
    }
  }

  // --- Autoplay ---

  autoplayCandidates(seed) {
    const seedId = videoIdOf(seed.url);
    if (this.autoplayPrefetch?.seedId !== seedId) {
      const promise = relatedTracks(seedId).catch((err) => {
        console.error('Autoplay lookup failed:', err.message);
        if (this.autoplayPrefetch?.promise === promise) this.autoplayPrefetch = null;
        return [];
      });
      this.autoplayPrefetch = { seedId, promise };
    }
    return this.autoplayPrefetch.promise;
  }

  async nextAutoplayTrack(seed) {
    const candidates = (await this.autoplayCandidates(seed)).filter((t) => !this.history.includes(videoIdOf(t.url)));
    const pick = candidates.find((t) => t.duration != null && t.duration <= MAX_AUTOPLAY_SECONDS) ?? candidates[0];
    return pick && { ...pick, requestedBy: '📻 Autoplay', requesterId: null };
  }

  // --- Controls ---

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

  // --- Now-playing message ---

  nowPlayingEmbed({ progress = false } = {}) {
    const track = this.current;
    const footer = [`Loop: ${this.loop}`, `Volume: ${this.volume}%`];
    if (this.settings.autoplay) footer.push('Autoplay on');
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

  // --- Lifecycle ---

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
      const saved = this.destroy({ saveQueue: true });
      const hint = saved ? ' Your queue is saved: use `/resume` to continue or `/clear` to discard it.' : '';
      this.textChannel.send(`👋 Left the voice channel due to inactivity.${hint}`).catch(() => {});
    }, IDLE_TIMEOUT_MS);
  }

  toSession() {
    return {
      voiceChannelId: this.voiceChannel?.id ?? null,
      textChannelId: this.textChannel.id,
      nowPlayingMessageId: this.nowPlayingMessage?.id ?? null,
      current: storableTrack(this.current),
      position: Math.floor(this.position),
      queue: this.queue.map(storableTrack),
      loop: this.loop,
      volume: this.volume,
      history: this.history.slice(-50),
    };
  }

  /** Pick up a saved session (from a restart or /stop). `announce` is posted before playback starts. */
  async restore(session, { announce = null } = {}) {
    this.queue = session.queue;
    this.loop = session.loop;
    this.volume = session.volume;
    this.history = session.history ?? [];
    if (session.nowPlayingMessageId) {
      this.textChannel.messages.edit(session.nowPlayingMessageId, { components: [] }).catch(() => {});
    }

    const { current, position } = session;
    const canSeek = current.duration != null && position >= 1;
    const nearEnd = canSeek && position >= current.duration - 5;
    if (!nearEnd || !this.queue.length) this.queue.unshift(current);

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    if (announce) await this.textChannel.send(announce).catch(() => {});
    this.playNext({ offset: canSeek && !nearEnd ? position : null });
  }

  /**
   * Leave the channel. With `saveQueue`, whatever was playing is kept for /resume.
   * Returns the number of songs saved (0 if nothing was).
   */
  destroy({ saveQueue = false } = {}) {
    if (this.destroyed) return 0;
    let saved = 0;
    if (saveQueue && this.current) {
      sessions.saveStopped(this.guild.id, this.toSession());
      saved = 1 + this.queue.length;
    }
    this.destroyed = true;
    clearTimeout(this.leaveTimer);
    clearInterval(this.segmentTimer);
    this.queue = [];
    this.current = null;
    this.stopStream();
    this.clearControls();
    this.audioPlayer.stop(true);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    players.delete(this.guild.id);
    persistSessions();
    return saved;
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

// --- Resume after restart ---

// Off until saved sessions are restored, so the first save can't wipe them.
let trackingSessions = false;

function persistSessions() {
  if (!trackingSessions) return;
  const data = {};
  for (const [guildId, player] of players) {
    if (player.current && player.voiceChannel) data[guildId] = player.toSession();
  }
  try {
    sessions.saveAll(data);
  } catch (err) {
    console.error('Could not save sessions:', err.message);
  }
}

/** Rejoin every channel that was playing before the restart, if anyone is still listening there. */
async function restoreSessions(client) {
  for (const [guildId, session] of Object.entries(sessions.load())) {
    try {
      const voiceChannel = await client.channels.fetch(session.voiceChannelId);
      const textChannel = await client.channels.fetch(session.textChannelId);
      if (!voiceChannel?.isVoiceBased() || !textChannel?.isTextBased()) continue;
      if (!voiceChannel.members.some((m) => !m.user.bot)) continue;
      await getOrCreatePlayer(voiceChannel, textChannel).restore(session, {
        announce: '🔄 I restarted, picking up where we left off.',
      });
      console.log(`Resumed playback in ${voiceChannel.guild.name}`);
    } catch (err) {
      console.error(`Could not resume in guild ${guildId}:`, err.message);
      getPlayer(guildId)?.destroy();
    }
  }
  trackingSessions = true;
  persistSessions();
  setInterval(persistSessions, SESSION_SAVE_INTERVAL_MS).unref();
}

/** Save sessions and stop all audio, without leaving, so the next start resumes. */
function shutdownPlayers() {
  persistSessions();
  for (const player of players.values()) {
    player.destroyed = true; // stop Idle handlers from moving on
    player.stopStream();
  }
}

module.exports = { LOOP_MODES, getPlayer, getOrCreatePlayer, restoreSessions, shutdownPlayers };
