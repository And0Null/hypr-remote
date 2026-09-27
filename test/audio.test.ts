import { describe, expect, test } from "bun:test";

import { parseVolume } from "../src/features/audio";

describe("parseVolume", () => {
  test("reads wpctl's level as a percentage", () => {
    expect(parseVolume("Volume: 0.45")).toEqual({ level: 45, muted: false });
    expect(parseVolume("Volume: 1.00")).toEqual({ level: 100, muted: false });
    expect(parseVolume("Volume: 0.00")).toEqual({ level: 0, muted: false });
  });

  test("notices mute", () => {
    expect(parseVolume("Volume: 0.45 [MUTED]")).toEqual({ level: 45, muted: true });
  });

  test("rounds to whole percent", () => {
    expect(parseVolume("Volume: 0.333")).toEqual({ level: 33, muted: false });
    expect(parseVolume("Volume: 0.456")).toEqual({ level: 46, muted: false });
  });

  test("reports boosted volume as it is", () => {
    expect(parseVolume("Volume: 1.50")?.level).toBe(150);
  });

  test("returns null for anything else", () => {
    expect(parseVolume("")).toBeNull();
    expect(parseVolume("Could not connect to PipeWire")).toBeNull();
    expect(parseVolume("Volume: [MUTED]")).toBeNull();
  });
});

import { buildRoutes, groupApps } from "../src/features/audio";

const port = (type: string, description: string, availability: string, profiles: string[]) => ({
  type,
  description,
  availability,
  profiles,
});

// The shape of this laptop's card: analog and HDMI on one card, as profiles.
const card = (active: string) => ({
  name: "alsa_card.pci",
  active_profile: active,
  properties: { "device.description": "Built-in Audio" },
  profiles: {
    "output:analog-stereo+input:analog-stereo": { available: true },
    "output:hdmi-stereo": { available: true },
    "output:hdmi-stereo+input:analog-stereo": { available: true },
    "output:hdmi-stereo-extra1+input:analog-stereo": { available: false },
  },
  ports: {
    "analog-input-internal-mic": port("Mic", "Internal Microphone", "availability unknown", ["output:analog-stereo+input:analog-stereo"]),
    "analog-output-lineout": port("Line", "Line Out", "not available", ["output:analog-stereo+input:analog-stereo"]),
    "analog-output-speaker": port("Speaker", "Speakers", "availability unknown", ["output:analog-stereo+input:analog-stereo"]),
    "analog-output-headphones": port("Headphones", "Headphones", "availability unknown", ["output:analog-stereo+input:analog-stereo"]),
    "hdmi-output-0": port("HDMI", "HDMI / DisplayPort", "available", ["output:hdmi-stereo", "output:hdmi-stereo+input:analog-stereo"]),
    "hdmi-output-1": port("HDMI", "HDMI / DisplayPort 2", "not available", ["output:hdmi-stereo-extra1+input:analog-stereo"]),
  },
});

const sink = (name: string, device: string | undefined, activePort: string | null, description = name) => {
  const properties: Record<string, string> = device ? { "device.name": device } : {};
  return { name, description, active_port: activePort, properties };
};

describe("buildRoutes", () => {
  const analog = sink("alsa_output.analog", "alsa_card.pci", "analog-output-headphones");
  const loopback = sink("input.loopback.sink.role.alert", undefined, null);

  test("names outputs as a person would, and skips unavailable ones", () => {
    const routes = buildRoutes([card("output:analog-stereo+input:analog-stereo")], [analog, loopback], "alsa_output.analog");
    expect(routes.map(({ output }) => [output.label, output.active])).toEqual([
      ["speakers", false],
      ["headphones", true],
      ["hdmi", false],
    ]);
  });

  test("reaches HDMI through a profile that keeps the microphone", () => {
    const routes = buildRoutes([card("output:analog-stereo+input:analog-stereo")], [analog], "alsa_output.analog");
    expect(routes.find(({ output }) => output.label === "hdmi")?.route).toEqual({
      kind: "port",
      card: "alsa_card.pci",
      port: "hdmi-output-0",
      profile: "output:hdmi-stereo+input:analog-stereo",
    });
    // Speakers are on the active profile: no switch needed.
    expect(routes.find(({ output }) => output.label === "speakers")?.route).toMatchObject({ profile: null });
  });

  test("names Bluetooth devices by their own name", () => {
    const earbuds = {
      name: "bluez_card.61_13",
      active_profile: "a2dp-sink",
      properties: { "device.description": "Airdopes Ace" },
      profiles: { "a2dp-sink": { available: true } },
      ports: { "headphone-output": port("Headphones", "Headphone", "available", ["a2dp-sink"]) },
    };
    const routes = buildRoutes([earbuds], [sink("bluez_output.61_13", "bluez_card.61_13", "headphone-output")], "bluez_output.61_13");
    expect(routes.map(({ output }) => [output.label, output.active])).toEqual([["airdopes ace", true]]);
  });

  test("offers sinks with no card, but not PipeWire's loopbacks", () => {
    const network = sink("tunnel.kitchen", undefined, null, "Kitchen Speaker");
    const routes = buildRoutes([], [network, loopback], "tunnel.kitchen");
    expect(routes.map(({ output }) => output)).toEqual([{ id: "tunnel.kitchen", label: "kitchen speaker", active: true }]);
  });
});

describe("groupApps", () => {
  const input = (app: string | null, percent: string, mute = false, node = "x") => ({
    index: 1,
    mute,
    volume: { "front-left": { value_percent: percent }, "front-right": { value_percent: percent } },
    properties: { ...(app && { "application.name": app }), "node.name": node },
  });

  test("groups an app's streams, by its loudest", () => {
    expect(groupApps([input("Firefox", "40%"), input("Firefox", "80%"), input("spotify", "50%")])).toEqual([
      { name: "firefox", level: 80, muted: false },
      { name: "spotify", level: 50, muted: false },
    ]);
  });

  test("is muted only when every stream is", () => {
    expect(groupApps([input("firefox", "40%", true), input("firefox", "40%", false)])[0]?.muted).toBe(false);
    expect(groupApps([input("firefox", "40%", true)])[0]?.muted).toBe(true);
  });

  test("leaves out loopbacks and nameless streams", () => {
    expect(groupApps([input(null, "100%", false, "output.loopback.sink.role.alert"), input(null, "50%")])).toEqual([]);
  });
});
