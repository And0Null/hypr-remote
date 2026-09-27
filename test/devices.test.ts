import { describe, expect, test } from "bun:test";

import { findDevice, issueDevice } from "../src/devices";

describe("issueDevice", () => {
  test("gives each phone a token only it can use", () => {
    const first = issueDevice([], "Pixel 7", null, 1);
    const second = issueDevice(first.list, "iphone", null, 2);
    expect(second.list).toHaveLength(2);
    expect(first.token.startsWith("d_")).toBe(true);
    expect(findDevice(second.list, first.token)?.name).toBe("Pixel 7");
    expect(findDevice(second.list, second.token)?.name).toBe("iphone");
    // Only a hash is kept.
    expect(JSON.stringify(second.list)).not.toContain(first.token);
  });

  test("replaces the phone's old entry when it pairs again", () => {
    const first = issueDevice([], "Pixel 7", null, 1);
    const again = issueDevice(first.list, "Pixel 7", first.token, 2);
    expect(again.list).toHaveLength(1);
    expect(again.device.id).toBe(first.device.id);
    expect(findDevice(again.list, first.token)).toBeNull();
    expect(findDevice(again.list, again.token)).not.toBeNull();
  });

  test("names a nameless phone", () => {
    expect(issueDevice([], "   ", null).device.name).toBe("phone");
  });
});

describe("findDevice", () => {
  test("ignores pairing codes and unknown tokens", () => {
    const { list } = issueDevice([], "Pixel 7", null);
    expect(findDevice(list, null)).toBeNull();
    expect(findDevice(list, "abc123")).toBeNull();
    expect(findDevice(list, "d_nope")).toBeNull();
  });
});
