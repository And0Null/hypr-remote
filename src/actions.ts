import { z } from "zod";

import { changeVolume, setSink, setVolume, toggleMute } from "./features/audio";
import { CLIPBOARD_LIMIT, getClipboard, setClipboard } from "./features/clipboard";
import { switchWorkspace, windowCommand } from "./features/desktop";
import { click, KEYS, movePointer, pressKey, scroll, TEXT_LIMIT, typeText, type KeyName } from "./features/input";
import { mediaCommand } from "./features/media";
import { openLink } from "./features/send";
import {
  changeBrightness,
  clearNotifications,
  lockScreen,
  setBrightness,
  setRadio,
  toggleDnd,
} from "./features/system";
import { applyScene, type Scene } from "./scenes";

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
  z.object({ type: z.literal("media"), command: z.enum(["play-pause", "next", "previous"]) }),
  z.object({ type: z.literal("volume"), command: z.enum(["up", "down", "mute"]) }),
  z.object({ type: z.literal("volume-set"), level: z.number().int().min(0).max(100) }),
  z.object({ type: z.literal("brightness"), command: z.enum(["up", "down"]) }),
  z.object({ type: z.literal("brightness-set"), level: z.number().int().min(5).max(100) }),
  z.object({ type: z.literal("workspace"), id: workspaceId }),
  z.object({ type: z.literal("lock") }),

  z.object({ type: z.literal("window"), op: z.enum(["focus", "close"]), address }),
  z.object({ type: z.literal("window-move"), address, workspace: workspaceId }),
  z.object({ type: z.literal("scene"), id: z.string().max(24) }),
  // The default audio output.
  z.object({ type: z.literal("sink"), name: z.string().max(256) }),
  z.object({ type: z.literal("notifications"), op: z.enum(["toggle-dnd", "clear"]) }),
  z.object({ type: z.literal("radio"), device: z.enum(["wifi", "bluetooth"]), on: z.boolean() }),

  z.object({ type: z.literal("clipboard-set"), text: z.string().max(CLIPBOARD_LIMIT) }),
  z.object({ type: z.literal("clipboard-get") }),
  // Links only; files go over HTTP (see /upload).
  z.object({ type: z.literal("open-link"), url: z.string().max(4096) }),

  z.object({ type: z.literal("type"), text: z.string().min(1).max(TEXT_LIMIT) }),
  // Named keys, which also drive slides (page-up/down, blank).
  z.object({
    type: z.literal("key"),
    key: z.enum(Object.keys(KEYS) as [KeyName, ...KeyName[]]),
  }),
  z.object({
    type: z.literal("pointer-move"),
    dx: z.number().finite().min(-2000).max(2000),
    dy: z.number().finite().min(-2000).max(2000),
  }),
  z.object({ type: z.literal("pointer-click"), button: z.enum(["left", "right", "middle"]) }),
  z.object({ type: z.literal("pointer-scroll"), dy: z.number().int().min(-20).max(20) }),
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
      await setBrightness(action.level);
      break;
    case "workspace":
      await switchWorkspace(action.id);
      break;
    case "lock":
      await lockScreen();
      break;
    case "window":
      await windowCommand(action.op, action.address);
      break;
    case "window-move":
      await windowCommand("move", action.address, action.workspace);
      break;
    case "scene": {
      const scene = scenes.find((candidate) => candidate.id === action.id);
      if (!scene) return { changed: false };
      await applyScene(scene);
      return { changed: true, reply: { type: "toast", text: `${scene.label} on` } };
    }
    case "sink":
      await setSink(action.name);
      break;
    case "notifications":
      await (action.op === "clear" ? clearNotifications() : toggleDnd());
      break;
    case "radio":
      await setRadio(action.device, action.on);
      break;
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
