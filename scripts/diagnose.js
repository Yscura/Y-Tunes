// Checks everything YTunes depends on and times each step, to find out why playback is slow
// or failing on a given machine. Run with: npm run diagnose [search terms]
require('dotenv').config({ quiet: true });
const { execFile } = require('child_process');
const os = require('os');
const { generateDependencyReport } = require('@discordjs/voice');
const yt = require('../src/youtube');

const PCM_BYTES_PER_SECOND = 48000 * 2 * 2; // 48 kHz, stereo, 16-bit
const STREAM_TEST_SECONDS = 15;
const QUERY = process.argv[2] || 'The 1975 The Sound';

const verdicts = [];
const warn = (text) => verdicts.push(`⚠️  ${text}`);
const section = (title) => console.log(`\n=== ${title} ===`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

function run(file, args) {
  return new Promise((done) => {
    const start = Date.now();
    execFile(file, args, { timeout: 60_000 }, (err, stdout, stderr) =>
      done({ ms: Date.now() - start, out: `${stdout}${stderr}`.trim(), err }),
    );
  });
}

async function timed(fn) {
  const start = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - start };
  } catch (error) {
    return { error, ms: Date.now() - start };
  }
}

/** Read a stream as fast as it comes and report how much audio arrived. */
function measureStream(url, offset) {
  return new Promise((done) => {
    const start = Date.now();
    const audio = yt.createAudioStream(url, offset);
    let firstByteMs = null;
    let bytes = 0;
    const finish = (reason) => {
      clearTimeout(timer);
      audio.kill();
      const elapsed = Math.max(0.1, (Date.now() - start - (firstByteMs ?? 0)) / 1000);
      done({ firstByteMs, audioSeconds: bytes / PCM_BYTES_PER_SECOND, elapsed, reason, logs: audio.diagnostics() });
    };
    let timer = setTimeout(() => finish('time limit'), 60_000);
    audio.stream.on('data', (chunk) => {
      if (firstByteMs === null) {
        firstByteMs = Date.now() - start;
        clearTimeout(timer);
        timer = setTimeout(() => finish('time limit'), STREAM_TEST_SECONDS * 1000);
      }
      bytes += chunk.length;
    });
    audio.stream.on('end', () => finish('stream ended'));
  });
}

function reportStream(label, result, durationLeft, slowMs) {
  if (result.firstByteMs === null) {
    console.log(`${label}: no audio at all within 60 s`);
    warn(`${label}: no audio arrived. See the tool output below it.`);
  } else {
    const speed = result.audioSeconds / result.elapsed;
    console.log(`${label}: first audio after ${seconds(result.firstByteMs)}`);
    console.log(`${label}: ${result.audioSeconds.toFixed(0)} s of audio in ${result.elapsed.toFixed(0)} s = ${speed.toFixed(1)}x real time (${result.reason})`);
    if (result.reason === 'stream ended' && result.audioSeconds < durationLeft - 10) {
      warn(`${label}: the stream ended after ${result.audioSeconds.toFixed(0)} s of audio. That's the "Lost the stream" problem; see the output below it.`);
    } else if (speed < 1.5) {
      warn(`${label}: audio arrives at only ${speed.toFixed(1)}x real time; it needs to be well above 1x to play smoothly.`);
    }
    if (result.firstByteMs > slowMs) warn(`${label}: took ${seconds(result.firstByteMs)} to start.`);
  }
  if (result.logs) console.log(`${label} tool output:\n${result.logs}`);
}

