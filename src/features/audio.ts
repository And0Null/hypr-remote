import { read, run } from "../run";

const SINK = "@DEFAULT_AUDIO_SINK@";

export type Volume = { level: number; muted: boolean };
export type Sink = { name: string; label: string; active: boolean };

/** "Volume: 0.45 [MUTED]" → { level: 45, muted: true } */
export async function readVolume(): Promise<Volume | null> {
  const output = await read(["wpctl", "get-volume", SINK]);
  const match = output?.match(/Volume:\s*([\d.]+)/);
  if (!output || !match?.[1]) return null;
  return { level: Math.round(Number(match[1]) * 100), muted: output.includes("[MUTED]") };
}

export async function changeVolume(by: "up" | "down") {
  // -l 1.0 caps at 100%; wpctl will otherwise happily go to 150%.
  await run(["wpctl", "set-volume", "-l", "1.0", SINK, `5%${by === "up" ? "+" : "-"}`]);
}

export async function setVolume(level: number) {
  await run(["wpctl", "set-volume", "-l", "1.0", SINK, `${level}%`]);
}

export async function toggleMute() {
  await run(["wpctl", "set-mute", SINK, "toggle"]);
}

/**
 * Real outputs only. PipeWire's role-based loopbacks ("Phone Calls", "Alarm
 * Clocks"...) are sinks too, but choosing one sends audio nowhere useful.
 */
export async function readSinks(): Promise<Sink[]> {
  const [list, current] = await Promise.all([
    read(["pactl", "-f", "json", "list", "sinks"]),
    read(["pactl", "get-default-sink"]),
  ]);
  if (!list) return [];
  try {
    return (JSON.parse(list) as { name: string; description: string }[])
      .filter((sink) => !sink.name.startsWith("input.loopback"))
      .map((sink) => ({
        name: sink.name,
        label: sink.description,
        active: sink.name === current,
      }));
  } catch {
    return [];
  }
}

/** Only accepts a sink that exists right now, so the name can't be anything else. */
export async function setSink(name: string) {
  const sinks = await readSinks();
  if (!sinks.some((sink) => sink.name === name)) return;
  await run(["pactl", "set-default-sink", name]);
}
