const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const youtubedl = require('youtube-dl-exec');

const MAX_PLAYLIST_TRACKS = 200;

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

  const result = await youtubedl(url ? query : `ytsearch1:${query}`, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
    ...(isPlaylist ? {} : { noPlaylist: true }),
  });

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
  const result = await youtubedl(`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
    playlistEnd: limit,
  });
  return (result.entries ?? []).filter((e) => e.title).map(toTrack);
}

/** Search YouTube and return up to `limit` results, each with its channel name. */
async function search(query, limit = 5) {
  const result = await youtubedl(`ytsearch${limit}:${query}`, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
  });
  return result.entries
    .filter((e) => e.title)
    .map((e) => ({ ...toTrack(e), channel: e.channel || e.uploader }));
}

/**
 * Stream a video's audio as raw 48kHz stereo PCM, starting `offset` seconds in.
 * yt-dlp downloads (seeking server-side when offset > 0) and ffmpeg decodes.
 * Returns { stream, kill }.
 */
function createAudioStream(url, offset = 0) {
  const ytdlp = youtubedl.exec(
    url,
    {
      output: '-',
      format: 'bestaudio/best',
      quiet: true,
      noWarnings: true,
      noPlaylist: true,
      ...(offset > 0 ? { downloadSections: `*${offset}-inf`, ffmpegLocation: ffmpegPath } : {}),
    },
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  ytdlp.catch(() => {}); // exit code is irrelevant once we stop reading

  const ffmpeg = spawn(
    ffmpegPath,
    ['-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  ytdlp.stdout.on('error', () => {});
  ffmpeg.stdin.on('error', () => {});
  ytdlp.stdout.pipe(ffmpeg.stdin);

  return {
    stream: ffmpeg.stdout,
    kill() {
      ytdlp.kill();
      ffmpeg.kill();
    },
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
  resolve,
  relatedTracks,
  search,
  createAudioStream,
  videoIdOf,
  thumbnailFor,
  formatDuration,
  parseTime,
};
