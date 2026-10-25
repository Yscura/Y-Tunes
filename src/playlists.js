const { jsonFile } = require('./store');

// { [guildId]: { [lowercase name]: { name, createdBy, updatedAt, tracks: [{ title, url, duration }] } } }
const file = jsonFile('playlists.json');

const key = (name) => name.trim().toLowerCase();

function list(guildId) {
  return Object.values(file.data[guildId] ?? {});
}

/** Returns a copy, so callers can modify the tracks freely. */
function get(guildId, name) {
  const playlist = file.data[guildId]?.[key(name)];
  return playlist && { ...playlist, tracks: playlist.tracks.map((t) => ({ ...t })) };
}

function save(guildId, name, tracks, userId) {
  file.data[guildId] ??= {};
  file.data[guildId][key(name)] = {
    name: name.trim(),
    createdBy: userId,
    updatedAt: new Date().toISOString(),
    tracks: tracks.map(({ title, url, duration }) => ({ title, url, duration })),
  };
  file.save();
}

function remove(guildId, name) {
  if (!file.data[guildId]?.[key(name)]) return false;
  delete file.data[guildId][key(name)];
  file.save();
  return true;
}

module.exports = { list, get, save, remove };
