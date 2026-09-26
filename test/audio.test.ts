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
