import { describe, expect, test } from "bun:test";

import { countMako, nextMorning, parseNotify, plainText } from "../src/features/notifications";

describe("parseNotify", () => {
  test("reads Notify's arguments", () => {
    const note = parseNotify(["telegram", 0, "", "Aisha", "<b>hi</b> there", [], {}, -1]);
    expect(note).toMatchObject({ app: "telegram", title: "Aisha", body: "hi there", replaces: 0, entry: "" });
  });

  test("falls back to the desktop entry for a nameless app", () => {
    const hints = { "desktop-entry": { type: "s", data: "org.telegram.desktop" } };
    expect(parseNotify(["", 7, "", "t", "", [], hints, -1])).toMatchObject({
      app: "org.telegram.desktop",
      entry: "org.telegram.desktop",
      replaces: 7,
    });
  });

  test("rejects calls that aren't a notification", () => {
    expect(parseNotify([])).toBeNull();
  });
});

describe("plainText", () => {
  test("drops markup and decodes entities", () => {
    expect(plainText('<a href="x">link</a> &amp; &lt;tag&gt;')).toBe("link & <tag>");
  });

  test("folds whitespace and caps the length", () => {
    expect(plainText("a\n\n  b")).toBe("a b");
    expect(plainText("x".repeat(500))).toHaveLength(300);
  });
});

describe("countMako", () => {
  test("counts mako's text output", () => {
    expect(countMako("Notification 3: hi\n  App name: a\nNotification 2: yo\n")).toBe(2);
  });

  test("counts its older JSON output", () => {
    expect(countMako(JSON.stringify({ type: "aa{sv}", data: [[{}, {}, {}]] }))).toBe(3);
  });
});

describe("nextMorning", () => {
  test("is 07:00 today before seven", () => {
    const morning = nextMorning(new Date(2026, 8, 27, 1, 30));
    expect([morning.getDate(), morning.getHours(), morning.getMinutes()]).toEqual([27, 7, 0]);
  });

  test("is 07:00 tomorrow after seven", () => {
    const morning = nextMorning(new Date(2026, 8, 27, 22, 0));
    expect([morning.getDate(), morning.getHours()]).toEqual([28, 7]);
  });
});
