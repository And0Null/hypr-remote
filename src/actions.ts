import { z } from "zod";

import { changeVolume, setAppVolume, setOutput, setVolume, toggleMic, toggleMute } from "./features/audio";
import { CLIPBOARD_LIMIT, getClipboard, setClipboard } from "./features/clipboard";
import { appName, moveWindow, switchWorkspace, windowCommand } from "./features/desktop";
import { changeBrightness, setBrightness, setNightLight, WARMTH } from "./features/display";
import { click, KEYS, movePointer, pressKey, scroll, TEXT_LIMIT, typeText, type KeyName } from "./features/input";
import { mediaCommand, seekMedia } from "./features/media";
import {
  clearNotifications,
  closeNote,
  findNote,
  setDndMode,
} from "./features/notifications";
import { lockScreen, powerOff, setScreens } from "./features/power";
import { openMenu, setRadio } from "./features/radios";
import { openLink } from "./features/send";
import { dispatch, hyprJson, type Client } from "./hypr";
import { saveScene, tapScene, type Scene } from "./scenes";

/**
 * Everything the phone is allowed to ask for. Messages are validated against
 * this schema and anything that doesn't match exactly is dropped. No field is
 * ever passed to a shell; the few values that reach a command line (window
 * addresses, sink names, URLs) are constrained here or checked again against
 * live data in the feature that uses them.
 */
// Past 10 for setups with more workspaces than number keys; capped so a bad
// message can't conjure workspace 4000000.
const workspaceId = z.number().int().min(1).max(99);
const address = z.string().regex(/^0x[0-9a-f]{1,16}$/);

export const Action = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("media"), command: z.enum(["play-pause", "next", "previous"]) }),
  // Relative skips (-10, +10) or a jump to a point in the track, in seconds.
  z.strictObject({ type: z.literal("media-skip"), by: z.number().int().min(-600).max(600) }),
  z.strictObject({ type: z.literal("media-seek"), to: z.number().finite().min(0).max(86_400) }),
  z.strictObject({ type: z.literal("volume"), command: z.enum(["up", "down", "mute"]) }),
  z.strictObject({ type: z.literal("volume-set"), level: z.number().int().min(0).max(100) }),
  z.strictObject({ type: z.literal("brightness"), command: z.enum(["up", "down"]) }),
  // One screen by its id from the state ("laptop", "HDMI-A-1"), or all of them.
  z.strictObject({
    type: z.literal("brightness-set"),
    level: z.number().int().min(5).max(100),
    screen: z.string().max(64).optional(),
  }),
  z.strictObject({ type: z.literal("night-light"), on: z.boolean() }),
  z.strictObject({
    type: z.literal("night-light-set"),
    temperature: z.number().int().min(WARMTH.min).max(WARMTH.max),
  }),
  z.strictObject({ type: z.literal("workspace"), id: workspaceId }),
  z.strictObject({ type: z.literal("lock") }),
  z.strictObject({ type: z.literal("screen"), on: z.boolean() }),
  z.strictObject({ type: z.literal("power"), op: z.enum(["sleep", "restart", "shut-down"]) }),

  z.strictObject({
    type: z.literal("window"),
    op: z.enum(["focus", "close", "fullscreen", "float", "kill"]),
    address,
  }),
  z.strictObject({ type: z.literal("window-move"), address, workspace: workspaceId }),
  z.strictObject({ type: z.literal("scene"), id: z.string().max(24) }),
  // Saves the current volume, brightness, do not disturb and night light into it.
  z.strictObject({ type: z.literal("scene-save"), id: z.string().max(24) }),
  // Where sound goes, by an output id from the state; checked against live outputs.
  z.strictObject({ type: z.literal("output"), id: z.string().max(512) }),
  z.strictObject({ type: z.literal("mic") }),
  z.strictObject({
    type: z.literal("app-volume"),
    name: z.string().max(128),
    level: z.number().int().min(0).max(100),
  }),
  z.strictObject({ type: z.literal("notifications"), op: z.literal("clear") }),
  z.strictObject({ type: z.literal("dnd"), mode: z.enum(["off", "on", "hour", "morning"]) }),
  z.strictObject({
    type: z.literal("notification"),
    op: z.enum(["open", "close"]),
    id: z.number().int().min(0).max(2 ** 32 - 1),
  }),
  z.strictObject({ type: z.literal("radio"), device: z.enum(["wifi", "bluetooth"]), on: z.boolean() }),
  // The laptop's own Wi-Fi or Bluetooth menu.
  z.strictObject({ type: z.literal("radio-menu"), device: z.enum(["wifi", "bluetooth"]) }),

  z.strictObject({ type: z.literal("clipboard-set"), text: z.string().max(CLIPBOARD_LIMIT) }),
  z.strictObject({ type: z.literal("clipboard-get") }),
  // Links only; files go over HTTP (see /upload).
  z.strictObject({ type: z.literal("open-link"), url: z.string().max(4096) }),

  z.strictObject({ type: z.literal("type"), text: z.string().min(1).max(TEXT_LIMIT) }),
  // Named keys, which also drive slides (page-up/down, blank).
  z.strictObject({
    type: z.literal("key"),
    key: z.enum(Object.keys(KEYS) as [KeyName, ...KeyName[]]),
  }),
  z.strictObject({
    type: z.literal("pointer-move"),
    dx: z.number().finite().min(-2000).max(2000),
    dy: z.number().finite().min(-2000).max(2000),
  }),
  z.strictObject({ type: z.literal("pointer-click"), button: z.enum(["left", "right", "middle"]) }),
  z.strictObject({ type: z.literal("pointer-scroll"), dy: z.number().int().min(-20).max(20) }),
]);

