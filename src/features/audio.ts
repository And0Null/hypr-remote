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

/* -------------------------------------------------------------------------- */
/* Outputs, as a person would name them                                       */
/* -------------------------------------------------------------------------- */

/**
 * One place sound can go: speakers, headphones, hdmi, a Bluetooth device.
 * `id` is opaque to the phone; it's looked up again before anything runs.
 */
export type Output = { id: string; label: string; active: boolean };

type PactlCard = {
  name: string;
  active_profile: string;
  properties: Record<string, string>;
  profiles: Record<string, { available: boolean }>;
  ports: Record<string, { description: string; type: string; availability: string; profiles: string[] }>;
};

type PactlSink = {
  name: string;
  description: string;
  active_port: string | null;
  properties: Record<string, string>;
};

/**
 * How an output is switched to: set a sink's port, first switching its card
 * to a profile that has the port (HDMI usually needs this), or just choose a
 * sink with no ports to pick from.
 */
type Route =
  | { kind: "port"; card: string; port: string; profile: string | null }
  | { kind: "sink"; sink: string };

export async function readOutputs(): Promise<Output[]> {
  return (await readRoutes()).map(({ output }) => output);
}

async function readRoutes(): Promise<{ output: Output; route: Route }[]> {
  const [cards, sinks, current] = await Promise.all([
    read(["pactl", "-f", "json", "list", "cards"]),
    read(["pactl", "-f", "json", "list", "sinks"]),
    read(["pactl", "get-default-sink"]),
  ]);
  try {
    return buildRoutes(JSON.parse(cards ?? "[]"), JSON.parse(sinks ?? "[]"), current ?? "");
  } catch {
    return [];
  }
}

const PORT_NAMES: Record<string, string> = { Speaker: "speakers", Headphones: "headphones", HDMI: "hdmi" };

export function buildRoutes(cards: PactlCard[], sinks: PactlSink[], current: string) {
  const routes: { output: Output; route: Route }[] = [];
  const cardOf = (sink: PactlSink) => sink.properties["device.name"];
  const defaultSink = sinks.find((sink) => sink.name === current);

  for (const card of cards) {
    const bluetooth = card.name.startsWith("bluez_card");
    const cardSink = sinks.find((sink) => cardOf(sink) === card.name);
    // The input half of the active profile ("+input:analog-stereo") is kept
    // when switching, so the microphone survives a move to HDMI.
    const input = card.active_profile.match(/\+?(input:[\w-]+)/)?.[1];
    const seen = new Map<string, number>();

    for (const [port, info] of Object.entries(card.ports)) {
      if (port.includes("input") || info.availability === "not available") continue;
      const profiles = info.profiles.filter((profile) => card.profiles[profile]?.available !== false);
      if (profiles.length === 0) continue;
      const onActive = profiles.includes(card.active_profile);
      const profile = onActive
        ? null
        : (profiles.find((candidate) => input && candidate.endsWith(`+${input}`)) ??
          profiles.find((candidate) => candidate.startsWith("output:") && !candidate.includes("+")) ??
          profiles[0]!);

      // Bluetooth devices go by their own name; the rest by what the port is.
      let label = bluetooth
        ? (card.properties["device.description"] ?? port).toLowerCase()
        : (PORT_NAMES[info.type] ?? info.description.toLowerCase());
      const count = (seen.get(label) ?? 0) + 1;
      seen.set(label, count);
      if (count > 1) label = `${label} ${count}`;

      routes.push({
        output: {
          id: `${card.name}#${port}`,
          label,
          active: onActive && cardSink?.name === defaultSink?.name && cardSink?.active_port === port,
        },
        route: { kind: "port", card: card.name, port, profile },
      });
      // A Bluetooth device has one port worth offering.
      if (bluetooth) break;
    }
  }

  // Sinks with no card behind them (network or virtual outputs), minus
  // PipeWire's role loopbacks, which send sound nowhere useful.
  for (const sink of sinks) {
    if (cardOf(sink) || sink.name.startsWith("input.loopback")) continue;
    routes.push({
      output: { id: sink.name, label: sink.description.toLowerCase(), active: sink.name === current },
      route: { kind: "sink", sink: sink.name },
    });
  }
  return routes;
}

/** Only an output that exists right now, so the id can't be anything else. */
export async function setOutput(id: string) {
  const found = (await readRoutes()).find(({ output }) => output.id === id);
  if (!found) return;
  const { route } = found;
  if (route.kind === "sink") {
    await run(["pactl", "set-default-sink", route.sink]);
    return;
  }
  if (route.profile) await run(["pactl", "set-card-profile", route.card, route.profile]);
  // A new profile brings a new sink; find the one on this card now.
  const sinks = JSON.parse((await read(["pactl", "-f", "json", "list", "sinks"])) ?? "[]") as PactlSink[];
  const sink = sinks.find((candidate) => candidate.properties["device.name"] === route.card);
  if (!sink) return;
  await run(["pactl", "set-sink-port", sink.name, route.port]);
  await run(["pactl", "set-default-sink", sink.name]);
}

/* -------------------------------------------------------------------------- */
/* Per-app volume                                                             */
/* -------------------------------------------------------------------------- */

/** Every stream of one app together: a browser with three tabs is one row. */
export type AppVolume = { name: string; level: number; muted: boolean };

type PactlSinkInput = {
  index: number;
  mute: boolean;
  volume: Record<string, { value_percent: string }>;
  properties: Record<string, string>;
};

export async function readApps(): Promise<AppVolume[]> {
  return groupApps(await readSinkInputs());
}

async function readSinkInputs(): Promise<PactlSinkInput[]> {
  try {
    return JSON.parse((await read(["pactl", "-f", "json", "list", "sink-inputs"])) ?? "[]");
  } catch {
    return [];
  }
}

const appOf = (input: PactlSinkInput) =>
  (input.properties["application.name"] || input.properties["application.process.binary"] || "").toLowerCase();

export function groupApps(inputs: PactlSinkInput[]): AppVolume[] {
  const apps = new Map<string, AppVolume>();
  for (const input of inputs) {
    // Loopbacks and other plumbing have no application behind them.
    const name = appOf(input);
    if (!name || input.properties["node.name"]?.startsWith("output.loopback")) continue;
    const levels = Object.values(input.volume).map((channel) => Number.parseInt(channel.value_percent, 10));
    const level = levels.length ? Math.round(Math.max(...levels)) : 0;
    // The loudest stream stands for the app; it's muted only if all are.
    const app = apps.get(name) ?? { name, level: 0, muted: true };
    app.level = Math.max(app.level, level);
    app.muted &&= input.mute;
    apps.set(name, app);
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Only apps playing right now; every stream of the app moves together. */
export async function setAppVolume(name: string, level: number) {
  const inputs = (await readSinkInputs()).filter((input) => appOf(input) === name);
  await Promise.all(
    inputs.map((input) => run(["pactl", "set-sink-input-volume", String(input.index), `${level}%`])),
  );
}
