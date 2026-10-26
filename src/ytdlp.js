const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { create: createYoutubeDl, constants: ytdlpConstants } = require('youtube-dl-exec');

// The bundled yt-dlp works everywhere, but a pip/pipx install can be used instead (YTDLP_PATH).
const YTDLP_PATH = process.env.YTDLP_PATH || ytdlpConstants.YOUTUBE_DL_PATH;
const SERVER_SCRIPT = path.join(__dirname, 'ytdlp_server.py');
const REQUEST_TIMEOUT_MS = 60_000;

const youtubedl = createYoutubeDl(YTDLP_PATH);

/**
 * The Python that can run yt-dlp, read from its shebang (the zipapp says python3, a pipx
 * install names its own venv), or null for the Windows .exe, which can't be imported.
 */
function pythonFor(ytdlpPath) {
  if (process.env.YTDLP_PYTHON) return process.env.YTDLP_PYTHON;
  try {
    const fd = fs.openSync(ytdlpPath, 'r');
    const head = Buffer.alloc(200);
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const shebang = head.toString('latin1').split('\n')[0];
    if (!shebang.startsWith('#!')) return null;
    const [interpreter, arg] = shebang.slice(2).trim().split(/\s+/);
    return path.basename(interpreter) === 'env' ? arg : interpreter;
  } catch {
    return null;
  }
}

/**
 * A long-running Python process with yt-dlp loaded, so lookups don't pay yt-dlp's startup
 * (5+ s on a Raspberry Pi). If it can't run, lookups fall back to starting yt-dlp each time.
 */
class Server {
  constructor(python) {
    this.pending = new Map();
    this.nextId = 1;
    this.process = spawn(python, ['-I', '-u', SERVER_SCRIPT, YTDLP_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.process.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });

    this.ready = new Promise((resolve, reject) => {
      this.process.once('error', reject);
      this.process.once('exit', (code) => reject(new Error(`exited with code ${code}: ${this.stderr.trim()}`)));
      readline.createInterface({ input: this.process.stdout }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.ready) return resolve(message.version);
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(Object.assign(new Error(message.error), { warnings: message.warnings }));
        else request.resolve(Object.assign(message.info, { _warnings: message.warnings }));
      });
    });
    this.ready.catch(() => {});

    this.process.on('exit', () => {
      for (const request of this.pending.values()) request.reject(new Error('yt-dlp server stopped'));
      this.pending.clear();
      if (server === this) server = null; // restarted on the next request
    });
    this.process.stdin.on('error', () => {});
  }

  request(url, options) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('yt-dlp server timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ id, url, options })}\n`);
    });
  }
}

let server = null;
let serverDisabled = false;

/** Start the server (if possible) and wait until yt-dlp is loaded. Returns how lookups will run. */
async function warmUp() {
  const python = pythonFor(YTDLP_PATH);
  if (serverDisabled || !python) return 'process';
  try {
    server ??= new Server(python);
    const version = await server.ready;
    return `server (yt-dlp ${version} loaded once, via ${python})`;
  } catch (err) {
    console.warn(`Can't keep yt-dlp loaded (${err.message}); starting it for each lookup instead.`);
    serverDisabled = true;
    server = null;
    return 'process';
  }
}

/**
 * Get yt-dlp's info JSON for a URL or search ("ytsearch5:…").
 * Options: { flat, noPlaylist, playlistEnd, format }.
 */
async function extract(url, { flat = false, noPlaylist = false, playlistEnd, format } = {}) {
  if ((await warmUp()) !== 'process') {
    return server.request(url, {
      ...(flat ? { extract_flat: 'in_playlist' } : {}),
      ...(noPlaylist ? { noplaylist: true } : {}),
      ...(playlistEnd ? { playlistend: playlistEnd } : {}),
      ...(format ? { format } : {}),
    });
  }
  return youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    ...(flat ? { flatPlaylist: true } : {}),
    ...(noPlaylist ? { noPlaylist: true } : {}),
    ...(playlistEnd ? { playlistEnd } : {}),
    ...(format ? { format } : {}),
  });
}

module.exports = { YTDLP_PATH, youtubedl, warmUp, extract };