export type Action = z.infer<typeof Action>;

/** A reply sent back to the one phone that asked, rather than broadcast. */
export type Reply = { type: "clipboard"; text: string } | { type: "toast"; text: string };

/**
 * Runs an action. Returns whether the desktop state is worth re-reading
 * straight away (pointer moves, for instance, change nothing the phone shows).
 */
export async function runAction(
  action: Action,
  scenes: Scene[],
): Promise<{ changed: boolean; reply?: Reply }> {
  switch (action.type) {
    case "media":
      await mediaCommand(action.command);
      break;
    case "media-skip":
      await seekMedia({ by: action.by });
      break;
    case "media-seek":
      await seekMedia({ to: action.to });
      break;
    case "volume":
      await (action.command === "mute" ? toggleMute() : changeVolume(action.command));
      break;
    case "volume-set":
      await setVolume(action.level);
      break;
    case "brightness":
      await changeBrightness(action.command);
      break;
    case "brightness-set":
      await setBrightness(action.level, action.screen);
      break;
    case "night-light":
      await setNightLight({ on: action.on });
      break;
    case "night-light-set":
      await setNightLight({ temperature: action.temperature });
      break;
    case "workspace":
      await switchWorkspace(action.id);
      break;
    case "lock":
      await lockScreen();
      break;
    case "screen":
      await setScreens(action.on);
      break;
    case "power": {
      // Replies first: after this, the laptop won't be answering.
      setTimeout(() => void powerOff(action.op), 500);
      const text = {
        sleep: "going to sleep. the remote comes back when the laptop wakes",
        restart: "restarting. the remote comes back after login",
        "shut-down": "shutting down",
      }[action.op];
      return { changed: false, reply: { type: "toast", text } };
    }
    case "window":
      await windowCommand(action.op, action.address);
      break;
    case "window-move":
      await moveWindow(action.address, action.workspace);
      break;
    case "scene": {
      const scene = scenes.find((candidate) => candidate.id === action.id);
      if (!scene) return { changed: false };
      const now = await tapScene(scene);
      return { changed: true, reply: { type: "toast", text: `${scene.label} ${now}` } };
    }
    case "scene-save": {
      // The scenes file watcher picks the change up and sends it to the phones.
      const saved = await saveScene(scenes, action.id);
      const label = scenes.find((scene) => scene.id === action.id)?.label;
      return { changed: true, reply: saved && label ? { type: "toast", text: `saved to ${label}` } : undefined };
    }
    case "output":
      await setOutput(action.id);
      break;
    case "mic":
      await toggleMic();
      break;
    case "app-volume":
      await setAppVolume(action.name, action.level);
      break;
    case "notifications":
      await clearNotifications();
      break;
    case "dnd":
      await setDndMode(action.mode);
      break;
    case "notification": {
      if (action.op === "close") {
        await closeNote(action.id);
        break;
      }
      const found = findNote(action.id);
      if (!found) break;
      if (!(await focusApp(found.names))) {
        return { changed: false, reply: { type: "toast", text: `no ${found.note.app || "app"} window is open` } };
      }
      // Opened, as on a phone: it's been seen.
      await closeNote(action.id);
      break;
    }
    case "radio":
      await setRadio(action.device, action.on);
      break;
    case "radio-menu":
      if (!(await openMenu(action.device))) {
        return { changed: false, reply: { type: "toast", text: `no ${action.device} menu found on the laptop` } };
      }
      return { changed: false };
    case "clipboard-set":
      await setClipboard(action.text);
      return { changed: false, reply: { type: "toast", text: "copied to laptop" } };
    case "clipboard-get":
      return { changed: false, reply: { type: "clipboard", text: await getClipboard() } };
    case "open-link": {
      const opened = await openLink(action.url);
      return {
        changed: false,
        reply: { type: "toast", text: opened ? "opened on laptop" : "that isn't a web link" },
      };
    }
    case "type":
      await typeText(action.text);
      return { changed: false };
    case "key":
      await pressKey(action.key);
      return { changed: false };
    case "pointer-move":
      movePointer(action.dx, action.dy);
      return { changed: false };
    case "pointer-click":
      await click(action.button);
      return { changed: false };
    case "pointer-scroll":
      await scroll(action.dy);
      return { changed: false };
  }
  return { changed: true };
}

/** Focuses a window of the app a notification came from, by any of its names. */
async function focusApp(names: string[]): Promise<boolean> {
  const wanted = names.map((name) => appName(name)).filter(Boolean);
  const clients = (await hyprJson<Client[]>("clients")) ?? [];
  const client = clients
    .filter((candidate) => candidate.workspace.id > 0)
    .sort((a, b) => a.focusHistoryID - b.focusHistoryID)
    .find((candidate) => {
      const name = appName(candidate.class);
      return name !== "" && wanted.some((want) => name === want || name.includes(want) || want.includes(name));
    });
  return client ? dispatch(`focuswindow address:${client.address}`) : false;
}