(async () => {
  section('System');
  const cpus = os.cpus();
  console.log(`${os.type()} ${os.release()} ${os.arch()}, Node ${process.version}`);
  console.log(`CPU: ${cpus.length} × ${cpus[0]?.model ?? 'unknown'}`);
  console.log(`RAM: ${(os.freemem() / 1e9).toFixed(1)} GB free of ${(os.totalmem() / 1e9).toFixed(1)} GB`);
  console.log(`Load average (1/5/15 min): ${os.loadavg().map((l) => l.toFixed(2)).join(' / ')}`);
  if (os.arch() === 'arm') warn('32-bit OS. A 64-bit Raspberry Pi OS is recommended.');

  // Raspberry Pi only: a weak power supply or overheating makes the CPU slow down.
  const throttled = await run('vcgencmd', ['get_throttled']);
  if (!throttled.err) {
    const flags = parseInt(throttled.out.split('=')[1], 16);
    console.log(`Raspberry Pi ${throttled.out}`);
    if (flags & 0x1) warn('The Pi is under-voltage right now. Use the official power supply (5.1 V / 2.5 A for a Pi 3B+).');
    else if (flags & 0x10000) warn('The Pi has been under-voltage since boot. Use a better power supply.');
    if (flags & 0x4 || flags & 0x8) warn('The Pi is throttling because it is too hot. Add a heatsink or a fan.');
    else if (flags & 0x40000 || flags & 0x80000) warn('The Pi has throttled since boot (heat or power).');
  }

  section('Voice libraries');
  console.log(generateDependencyReport());

  section('yt-dlp');
  console.log(`${yt.YTDLP_PATH}${process.env.YTDLP_PATH ? ' (from YTDLP_PATH)' : ' (bundled)'}`);
  const version = await run(yt.YTDLP_PATH, ['--version']);
  console.log(`version ${version.out || '(failed)'}, starting it takes ${seconds(version.ms)}`);
  if (version.err) warn(`yt-dlp doesn't run: ${version.err.message}`);
  if (process.platform !== 'win32') {
    const python = await run('python3', ['--version']);
    console.log(`python3: ${python.err ? 'not found' : python.out}`);
    if (python.err) warn('python3 is missing; yt-dlp needs it on Linux.');
  }
  const warm = await timed(() => yt.warmUp());
  console.log(`lookups: ${warm.value} (ready after ${seconds(warm.ms)})`);
  if (warm.value === 'process' && version.ms > 2000) {
    warn(`Every lookup starts yt-dlp, which takes ${seconds(version.ms)} here. Keeping it loaded needs Python and a non-Windows yt-dlp.`);
  }

  section('ffmpeg');
  console.log(`${yt.FFMPEG_PATH}${yt.FFMPEG_PATH.includes('ffmpeg-static') ? ' (bundled)' : ' (system)'}`);
  console.log(`streams: ${yt.FFMPEG_CAN_DOWNLOAD ? 'ffmpeg downloads the audio directly (fast starts and seeks)' : 'yt-dlp downloads into ffmpeg (slower)'}`);
  if (!yt.FFMPEG_CAN_DOWNLOAD) {
    warn("Using the bundled ffmpeg, which can't download on Linux, so songs start slower. Run: sudo apt install ffmpeg");
  }

  section(`Search: "${QUERY}"`);
  const searched = await timed(() => yt.resolve(QUERY));
  const track = searched.value?.tracks[0];
  if (!track) {
    console.log(`failed: ${searched.error?.message ?? 'no results'}`);
    warn('Search failed, so the stream tests were skipped.');
  } else {
    console.log(`found "${track.title}" (${track.duration ?? '?'} s) in ${seconds(searched.ms)}`);
    if (searched.ms > 4000) warn(`Searching takes ${seconds(searched.ms)}.`);
    const durationLeft = track.duration ?? Infinity;

    section('New song (looked up when it starts)');
    reportStream('new', await measureStream(track.url, 0), durationLeft, 6000);

    if (yt.FFMPEG_CAN_DOWNLOAD) {
      section('Next song in the queue (looked up in advance)');
      reportStream('queued', await measureStream(track.url, 0), durationLeft, 2000);
    }

    if ((track.duration ?? 0) > 120) {
      section('Jumping to 1:00 (/seek, skipped intros, retries)');
      reportStream('seek', await measureStream(track.url, 60), track.duration - 60, 4000);
    }
  }

  section('Load average after the tests');
  console.log(os.loadavg().map((l) => l.toFixed(2)).join(' / '), `(${cpus.length} cores)`);

  section('Summary');
  console.log(verdicts.length ? verdicts.join('\n') : '✅ Everything looks fine.');
  process.exit(0);
})();
