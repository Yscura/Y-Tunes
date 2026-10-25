const crypto = require('crypto');

const API = 'https://sponsor.ajay.app/api/skipSegments';
// Non-music sections of music videos, plus the usual sponsor/subscribe interruptions.
const CATEGORIES = ['music_offtopic', 'sponsor', 'selfpromo', 'interaction'];
const MAX_CACHED = 500;

const pending = new Map(); // videoId -> Promise<segments>
const loaded = new Map(); // videoId -> segments

/**
 * Fetch skippable segments for a video as [{ start, end, category }], sorted by start.
 * Uses the hash-prefix endpoint so SponsorBlock never sees which video we're playing.
 */
async function fetchSegments(videoId) {
  const prefix = crypto.createHash('sha256').update(videoId).digest('hex').slice(0, 4);
  const params = new URLSearchParams({
    categories: JSON.stringify(CATEGORIES),
    actionTypes: JSON.stringify(['skip']),
  });
  const res = await fetch(`${API}/${prefix}?${params}`, { signal: AbortSignal.timeout(5_000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const match = (await res.json()).find((v) => v.videoID === videoId);
  return (match?.segments ?? [])
    .map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category }))
    .sort((a, b) => a.start - b.start);
}

function getSegments(videoId) {
  if (!videoId) return Promise.resolve([]);
  if (loaded.has(videoId)) return Promise.resolve(loaded.get(videoId));
  if (!pending.has(videoId)) {
    const request = fetchSegments(videoId)
      .then((segments) => {
        loaded.set(videoId, segments);
        if (loaded.size > MAX_CACHED) loaded.delete(loaded.keys().next().value);
        return segments;
      })
      .catch((err) => {
        console.error(`SponsorBlock lookup failed for ${videoId}:`, err.message);
        return []; // not cached, so it's retried next time
      })
      .finally(() => pending.delete(videoId));
    pending.set(videoId, request);
  }
  return pending.get(videoId);
}

/** Segments if already fetched, otherwise undefined. */
function peekSegments(videoId) {
  return loaded.get(videoId);
}

module.exports = { getSegments, peekSegments };
