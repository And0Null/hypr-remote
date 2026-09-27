import { read, run } from "../run";

const SINK = "@DEFAULT_AUDIO_SINK@";
const SOURCE = "@DEFAULT_AUDIO_SOURCE@";

export type Volume = { level: number; muted: boolean };

export async function readVolume(): Promise<Volume | null> {
  const output = await read(["wpctl", "get-volume", SINK]);
  return output ? parseVolume(output) : null;
}

/** "Volume: 0.45 [MUTED]" → { level: 45, muted: true } */
export function parseVolume(output: string): Volume | null {
  const match = output.match(/Volume:\s*([\d.]+)/);
  if (!match?.[1]) return null;
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

/* -------------------------------------------------------------------------- */
/* Microphone                                                                 */
/* -------------------------------------------------------------------------- */

/** Whether the default microphone is muted, or null when there's none. */
export async function readMicMuted(): Promise<boolean | null> {
  const output = await read(["wpctl", "get-volume", SOURCE]);
  return output ? (parseVolume(output)?.muted ?? null) : null;
}

export async function toggleMic() {
  await run(["wpctl", "set-mute", SOURCE, "toggle"]);
}
