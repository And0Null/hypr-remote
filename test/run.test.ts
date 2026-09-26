import { describe, expect, test } from "bun:test";

import { shellQuote } from "../src/run";

describe("shellQuote", () => {
  test("wraps a plain string in single quotes", () => {
    expect(shellQuote("https://example.com")).toBe("'https://example.com'");
    expect(shellQuote("")).toBe("''");
  });

  test("closes, escapes and reopens around a single quote", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  test("survives a real shell unchanged", () => {
    for (const value of [
      "it's",
      "$(echo expanded)",
      "`id`",
      "a; rm -rf ~",
      "$HOME \\ \" '' ' \n",
      "https://example.com/?q=1&r=2#x",
    ]) {
      const result = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shellQuote(value)}`]);
      expect(result.stdout.toString()).toBe(value);
    }
  });
});
