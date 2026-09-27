import { describe, expect, test } from "bun:test";

import { parseCliphist, previewText } from "../src/features/clipboard";
import { isScreenshotName } from "../src/features/files";
import { layoutPoint } from "../src/features/screen";
import { appOfCommand, record, type History } from "../src/features/stats";
import type { Monitor } from "../src/hypr";

describe("parseCliphist", () => {
  const listing = [
    "4371\t! gh pr comment 1 --body-file <file>",
    "4349\t[[ binary data 123 KiB png 773x828 ]]",
    "4339\t  two   spaced\twords  ",
    "garbage line",
  ].join("\n");

  test("reads text and images, newest first", () => {
    expect(parseCliphist(listing)).toEqual([
      { key: "c4371", kind: "text", preview: "! gh pr comment 1 --body-file <file>" },
      { key: "c4349", kind: "image", preview: "png 773×828" },
      { key: "c4339", kind: "text", preview: "two spaced words" },
    ]);
  });

  test("keeps only the newest six", () => {
    const long = Array.from({ length: 20 }, (_, index) => `${100 - index}\tclip ${index}`).join("\n");
    expect(parseCliphist(long).map((clip) => clip.key)).toEqual(["c100", "c99", "c98", "c97", "c96", "c95"]);
  });
});

describe("previewText", () => {
  test("is one line, trimmed and capped", () => {
    expect(previewText("  hello\n\n  world  ")).toBe("hello world");
    const long = previewText("x".repeat(500));
    expect(long).toHaveLength(140);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("isScreenshotName", () => {
  test("knows the usual tools' names", () => {
    for (const name of ["Screenshot_2026-09-27_14-03-21_1234.png", "screenshot.png", "20260927_14h03m21s_grim.png", "Screen Shot 2026.png"]) {
      expect(isScreenshotName(name)).toBe(true);
    }
    expect(isScreenshotName("holiday.jpg")).toBe(false);
  });
});

const monitor: Monitor = {
  name: "HDMI-A-1",
  x: 1536,
  y: 0,
  width: 1920,
  height: 1080,
  scale: 1,
  transform: 0,
  focused: false,
  activeWorkspace: { id: 3 },
  model: "BenQ GW2255",
  dpmsStatus: true,
};

describe("layoutPoint", () => {
  test("offsets by where the monitor sits in the layout", () => {
    expect(layoutPoint(monitor, 0.5, 0.5)).toEqual({ x: 1536 + 960, y: 540 });
    expect(layoutPoint(monitor, 0, 0)).toEqual({ x: 1536, y: 0 });
  });

  test("uses logical size on a scaled monitor", () => {
    const laptop = { ...monitor, x: 0, width: 1920, height: 1200, scale: 1.25 };
    expect(layoutPoint(laptop, 0.5, 0.5)).toEqual({ x: 768, y: 480 });
  });

  test("swaps width and height on a monitor turned sideways", () => {
    const portrait = { ...monitor, transform: 1 };
    expect(layoutPoint(portrait, 1, 1)).toEqual({ x: 1536 + 1079, y: 1919 });
  });

  test("stays on the monitor at the far edges", () => {
    // 1536 + 1920 would be the next monitor's first pixel.
    expect(layoutPoint(monitor, 1, 1)).toEqual({ x: 1536 + 1919, y: 1079 });
  });
});

describe("appOfCommand", () => {
  test("names an app by the program it runs", () => {
    expect(appOfCommand("/usr/lib64/firefox/firefox\0-contentproc\0-childID\0")).toBe("firefox");
    // Chrome rewrites its argv as one string.
    expect(appOfCommand("/opt/google/chrome/chrome --type=renderer --lang=en")).toBe("chrome");
    expect(appOfCommand("Hyprland\0")).toBe("hyprland");
    expect(appOfCommand("")).toBe("");
  });
});

describe("record", () => {
  const sample = (cpu: number) => ({
    cpu,
    memory: { used: 6000, total: 16000 },
    battery: null,
    temperature: 50,
    disk: { free: 100, total: 300 },
    uptimeMinutes: 5,
  });

  test("keeps the last ten minutes and nothing older", () => {
    const history: History = { cpu: [], memory: [], battery: [], temperature: [], disk: [] };
    for (let cpu = 1; cpu <= 5; cpu += 1) record(history, sample(cpu), 3);
    expect(history.cpu).toEqual([3, 4, 5]);
    expect(history.memory).toEqual([6000, 6000, 6000]);
    // A reading that isn't there is a gap, not a zero.
    expect(history.battery).toEqual([null, null, null]);
  });
});
