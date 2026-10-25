const { jsonFile } = require('./store');

// { [guildId]: session } — what each guild was playing, so it can resume after a restart.
const file = jsonFile('sessions.json');
let lastWritten = JSON.stringify(file.data);

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

module.exports = { load, saveAll };
