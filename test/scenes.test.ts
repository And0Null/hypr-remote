import { describe, expect, test } from "bun:test";

import { DEFAULT_SCENES, MAX_SCENES, sceneId, sceneMatches, withScene, type Settings } from "../src/scenes";

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

describe("sceneId", () => {
  test("makes an id from the name", () => {
    expect(sceneId("Late night!", [])).toBe("late-night");
    expect(sceneId("  Work  mode ", [])).toBe("work-mode");
  });

  test("never repeats one already taken", () => {
    expect(sceneId("movie", ["movie"])).toBe("movie-2");
    expect(sceneId("movie", ["movie", "movie-2"])).toBe("movie-3");
  });

  test("falls back when the name has no letters or digits", () => {
    expect(sceneId("✨✨", [])).toBe("scene");
  });
});

describe("withScene", () => {
  test("adds a new scene at the end", () => {
    const next = withScene(DEFAULT_SCENES, { label: "reading", volume: 20, dnd: true })!;
    expect(next.at(-1)).toEqual({ id: "reading", label: "reading", volume: 20, dnd: true });
    expect(next.length).toBe(DEFAULT_SCENES.length + 1);
  });

  test("replaces the scene the id names, keeping its place and id", () => {
    const next = withScene(DEFAULT_SCENES, { id: "focus", label: "deep focus", volume: 10 })!;
    expect(next[1]).toEqual({ id: "focus", label: "deep focus", volume: 10 });
    expect(next.length).toBe(DEFAULT_SCENES.length);
  });

  test("has no room past the limit", () => {
    const full = Array.from({ length: MAX_SCENES }, (_, n) => ({ id: `s${n}`, label: `s${n}` }));
    expect(withScene(full, { label: "one more" })).toBeNull();
    expect(withScene(full, { id: "s0", label: "renamed" })).not.toBeNull();
  });
});
