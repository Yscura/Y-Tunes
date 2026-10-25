const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'playlists.json');

// { [guildId]: { [lowercase name]: { name, createdBy, updatedAt, tracks: [{ title, url, duration }] } } }
let store = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    // Keep the unreadable file around rather than overwriting it on the next save.
    const backup = `${FILE}.corrupt-${Date.now()}`;
    fs.renameSync(FILE, backup);
    console.error(`Could not read playlists (${err.message}); moved it to ${backup}`);
    return {};
  }
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, FILE);
}

const key = (name) => name.trim().toLowerCase();

function list(guildId) {
  return Object.values(store[guildId] ?? {});
}

/** Returns a copy, so callers can modify the tracks freely. */
function get(guildId, name) {
  const playlist = store[guildId]?.[key(name)];
  return playlist && { ...playlist, tracks: playlist.tracks.map((t) => ({ ...t })) };
}

function save(guildId, name, tracks, userId) {
  store[guildId] ??= {};
  store[guildId][key(name)] = {
    name: name.trim(),
    createdBy: userId,
    updatedAt: new Date().toISOString(),
    tracks: tracks.map(({ title, url, duration }) => ({ title, url, duration })),
  };
  persist();
}

function remove(guildId, name) {
  if (!store[guildId]?.[key(name)]) return false;
  delete store[guildId][key(name)];
  persist();
  return true;
}

module.exports = { list, get, save, remove };
