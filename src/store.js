const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

/**
 * A JSON file in data/ held in memory. Mutate `.data` (or assign it) and call `.save()`.
 * Writes are atomic, and an unreadable file is backed up instead of being overwritten.
 */
function jsonFile(name) {
  const file = path.join(DATA_DIR, name);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, backup);
      console.error(`Could not read ${name} (${err.message}); moved it to ${backup}`);
    }
    data = {};
  }

  return {
    get data() {
      return data;
    },
    set data(value) {
      data = value;
    },
    save() {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    },
  };
}

module.exports = { jsonFile };
