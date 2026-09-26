import { describe, expect, test } from "bun:test";

import { toSnapshot } from "../src/features/desktop";
import type { Client, Monitor } from "../src/hypr";

const client = (address: string, workspace: number, focusHistoryID: number, title = address): Client => ({
  address,
  title,
  class: "kitty",
  workspace: { id: workspace, name: String(workspace) },
  monitor: 0,
  focusHistoryID,
  fullscreen: 0,
  floating: false,
});

const monitor: Monitor = {
  name: "eDP-1",
  x: 0,
  y: 0,
  width: 1920,
  height: 1200,
  scale: 1.25,
  focused: true,
  activeWorkspace: { id: 2 },
};

describe("toSnapshot", () => {
  test("maps Hyprland's replies to what the phone shows", () => {
    const snapshot = toSnapshot(
      [
        { id: 12, name: "12", windows: 0, monitor: "eDP-1" },
        { id: 2, name: "web", windows: 1, monitor: "eDP-1" },
        { id: 1, name: "1", windows: 2, monitor: "eDP-1" },
      ],
      { id: 2 },
      [client("0x3", 2, 0, "browser"), client("0x2", 1, 2), client("0x1", 1, 1)],
      [monitor],
    );

    expect(snapshot).toEqual({
      workspaces: [
        { id: 1, name: "1", windows: 2, monitor: "eDP-1" },
        { id: 2, name: "web", windows: 1, monitor: "eDP-1" },
        { id: 12, name: "12", windows: 0, monitor: "eDP-1" },
      ],
      activeWorkspace: 2,
      activeWindow: "browser",
      windows: [
        { address: "0x1", title: "0x1", app: "kitty", workspace: 1, focused: false },
        { address: "0x2", title: "0x2", app: "kitty", workspace: 1, focused: false },
        { address: "0x3", title: "browser", app: "kitty", workspace: 2, focused: true },
      ],
      monitors: [{ name: "eDP-1", focused: true, workspace: 2 }],
    });
  });

  test("keeps only the workspace fields the phone uses", () => {
    const raw = { id: 3, name: "3", windows: 0, monitor: "DP-1", lastwindowtitle: "secret" };
    expect(toSnapshot([raw], null, null, null).workspaces).toEqual([
      { id: 3, name: "3", windows: 0, monitor: "DP-1" },
    ]);
  });

  test("leaves out special workspaces and untitled windows", () => {
    const snapshot = toSnapshot(
      [{ id: -98, name: "special:scratch", windows: 1, monitor: "eDP-1" }],
      { id: 1 },
      [client("0x1", -98, 0, "scratch"), client("0x2", 1, 1, "")],
      [],
    );
    expect(snapshot.workspaces).toEqual([]);
    expect(snapshot.windows).toEqual([]);
    // The focused window is in the scratchpad, which the phone can't show.
    expect(snapshot.activeWindow).toBeNull();
  });

  test("copes with every read having failed", () => {
    expect(toSnapshot(null, null, null, null)).toEqual({
      workspaces: [],
      activeWorkspace: null,
      activeWindow: null,
      windows: [],
      monitors: [],
    });
  });
});
