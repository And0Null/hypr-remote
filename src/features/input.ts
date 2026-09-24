import { existsSync } from "node:fs";
import { dispatch, hyprJson, type Monitor } from "../hypr";
import { installed, run } from "../run";

/* -------------------------------------------------------------------------- */
/* Keyboard (wtype)                                                           */
/* -------------------------------------------------------------------------- */

export const TEXT_LIMIT = 2000;

/**
 * Named keys the phone may press, mapped to wtype arguments. A fixed table
 * rather than passing key names through, so the phone can't send arbitrary
 * modifier chords (no ctrl+alt+whatever it likes).
 */
export const KEYS = {
  enter: ["-k", "Return"],
  backspace: ["-k", "BackSpace"],
  tab: ["-k", "Tab"],
  escape: ["-k", "Escape"],
  space: ["-k", "space"],
  left: ["-k", "Left"],
  right: ["-k", "Right"],
  up: ["-k", "Up"],
  down: ["-k", "Down"],
  "page-up": ["-k", "Prior"],
  "page-down": ["-k", "Next"],
  home: ["-k", "Home"],
  end: ["-k", "End"],
  f5: ["-k", "F5"],
  // Most slide apps blank the screen on "b" and resume on the next key.
  blank: ["-k", "b"],
  copy: ["-M", "ctrl", "-k", "c", "-m", "ctrl"],
  paste: ["-M", "ctrl", "-k", "v", "-m", "ctrl"],
  cut: ["-M", "ctrl", "-k", "x", "-m", "ctrl"],
  undo: ["-M", "ctrl", "-k", "z", "-m", "ctrl"],
  "select-all": ["-M", "ctrl", "-k", "a", "-m", "ctrl"],
} as const satisfies Record<string, readonly string[]>;

export type KeyName = keyof typeof KEYS;

export async function typeText(text: string) {
  // "--" so text starting with a dash is typed, not read as a flag.
  await run(["wtype", "--", text.slice(0, TEXT_LIMIT)]);
}

export async function pressKey(key: KeyName) {
  await run(["wtype", ...KEYS[key]]);
}

/* -------------------------------------------------------------------------- */
/* Touchpad                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Movement goes through Hyprland's own `movecursor`, over the request socket:
 * no extra software, no root, and no process per event. Clicks and scrolling
 * have no Hyprland equivalent, so those use ydotool, which needs its daemon.
 */

type Rect = { x: number; y: number; width: number; height: number };

let screens: Rect[] = [];
let cursor: { x: number; y: number } | null = null;
let lastMove = 0;
let pending = { dx: 0, dy: 0 };
let flushing = false;

async function refreshGeometry() {
  const monitors = (await hyprJson<Monitor[]>("monitors")) ?? [];
  // Layout coordinates are logical: a 1920px panel at 1.25 scale is 1536 wide.
  screens = monitors.map((monitor) => ({
    x: monitor.x,
    y: monitor.y,
    width: Math.round(monitor.width / monitor.scale),
    height: Math.round(monitor.height / monitor.scale),
  }));
}

/** Keeps the cursor on some screen: across gaps between monitors, not off the edge of the desk. */
function clampToScreens(x: number, y: number) {
  let best = { x, y, distance: Infinity };
  for (const screen of screens) {
    const cx = Math.min(Math.max(x, screen.x), screen.x + screen.width - 1);
    const cy = Math.min(Math.max(y, screen.y), screen.y + screen.height - 1);
    const distance = Math.hypot(cx - x, cy - y);
    if (distance < best.distance) best = { x: cx, y: cy, distance };
  }
  return { x: best.x, y: best.y };
}

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (pending.dx !== 0 || pending.dy !== 0) {
      const { dx, dy } = pending;
      pending = { dx: 0, dy: 0 };

      // After a pause, the real mouse may have moved; start from where it is.
      if (!cursor || Date.now() - lastMove > 400) {
        await refreshGeometry();
        cursor = await hyprJson<{ x: number; y: number }>("cursorpos");
        if (!cursor) return;
      }
      lastMove = Date.now();

      cursor = clampToScreens(cursor.x + dx, cursor.y + dy);
      await dispatch(`movecursor ${Math.round(cursor.x)} ${Math.round(cursor.y)}`);
    }
  } finally {
    flushing = false;
  }
}

/**
 * Deltas pile up while a move is in flight and go out as one, so a slow
 * frame never queues a backlog of stale positions.
 */
export function movePointer(dx: number, dy: number) {
  pending.dx += dx;
  pending.dy += dy;
  void flush();
}

const BUTTONS = { left: "0xC0", right: "0xC1", middle: "0xC2" } as const;

export async function click(button: keyof typeof BUTTONS) {
  await run(["ydotool", "click", BUTTONS[button]]);
}

/** Notches, positive down like a browser's deltaY. ydotool's wheel is positive up. */
export async function scroll(dy: number) {
  await run(["ydotool", "mousemove", "--wheel", "-x", "0", "-y", String(-Math.round(dy))]);
}

/* -------------------------------------------------------------------------- */

export async function readInputSupport() {
  const ydotoolSocket = process.env.YDOTOOL_SOCKET;
  return {
    keyboard: installed("wtype"),
    // The client alone isn't enough; the daemon's socket has to exist.
    clicks:
      // existsSync, not Bun.file().exists(): the latter is false for sockets.
      installed("ydotool") && Boolean(ydotoolSocket) && existsSync(ydotoolSocket!),
  };
}
