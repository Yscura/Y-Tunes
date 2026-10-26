const { execFileSync, spawn } = require('child_process');
const { PassThrough } = require('stream');
const { YTDLP_PATH, youtubedl, warmUp, extract } = require('./ytdlp');

/** Full path of a program on PATH (Linux/macOS), or null. */
function findOnPath(name) {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

// The bundled ffmpeg works everywhere except for one thing: ffmpeg-static's Linux build can't
// resolve hostnames, so it can't download. The system ffmpeg is used instead when installed.
const systemFfmpeg = process.env.FFMPEG_PATH || findOnPath('ffmpeg');
const FFMPEG_PATH = systemFfmpeg || require('ffmpeg-static');
const FFMPEG_CAN_DOWNLOAD = process.platform !== 'linux' || Boolean(systemFfmpeg);

const MAX_PLAYLIST_TRACKS = 200;
const STREAM_FORMAT = 'bestaudio/best';
const PCM_OUTPUT = ['-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];
// Compressed audio is ~16 KB/s, so this holds minutes of it to ride out network hiccups.
const DOWNLOAD_BUFFER_BYTES = 8 * 1024 * 1024;
// Decoded audio is 192 KB/s, so this keeps ~20 s decoded ahead of playback.
const PCM_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_STREAMS = 100;

function toTrack(entry) {
  return {
    title: entry.title,
    url: entry.webpage_url || entry.url,
    duration: entry.duration,
  };
}

/**
 * Resolve a query into tracks. Search terms give the first YouTube result;
 * a video URL gives that video; a playlist URL gives every playable video in it.
 * Returns { tracks, playlistTitle } where playlistTitle is null for single videos.
 */
async function resolve(query) {
  const url = /^https?:\/\//i.test(query) ? new URL(query) : null;
  const isPlaylist = Boolean(url?.searchParams.has('list'));

  // A single video needs a full lookup anyway, so do the one playback uses and cache it.
  if (url && !isPlaylist && FFMPEG_CAN_DOWNLOAD) {
    return { tracks: [toTrack(await getStreamInfo(query))], playlistTitle: null };
  }

  const result = await extract(url ? query : `ytsearch1:${query}`, { flat: true, noPlaylist: !isPlaylist });

  if (!result.entries) return { tracks: [toTrack(result)], playlistTitle: null };
  if (!isPlaylist) {
    const first = result.entries[0];
    return { tracks: first ? [toTrack(first)] : [], playlistTitle: null };
  }

  // Private/deleted videos show up with no title.
  let entries = result.entries.filter((e) => e.title);
  // For watch?v=X&list=Y links, start from the linked video.
  const startIndex = entries.findIndex((e) => e.id === url.searchParams.get('v'));
  if (startIndex > 0) entries = entries.slice(startIndex);

  return {
    tracks: entries.slice(0, MAX_PLAYLIST_TRACKS).map(toTrack),
    playlistTitle: result.title,
  };
}

/** Tracks from YouTube's auto-generated "Mix" for a video, starting with that video. */
async function relatedTracks(videoId, limit = 25) {
  const result = await extract(`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`, {
    flat: true,
    playlistEnd: limit,
  });
  return (result.entries ?? []).filter((e) => e.title).map(toTrack);
}

/** Search YouTube and return up to `limit` results, each with its channel name. */
async function search(query, limit = 5) {
  const result = await extract(`ytsearch${limit}:${query}`, { flat: true });
  return result.entries
    .filter((e) => e.title)
    .map((e) => ({ ...toTrack(e), channel: e.channel || e.uploader }));
}

// --- Streaming ---

// videoId -> { promise, expiresAt } of the lookup that gives a video's direct audio URL.
const streamInfoCache = new Map();

function expiryOf(info) {
  try {
    const expire = Number(new URL(info.url).searchParams.get('expire'));
    if (expire) return expire * 1000 - 10 * 60_000; // leave a margin before YouTube's expiry
  } catch {}
  return Date.now() + 30 * 60_000;
}

/** yt-dlp's info for a video's audio stream, including its direct URL. Cached until the URL expires. */
function getStreamInfo(url, { fresh = false } = {}) {
  const key = videoIdOf(url) ?? url;
  const cached = streamInfoCache.get(key);
  if (!fresh && cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) return cached.promise;

  const entry = { expiresAt: null };
  entry.promise = extract(url, { noPlaylist: true, format: STREAM_FORMAT }).then((info) => {
    if (!info.url) throw new Error('yt-dlp found no audio stream');
    entry.expiresAt = expiryOf(info);
    return info;
  });
  entry.promise.catch(() => {
    if (streamInfoCache.get(key) === entry) streamInfoCache.delete(key);
  });
  streamInfoCache.delete(key);
  streamInfoCache.set(key, entry);
  if (streamInfoCache.size > MAX_CACHED_STREAMS) streamInfoCache.delete(streamInfoCache.keys().next().value);
  return entry.promise;
}

/** Look up a video's stream ahead of time, so it starts right away when its turn comes. */
function prefetchStream(url) {
  if (FFMPEG_CAN_DOWNLOAD) getStreamInfo(url).catch(() => {});
}

/** The last ~2 KB each tool printed, for explaining failed streams. */
function createLogs() {
  const logs = {};
  const add = (name, text) => {
    logs[name] = `${logs[name] ?? ''}${text}`.slice(-2000);
  };
  return {
    add,
    capture: (name) => (chunk) => add(name, chunk),
    text: () =>
      Object.entries(logs)
        .filter(([, text]) => text.trim())
        .map(([name, text]) => `[${name}] ${text.trim()}`)
        .join('\n'),
  };
}

/**
 * Stream a video's audio as raw 48kHz stereo PCM, starting `offset` seconds in.
 * `fresh` skips the cached lookup (used when retrying a failed stream).
 * Returns { stream, kill, diagnostics }, where diagnostics() explains a failure.
 */
function createAudioStream(url, offset = 0, { fresh = false } = {}) {
  return FFMPEG_CAN_DOWNLOAD ? streamDirect(url, offset, fresh) : streamThroughYtdlp(url, offset);
}

/** Look up the direct audio URL (usually cached), then let ffmpeg download, seek and decode it. */
function streamDirect(url, offset, fresh) {
  const output = new PassThrough({ highWaterMark: PCM_BUFFER_BYTES });
  const logs = createLogs();
  let ffmpeg = null;
  let killed = false;

  getStreamInfo(url, { fresh })
    .then((info) => {
      if (killed) return;
      if (info._warnings?.length) logs.add('yt-dlp', info._warnings.join('\n'));
      const headers = Object.entries(info.http_headers ?? {})
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('');
      ffmpeg = spawn(
        FFMPEG_PATH,
        [
          '-loglevel', 'error',
          '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
          ...(headers ? ['-headers', headers] : []),
          ...(offset > 0 ? ['-ss', String(offset)] : []),
          '-i', info.url,
          '-vn',
          ...PCM_OUTPUT,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      ffmpeg.stderr.on('data', logs.capture('ffmpeg'));
      ffmpeg.on('error', (err) => {
        logs.add('ffmpeg', err.message);
        output.end();
      });
      ffmpeg.stdout.pipe(output);
    })
    .catch((err) => {
      logs.add('yt-dlp', err.message);
      output.end();
    });

  return {
    stream: output,
    kill() {
      killed = true;
      if (ffmpeg) ffmpeg.kill();
      else output.end();
    },
    diagnostics: logs.text,
  };
}

/**
 * Fallback when ffmpeg can't download (bundled ffmpeg on Linux): yt-dlp downloads into ffmpeg,
 * which skips ahead to `offset` itself. Slower to start and to seek.
 */
function streamThroughYtdlp(url, offset) {
  // Warnings stay on here: when a stream fails, they're usually the explanation.
  const ytdlp = youtubedl.exec(
    url,
    { output: '-', format: STREAM_FORMAT, quiet: true, noPlaylist: true },
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  ytdlp.catch(() => {}); // exit code is irrelevant once we stop reading

  const ffmpeg = spawn(
    FFMPEG_PATH,
    ['-loglevel', 'error', ...(offset > 0 ? ['-ss', String(offset)] : []), '-i', 'pipe:0', ...PCM_OUTPUT],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const logs = createLogs();
  ytdlp.stderr.on('data', logs.capture('yt-dlp'));
  ffmpeg.stderr.on('data', logs.capture('ffmpeg'));
  // Let yt-dlp download ahead instead of pausing whenever ffmpeg's small pipe is full.
  const buffer = new PassThrough({ highWaterMark: DOWNLOAD_BUFFER_BYTES });
  ytdlp.stdout.on('error', () => {});
  buffer.on('error', () => {});
  ffmpeg.stdin.on('error', () => {});
  ytdlp.stdout.pipe(buffer).pipe(ffmpeg.stdin);

  return {
    stream: ffmpeg.stdout,
    kill() {
      ytdlp.kill();
      ffmpeg.kill();
    },
    diagnostics: logs.text,
  };
}

/** The video ID from a watch, shorts or youtu.be URL, or null. */
function videoIdOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('v')) return parsed.searchParams.get('v');
    const match = parsed.pathname.match(/^\/(?:shorts\/|embed\/|live\/)?([\w-]{11})$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function thumbnailFor(url) {
  const id = videoIdOf(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

function formatDuration(seconds) {
  if (seconds == null) return 'live';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Parse "90", "1:30" or "1:02:03" into seconds, or null if invalid. */
function parseTime(input) {
  const parts = input.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

module.exports = {
  YTDLP_PATH,
  FFMPEG_PATH,
  FFMPEG_CAN_DOWNLOAD,
  warmUp,
  resolve,
  relatedTracks,
  search,
  getStreamInfo,
  prefetchStream,
  createAudioStream,
  videoIdOf,
  thumbnailFor,
  formatDuration,
  parseTime,
};
