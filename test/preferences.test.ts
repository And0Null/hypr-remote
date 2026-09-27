import { describe, expect, test } from "bun:test";

import { DEFAULT_PREFERENCES, parsePreferences } from "../src/preferences";

describe("parsePreferences", () => {
  test("fills in what's missing", () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ hotAt: 80 })).toEqual({ ...DEFAULT_PREFERENCES, hotAt: 80 });
  });

  test("drops what doesn't fit, and keeps the rest", () => {
    expect(parsePreferences({ hotAt: 500, receiveTo: "/etc", openReceived: false, extra: 1 })).toEqual({
      ...DEFAULT_PREFERENCES,
      openReceived: false,
    });
  });
});
