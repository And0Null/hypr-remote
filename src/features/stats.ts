import { readdir } from "node:fs/promises";

export type Stats = {
  cpu: number | null;
  memory: { used: number; total: number } | null;
  battery: { level: number; charging: boolean } | null;
  temperature: number | null;
  uptimeMinutes: number | null;
};

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

async function readCpu(): Promise<number | null> {
  let previous = lastCpu;
  if (!previous || Date.now() - previous.at > 10_000) {
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

export async function readStats(): Promise<Stats> {
  const [cpu, memory, battery, temperature, uptime] = await Promise.all([
    readCpu(),
    readMemory(),
    readBattery(),
    readTemperature(),
    text("/proc/uptime"),
  ]);
  return {
    cpu,
    memory,
    battery,
    temperature,
    uptimeMinutes: uptime ? Math.floor(Number(uptime.split(" ")[0]) / 60) : null,
  };
}
