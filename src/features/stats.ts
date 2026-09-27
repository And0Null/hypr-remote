import { readdir, readFile, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";

/** Memory and disk in MB. `history` holds the last 10 minutes, oldest first. */
export type Stats = {
  cpu: number | null;
  memory: { used: number; total: number } | null;
  battery: { level: number; charging: boolean } | null;
  temperature: number | null;
  disk: { free: number; total: number } | null;
  uptimeMinutes: number | null;
  history: History;
};

export type History = Record<"cpu" | "memory" | "battery" | "temperature" | "disk", (number | null)[]>;

async function text(path: string): Promise<string | null> {
  try {
    return (await Bun.file(path).text()).trim();
  } catch {
    return null;
  }
}

// CPU use is the busy share of time between two samples, so the previous
// sample is kept between reads. With none, or one too old to mean "now" (no
// phone was connected), two samples are taken a moment apart.
let lastCpu: { idle: number; total: number; at: number } | null = null;

async function sampleCpu() {
  const line = (await text("/proc/stat"))?.split("\n")[0];
  if (!line) return null;
  const fields = line.split(/\s+/).slice(1).map(Number);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  const total = fields.reduce((sum, value) => sum + value, 0);
  return { idle, total, at: Date.now() };
}

// Overlapping reads would each take a sample and leave the next a sliver of
// time to measure (noisy, or null), so they share whichever is in flight.
let cpuRead: Promise<number | null> | null = null;

function readCpu(): Promise<number | null> {
  cpuRead ??= measureCpu().finally(() => (cpuRead = null));
  return cpuRead;
}

async function measureCpu(): Promise<number | null> {
  let previous = lastCpu;
  if (!previous || Date.now() - previous.at > 15_000) {
    previous = await sampleCpu();
    await Bun.sleep(250);
  }
  const current = await sampleCpu();
  lastCpu = current;
  if (!previous || !current || current.total === previous.total) return null;
  const { idle, total } = current;
  return Math.round((1 - (idle - previous.idle) / (total - previous.total)) * 100);
}

async function readMemory(): Promise<Stats["memory"]> {
  const info = await text("/proc/meminfo");
  if (!info) return null;
  const value = (key: string) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
  const total = value("MemTotal");
  // Available, not Free: Linux fills spare RAM with cache it will hand back.
  const used = total - value("MemAvailable");
  return { used: Math.round(used / 1024), total: Math.round(total / 1024) };
}

async function readBattery(): Promise<Stats["battery"]> {
  const supplies = await readdir("/sys/class/power_supply").catch(() => []);
  const battery = supplies.find((name) => name.startsWith("BAT"));
  if (!battery) return null;
  const [capacity, status] = await Promise.all([
    text(`/sys/class/power_supply/${battery}/capacity`),
    text(`/sys/class/power_supply/${battery}/status`),
  ]);
  if (capacity === null) return null;
  return { level: Number(capacity), charging: status === "Charging" || status === "Full" };
}

/** The CPU package sensor when there is one, otherwise the hottest zone. */
async function readTemperature(): Promise<number | null> {
  const zones = (await readdir("/sys/class/thermal").catch(() => [])).filter((name) =>
    name.startsWith("thermal_zone"),
  );
  const readings = await Promise.all(
    zones.map(async (zone) => ({
      type: await text(`/sys/class/thermal/${zone}/type`),
      temp: Number(await text(`/sys/class/thermal/${zone}/temp`)) / 1000,
    })),
  );
  const valid = readings.filter((reading) => reading.temp > 0 && reading.temp < 130);
  const cpu = valid.find((reading) => reading.type === "x86_pkg_temp");
  if (cpu) return Math.round(cpu.temp);
  return valid.length ? Math.round(Math.max(...valid.map((reading) => reading.temp))) : null;
}

/** Free space on the drive holding the home folder. */
async function readDisk(): Promise<Stats["disk"]> {
  try {
    const info = await statfs(homedir());
    const mb = (blocks: number) => Math.round((blocks * info.bsize) / 1024 / 1024);
    return { free: mb(info.bavail), total: mb(info.blocks) };
  } catch {
    return null;
  }
}

async function sampleStats(): Promise<Omit<Stats, "history">> {
  const [cpu, memory, battery, temperature, disk, uptime] = await Promise.all([
    readCpu(),
    readMemory(),
    readBattery(),
    readTemperature(),
    readDisk(),
    text("/proc/uptime"),
  ]);
  return {
    cpu,
    memory,
    battery,
    temperature,
    disk,
    uptimeMinutes: uptime ? Math.floor(Number(uptime.split(" ")[0]) / 60) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* The last ten minutes                                                       */
/* -------------------------------------------------------------------------- */

const SAMPLE_EVERY = 10_000;
const KEEP = 60;

let latest: Omit<Stats, "history"> | null = null;
const history: History = { cpu: [], memory: [], battery: [], temperature: [], disk: [] };

/** Adds a sample to the history, dropping what's older than ten minutes. */
export function record(into: History, sample: Omit<Stats, "history">, keep = KEEP) {
  const values: Record<keyof History, number | null> = {
    cpu: sample.cpu,
    memory: sample.memory?.used ?? null,
    battery: sample.battery?.level ?? null,
    temperature: sample.temperature,
    disk: sample.disk?.free ?? null,
  };
  for (const key of Object.keys(values) as (keyof History)[]) {
    into[key].push(values[key]);
    if (into[key].length > keep) into[key].shift();
  }
}

/**
 * Samples every ten seconds whether or not a phone is connected, so the
 * history is there when one opens it. It's a few small file reads. `onHot`
 * fires once when the laptop reaches `hotAt()` (null while the alert is off),
 * and again only after it has cooled 10°C below that.
 */
export function startStatsSampler(hotAt: () => number | null, onHot: (temperature: number) => void) {
  let armed = true;
  const tick = async () => {
    latest = await sampleStats();
    record(history, latest);
    const temperature = latest.temperature;
    const hot = hotAt();
    if (temperature === null || hot === null) return;
    if (armed && temperature >= hot) {
      armed = false;
      onHot(temperature);
    } else if (temperature < hot - 10) armed = true;
  };
  void tick();
  setInterval(() => void tick(), SAMPLE_EVERY);
}

export async function readStats(): Promise<Stats> {
  latest ??= await sampleStats();
  return { ...latest, history };
}

/* -------------------------------------------------------------------------- */
/* Top apps                                                                   */
/* -------------------------------------------------------------------------- */

/** CPU in percent of the whole machine (as the cpu figure is), memory in MB. */
export type TopApp = { name: string; value: number };

type Process = { pid: number; app: string; ticks: number; rss: number; uid: number };

const PAGE_KB = 4;
let lastProcesses: { at: number; total: number; ticks: Map<number, number> } | null = null;

/**
 * An app by the program it runs: every Firefox process is "firefox", however
 * it renames its threads. Chrome-style programs rewrite their argv as one
 * string, hence the split on spaces too.
 */
export function appOfCommand(cmdline: string): string {
  const program = cmdline.split("\0")[0]?.split(" ")[0] ?? "";
  return basename(program).toLowerCase();
}

async function readProcesses(): Promise<Process[]> {
  const pids = (await readdir("/proc").catch(() => [])).filter((name) => /^\d+$/.test(name));
  const processes = await Promise.all(
    pids.map(async (pid): Promise<Process | null> => {
      try {
        const [cmdline, statLine, info] = await Promise.all([
          readFile(`/proc/${pid}/cmdline`, "utf8"),
          readFile(`/proc/${pid}/stat`, "utf8"),
          stat(`/proc/${pid}`),
        ]);
        // Kernel threads have no command line.
        const app = appOfCommand(cmdline);
        if (!app) return null;
        // Fields after the name, which is in parentheses and may hold spaces.
        const fields = statLine.slice(statLine.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(fields[11]) + Number(fields[12]);
        const rss = Number(fields[21]) * PAGE_KB;
        return { pid: Number(pid), app, ticks, rss, uid: info.uid };
      } catch {
        // Exited while being read.
        return null;
      }
    }),
  );
  return processes.filter((proc) => proc !== null);
}

async function totalTicks() {
  const line = (await text("/proc/stat"))?.split("\n")[0] ?? "";
  return line.split(/\s+/).slice(1).map(Number).reduce((sum, value) => sum + value, 0);
}

/** The five busiest apps by CPU since the last call, and the five largest by memory. */
export async function readTopApps(): Promise<{ cpu: TopApp[]; memory: TopApp[] }> {
  // With no recent sample to compare against, take one and wait a moment.
  if (!lastProcesses || Date.now() - lastProcesses.at > 15_000) {
    const first = await readProcesses();
    lastProcesses = { at: Date.now(), total: await totalTicks(), ticks: new Map(first.map((p) => [p.pid, p.ticks])) };
    await Bun.sleep(400);
  }
  const processes = await readProcesses();
  const total = await totalTicks();
  const elapsed = total - lastProcesses.total;

  const cpu = new Map<string, number>();
  const memory = new Map<string, number>();
  for (const proc of processes) {
    const before = lastProcesses.ticks.get(proc.pid);
    // /proc/stat counts every core; a process's ticks count on one scale.
    if (before !== undefined && elapsed > 0) {
      cpu.set(proc.app, (cpu.get(proc.app) ?? 0) + ((proc.ticks - before) / elapsed) * 100);
    }
    memory.set(proc.app, (memory.get(proc.app) ?? 0) + proc.rss / 1024);
  }
  lastProcesses = { at: Date.now(), total, ticks: new Map(processes.map((p) => [p.pid, p.ticks])) };

  const top = (values: Map<string, number>, digits: number) =>
    [...values]
      .map(([name, value]) => ({ name, value: Number(value.toFixed(digits)) }))
      .filter((app) => app.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  return { cpu: top(cpu, 1), memory: top(memory, 0) };
}

// Quitting these ends the session, or the remote itself.
const PROTECTED = new Set(["hyprland", "systemd", "dbus-broker", "dbus-daemon", "pipewire", "wireplumber", "sddm", "gdm"]);

/**
 * Asks every process of an app to quit (SIGTERM, which apps can handle to
 * save their work). Only processes of this user, never the remote itself.
 */
export async function quitApp(name: string): Promise<number> {
  if (PROTECTED.has(name)) return 0;
  const uid = process.getuid?.();
  const mine = (await readProcesses()).filter(
    (candidate) => candidate.app === name && candidate.uid === uid && candidate.pid !== process.pid,
  );
  let quit = 0;
  for (const target of mine) {
    try {
      process.kill(target.pid, "SIGTERM");
      quit += 1;
    } catch {
      // Already gone.
    }
  }
  return quit;
}
