import { describe, expect, test } from "bun:test";

import { tokenMatches } from "../src/pairing";

describe("tokenMatches", () => {
  const token = "c2VjcmV0LXRva2VuLTEyMzQ1";

  test("accepts the exact token", () => {
    expect(tokenMatches(token, token)).toBe(true);
  });

  test("rejects a missing or empty token", () => {
    expect(tokenMatches(null, token)).toBe(false);
    expect(tokenMatches("", token)).toBe(false);
  });

  test("rejects a wrong token of the same length", () => {
    expect(tokenMatches(`${token.slice(0, -1)}X`, token)).toBe(false);
  });

  test("rejects prefixes and extensions", () => {
    expect(tokenMatches(token.slice(0, -1), token)).toBe(false);
    expect(tokenMatches(`${token}a`, token)).toBe(false);
  });

  test("compares bytes, not characters", () => {
    // Same length in UTF-16 code units, different in bytes.
    expect(tokenMatches("é".repeat(4), "abcd")).toBe(false);
  });
});
