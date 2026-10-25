const { jsonFile } = require('./store');

const DEFAULTS = { autoplay: false, sponsorblock: true, djRoleId: null };

// { [guildId]: Partial<DEFAULTS> }
const file = jsonFile('settings.json');

function get(guildId) {
  return { ...DEFAULTS, ...file.data[guildId] };
}

function set(guildId, changes) {
  file.data[guildId] = { ...file.data[guildId], ...changes };
  file.save();
}

module.exports = { get, set };
