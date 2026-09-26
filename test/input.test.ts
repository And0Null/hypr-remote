import { describe, expect, test } from "bun:test";

import { clampToScreens } from "../src/features/input";

// A laptop panel, then an external monitor to its right with a gap between
// them and its top edge lower down.
const laptop = { x: 0, y: 0, width: 1536, height: 960 };
const external = { x: 1600, y: 200, width: 2560, height: 1440 };
const desk = [laptop, external];

describe("clampToScreens", () => {
  test("leaves a point that's on a screen alone", () => {
    expect(clampToScreens(100, 100, desk)).toEqual({ x: 100, y: 100 });
    expect(clampToScreens(3000, 1000, desk)).toEqual({ x: 3000, y: 1000 });
  });

  test("pulls a point in the gap onto the nearer screen", () => {
    expect(clampToScreens(1550, 500, desk)).toEqual({ x: 1535, y: 500 });
    expect(clampToScreens(1590, 500, desk)).toEqual({ x: 1600, y: 500 });
  });

  test("keeps the cursor off the edges of the desk", () => {
    expect(clampToScreens(-40, 300, desk)).toEqual({ x: 0, y: 300 });
    expect(clampToScreens(200, -10, desk)).toEqual({ x: 200, y: 0 });
    expect(clampToScreens(5000, 5000, desk)).toEqual({ x: 4159, y: 1639 });
  });

  test("follows the offset top edge of a monitor", () => {
    // Above the external monitor, far from the laptop: onto its top row.
    expect(clampToScreens(3000, 50, desk)).toEqual({ x: 3000, y: 200 });
    // Below the laptop, but beside the external monitor's span.
    expect(clampToScreens(1500, 1200, desk)).toEqual({ x: 1600, y: 1200 });
  });

  test("passes the point through when no monitors are known", () => {
    expect(clampToScreens(12.5, -7, [])).toEqual({ x: 12.5, y: -7 });
  });
});
