import { describe, expect, test } from "bun:test";

import { DEFAULT_SCENES, sceneMatches, type Settings } from "../src/scenes";

const now = (settings: Partial<Settings>): Settings => ({
  volume: 50,
  brightness: [{ id: "laptop", level: 80 }],
  dnd: false,
  nightLight: false,
  ...settings,
});

describe("sceneMatches", () => {
  const night = DEFAULT_SCENES.find((scene) => scene.id === "night")!;

  test("lights up when every setting the scene has matches", () => {
    expect(sceneMatches(night, now({ volume: 20, brightness: [{ id: "laptop", level: 15 }], dnd: true, nightLight: 3500 }))).toBe(true);
  });

  test("allows brightnessctl's rounding", () => {
    expect(sceneMatches(night, now({ volume: 20, brightness: [{ id: "laptop", level: 16 }], dnd: true, nightLight: 3500 }))).toBe(true);
  });

  test("goes out when anything differs", () => {
    expect(sceneMatches(night, now({ volume: 21, brightness: [{ id: "laptop", level: 15 }], dnd: true, nightLight: 3500 }))).toBe(false);
    expect(sceneMatches(night, now({ volume: 20, brightness: [{ id: "laptop", level: 15 }], dnd: true, nightLight: false }))).toBe(false);
  });

  test("ignores play and pause", () => {
    const movie = DEFAULT_SCENES.find((scene) => scene.id === "movie")!;
    expect(sceneMatches(movie, now({ volume: 70, brightness: [{ id: "laptop", level: 40 }], dnd: true }))).toBe(true);
  });

  test("never matches a scene that sets nothing comparable", () => {
    expect(sceneMatches({ id: "x", label: "x", media: "play" }, now({}))).toBe(false);
  });
});
