// Checks everything YTunes depends on and times each step, to find out why playback is slow
// or failing on a given machine. Run with: npm run diagnose
const { execFile } = require('child_process');
const os = require('os');
const { generateDependencyReport } = require('@discordjs/voice');
const { constants: ytdlpConstants } = require('youtube-dl-exec');
const { resolve, createAudioStream } = require('../src/youtube');

const PCM_BYTES_PER_SECOND = 48000 * 2 * 2; // 48 kHz, stereo, 16-bit
const STREAM_TEST_SECONDS = 20;
const QUERY = process.argv[2] || 'The 1975 The Sound';

const verdicts = [];
const warn = (text) => verdicts.push(`⚠️  ${text}`);
const section = (title) => console.log(`\n=== ${title} ===`);

function run(file, args) {
  return new Promise((done) => {
    const start = Date.now();
    execFile(file, args, { timeout: 60_000 }, (err, stdout, stderr) =>
      done({ ms: Date.now() - start, out: `${stdout}${stderr}`.trim(), err }),
    );
  });
}

/** Read a stream as fast as it comes for `seconds` and report how much audio arrived. */
function measureStream(url, offset) {
  return new Promise((done) => {
    const start = Date.now();
    const audio = createAudioStream(url, offset);
    let firstByteMs = null;
    let bytes = 0;
    const finish = (reason) => {
      clearTimeout(timer);
      audio.kill();
      const elapsed = (Date.now() - start - (firstByteMs ?? 0)) / 1000;
      done({ firstByteMs, audioSeconds: bytes / PCM_BYTES_PER_SECOND, elapsed, reason, logs: audio.diagnostics() });
    };
    const timer = setTimeout(() => finish('time limit'), (STREAM_TEST_SECONDS + 30) * 1000);
    audio.stream.on('data', (chunk) => {
      if (firstByteMs === null) {
        firstByteMs = Date.now() - start;
        clearTimeout(timer);
        setTimeout(() => finish('time limit'), STREAM_TEST_SECONDS * 1000);
      }
      bytes += chunk.length;
    });
    audio.stream.on('end', () => finish('stream ended'));
  });
}

function reportStream(label, result, durationLeft) {
  if (result.firstByteMs === null) {
    console.log(`${label}: no audio at all within ${STREAM_TEST_SECONDS + 30} s`);
    warn(`${label}: no audio arrived. See the yt-dlp/ffmpeg output above.`);
  } else {
    const speed = result.audioSeconds / result.elapsed;
    console.log(`${label}: first audio after ${(result.firstByteMs / 1000).toFixed(1)} s`);
    console.log(`${label}: ${result.audioSeconds.toFixed(0)} s of audio in ${result.elapsed.toFixed(0)} s = ${speed.toFixed(1)}x real time (${result.reason})`);
    if (result.reason === 'stream ended' && result.audioSeconds < durationLeft - 10) {
      warn(`${label}: the stream ended after ${result.audioSeconds.toFixed(0)} s of audio. That's the "Lost the stream" problem; see the output above.`);
    } else if (speed < 1.5) {
      warn(`${label}: audio arrives at only ${speed.toFixed(1)}x real time; it needs to be well above 1x to play smoothly.`);
    }
    if (result.firstByteMs > 8000) warn(`${label}: songs take ${(result.firstByteMs / 1000).toFixed(0)} s to start.`);
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
  const ytdlpPath = ytdlpConstants.YOUTUBE_DL_PATH;
  const version = await run(ytdlpPath, ['--version']);
  console.log(`${ytdlpPath}`);
  console.log(`version ${version.out || '(failed)'}, startup took ${(version.ms / 1000).toFixed(1)} s`);
  if (version.err) warn(`yt-dlp doesn't run: ${version.err.message}`);
  else if (version.ms > 2000) warn(`yt-dlp takes ${(version.ms / 1000).toFixed(1)} s just to start, and the bot starts it for every search and song.`);
  if (process.platform !== 'win32') {
    const python = await run('python3', ['--version']);
    console.log(`python3: ${python.err ? 'not found' : python.out}`);
    if (python.err) warn('python3 is missing; yt-dlp needs it on Linux.');
  }

  section(`Search: "${QUERY}"`);
  const searchStart = Date.now();
  let track;
  try {
    [track] = (await resolve(QUERY)).tracks;
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }
  const searchMs = Date.now() - searchStart;
  if (!track) {
    warn('Search failed, so the stream tests were skipped.');
  } else {
    console.log(`found "${track.title}" (${track.duration ?? '?'} s) in ${(searchMs / 1000).toFixed(1)} s`);
    if (searchMs > 6000) warn(`Searching takes ${(searchMs / 1000).toFixed(0)} s.`);

    section(`Stream from the start (${STREAM_TEST_SECONDS} s test)`);
    reportStream('start', await measureStream(track.url, 0), track.duration ?? Infinity);

    if ((track.duration ?? 0) > 120) {
      section(`Stream from 1:00, like /seek and retries (${STREAM_TEST_SECONDS} s test)`);
      reportStream('seek', await measureStream(track.url, 60), track.duration - 60);
    }
  }

  section('Load average after the tests');
  console.log(os.loadavg().map((l) => l.toFixed(2)).join(' / '), `(${cpus.length} cores)`);

  section('Summary');
  console.log(verdicts.length ? verdicts.join('\n') : '✅ Everything looks fine.');
  process.exit(0);
})();
