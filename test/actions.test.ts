import { describe, expect, test } from "bun:test";

import { Action } from "../src/actions";

const accepts = (message: unknown) => expect(Action.safeParse(message).success).toBe(true);
const rejects = (message: unknown) => expect(Action.safeParse(message).success).toBe(false);

describe("Action", () => {
  test("accepts every kind of message the phone sends", () => {
    for (const message of [
      { type: "media", command: "play-pause" },
      { type: "volume", command: "mute" },
      { type: "volume-set", level: 0 },
      { type: "volume-set", level: 100 },
      { type: "brightness", command: "up" },
      { type: "brightness-set", level: 5 },
      { type: "workspace", id: 1 },
      { type: "lock" },
      { type: "window", op: "focus", address: "0x55d1c0a3b2e0" },
      { type: "window", op: "close", address: "0x1" },
      { type: "window", op: "fullscreen", address: "0x1" },
      { type: "window", op: "float", address: "0x1" },
      { type: "window", op: "kill", address: "0x1" },
      { type: "media-skip", by: -10 },
      { type: "media-seek", to: 83.5 },
      { type: "window-move", address: "0xabc", workspace: 4 },
      { type: "scene", id: "movie" },
      { type: "sink", name: "alsa_output.pci-0000_00_1f.3.analog-stereo" },
      { type: "notifications", op: "toggle-dnd" },
      { type: "radio", device: "wifi", on: false },
      { type: "clipboard-set", text: "" },
      { type: "clipboard-get" },
      { type: "open-link", url: "https://example.com" },
      { type: "type", text: "hello" },
      { type: "key", key: "page-down" },
      { type: "pointer-move", dx: -12.5, dy: 3 },
      { type: "pointer-click", button: "right" },
      { type: "pointer-scroll", dy: -3 },
    ]) {
      accepts(message);
    }
  });

  test("rejects unknown and malformed messages", () => {
    rejects(null);
    rejects("lock");
    rejects({});
    rejects({ type: "shell", command: "rm -rf ~" });
    rejects({ type: "LOCK" });
    rejects({ type: "media", command: "stop" });
    rejects({ type: "radio", device: "wifi", on: "true" });
    rejects({ type: "window", op: "move", address: "0x1" });
  });

  test("rejects keys outside the fixed table", () => {
    rejects({ type: "key", key: "ctrl+alt+delete" });
    rejects({ type: "key", key: "Return" });
    rejects({ type: "key", key: "toString" });
  });

  test("rejects fields it doesn't know", () => {
    rejects({ type: "lock", command: "anything" });
    rejects({ type: "volume-set", level: 50, extra: true });
  });

  test("rejects window addresses that aren't 0x-hex", () => {
    for (const address of ["", "0x", "55d1c0a3b2e0", "0xABC", "0x12g4", "0x1 ; exec", "0x12345678901234567"]) {
      rejects({ type: "window", op: "focus", address });
    }
  });

  test("keeps levels and deltas in range", () => {
    rejects({ type: "volume-set", level: -1 });
    rejects({ type: "volume-set", level: 101 });
    rejects({ type: "volume-set", level: 50.5 });
    rejects({ type: "brightness-set", level: 4 });
    rejects({ type: "pointer-move", dx: 2001, dy: 0 });
    rejects({ type: "pointer-move", dx: 0, dy: Number.NaN });
    rejects({ type: "pointer-move", dx: Number.POSITIVE_INFINITY, dy: 0 });
    rejects({ type: "pointer-scroll", dy: 21 });
    rejects({ type: "pointer-scroll", dy: 1.5 });
    rejects({ type: "type", text: "" });
    rejects({ type: "scene", id: "x".repeat(25) });
    rejects({ type: "media-skip", by: 2.5 });
    rejects({ type: "media-skip", by: 601 });
    rejects({ type: "media-seek", to: -1 });
    rejects({ type: "media-seek", to: Number.POSITIVE_INFINITY });
    rejects({ type: "media-seek", by: 10 });
  });

  test("accepts workspaces past 10, up to 99", () => {
    accepts({ type: "workspace", id: 11 });
    accepts({ type: "workspace", id: 99 });
    accepts({ type: "window-move", address: "0x1", workspace: 42 });
    for (const id of [0, -1, 100, 2.5, "3"]) {
      rejects({ type: "workspace", id });
      rejects({ type: "window-move", address: "0x1", workspace: id });
    }
  });
});
