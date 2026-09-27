import { describe, expect, test } from "bun:test";

import { judgeForeign, parseDetect, parseVcp } from "../src/features/display";

describe("parseDetect", () => {
  test("matches each display's bus to its Hyprland output", () => {
    const output = [
      "Display 1",
      "   I2C bus:  /dev/i2c-5",
      "   DRM connector:           card1-HDMI-A-1",
      "   Monitor:                 BNQ:BenQ GW2255:S6D05052SL0",
      "",
      "Display 2",
      "   I2C bus:  /dev/i2c-7",
      "   DRM connector:           card1-DP-3",
      "   Monitor:                 DEL:DELL U2419H:ABC",
    ].join("\n");
    expect(parseDetect(output)).toEqual([
      { bus: 5, output: "HDMI-A-1" },
      { bus: 7, output: "DP-3" },
    ]);
  });

  test("skips displays that don't answer DDC", () => {
    expect(parseDetect("Invalid display\n   I2C bus:  /dev/i2c-4\n   EDID synopsis: ...")).toEqual([]);
    expect(parseDetect("No displays found.")).toEqual([]);
  });
});

describe("parseVcp", () => {
  test("reads brightness as a percentage of the monitor's maximum", () => {
    expect(parseVcp("VCP 10 C 80 100")).toBe(80);
    expect(parseVcp("VCP 10 C 25 50")).toBe(50);
  });

  test("returns null for errors", () => {
    expect(parseVcp("VCP 10 ERR")).toBeNull();
    expect(parseVcp("VCP 10 C 10 0")).toBeNull();
  });
});

describe("judgeForeign", () => {
  test("a hyprsunset below its neutral default is warm", () => {
    expect(judgeForeign(4500, 4000)).toEqual({ on: true, temperature: 4500 });
  });

  test("at or above neutral, or silent, it's off and the remembered warmth stays", () => {
    expect(judgeForeign(6000, 3500)).toEqual({ on: false, temperature: 3500 });
    expect(judgeForeign(null, 3500)).toEqual({ on: false, temperature: 3500 });
  });
});
