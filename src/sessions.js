const { jsonFile } = require('./store');

// { [guildId]: session } — what each guild was playing, so it can resume after a restart.
const file = jsonFile('sessions.json');
let lastWritten = JSON.stringify(file.data);

// { [guildId]: session } — queues kept by /stop (or leaving), until /resume or /clear.
const stoppedFile = jsonFile('stopped.json');

function load() {
  return file.data;
}

/** Replace all sessions, skipping the write if nothing changed. */
function saveAll(sessions) {
  const json = JSON.stringify(sessions);
  if (json === lastWritten) return;
  file.data = sessions;
  file.save();
  lastWritten = json;
}

function getStopped(guildId) {
  return stoppedFile.data[guildId];
}

function saveStopped(guildId, session) {
  stoppedFile.data[guildId] = session;
  stoppedFile.save();
}

function clearStopped(guildId) {
  if (!stoppedFile.data[guildId]) return false;
  delete stoppedFile.data[guildId];
  stoppedFile.save();
  return true;
}

module.exports = { load, saveAll, getStopped, saveStopped, clearStopped };
