const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

/** Read a small system file (Linux), or null if it doesn't exist here. */
function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\0/g, '').trim();
  } catch {
    return null;
  }
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 3_000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

/** CPU usage in percent, measured over `ms` (os.cpus() only gives totals since boot). */
async function cpuUsage(ms = 500) {
  const totals = () =>
    os.cpus().reduce(
      (sum, cpu) => {
        const times = Object.values(cpu.times);
        sum.busy += times.reduce((a, b) => a + b, 0) - cpu.times.idle;
        sum.all += times.reduce((a, b) => a + b, 0);
        return sum;
      },
      { busy: 0, all: 0 },
    );
  const before = totals();
  await new Promise((resolve) => setTimeout(resolve, ms));
  const after = totals();
  return (100 * (after.busy - before.busy)) / Math.max(1, after.all - before.all);
}

/** Decode `vcgencmd get_throttled` (Raspberry Pi) into readable problems, or null elsewhere. */
async function throttling() {
  const out = await run('vcgencmd', ['get_throttled']);
  if (!out) return null;
  const flags = parseInt(out.split('=')[1], 16);
  const now = [];
  const since = [];
  if (flags & 0x1) now.push('under-voltage');
  if (flags & 0x4) now.push('throttled');
  if (flags & 0x8) now.push('temperature limit');
  if (flags & 0x10000) since.push('under-voltage');
  if (flags & 0x40000) since.push('throttled');
  if (flags & 0x80000) since.push('temperature limit');
  return { now, since };
}

/** Wi-Fi link quality in percent (Linux), or null without Wi-Fi. */
function wifiQuality() {
  const line = readFile('/proc/net/wireless')?.split('\n')[2];
  if (!line) return null;
  const [iface, , quality] = line.trim().split(/\s+/);
  return { iface: iface.replace(':', ''), percent: Math.round((parseFloat(quality) / 70) * 100) };
}

async function diskUsage(dir) {
  try {
    const stats = await fs.promises.statfs(dir);
    return { used: (stats.blocks - stats.bavail) * stats.bsize, total: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}

/** A snapshot of the machine the bot runs on. Fields are null where the platform doesn't provide them. */
async function getSystemStats() {
  const [cpu, throttled, disk] = await Promise.all([cpuUsage(), throttling(), diskUsage(__dirname)]);
  const tempMilli = readFile('/sys/class/thermal/thermal_zone0/temp');
  const freqKhz = readFile('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq');
  return {
    model: readFile('/proc/device-tree/model') ?? `${os.type()} ${os.arch()}`,
    cores: os.cpus().length,
    cpu,
    load: process.platform === 'win32' ? null : os.loadavg(),
    temperature: tempMilli ? Number(tempMilli) / 1000 : null,
    clockMhz: freqKhz ? Number(freqKhz) / 1000 : null,
    throttled,
    memory: { used: os.totalmem() - os.freemem(), total: os.totalmem() },
    disk,
    wifi: wifiQuality(),
    systemUptime: os.uptime(),
    botUptime: process.uptime(),
    botMemory: process.memoryUsage().rss,
  };
}

module.exports = { getSystemStats };
