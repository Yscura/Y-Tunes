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

/**
 * Spawn yt-dlp streaming the best audio of a video to stdout.
 * Returns the child process; read audio from `.stdout`.
 */
function streamAudio(url) {
  return youtubedl.exec(
    url,
    {
      output: '-',
      format: 'bestaudio/best',
      quiet: true,
      noWarnings: true,
      noPlaylist: true,
    },
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
}

function formatDuration(seconds) {
  if (!seconds) return 'live';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return h ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

module.exports = { resolve, streamAudio, formatDuration };
