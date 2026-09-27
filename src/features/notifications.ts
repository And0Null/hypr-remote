import type { Subprocess } from "bun";

import { installed, read, run } from "../run";

/* -------------------------------------------------------------------------- */
/* The notification daemon: swaync, mako or dunst                             */
/* -------------------------------------------------------------------------- */

export type Daemon = "swaync" | "mako" | "dunst";

/** One notification as the phone lists it. `time` is ms since the epoch. */
export type Note = { id: number; app: string; title: string; body: string; time: number };

/**
 * `count` is what the daemon holds, which can be more than `list`: only
 * notifications that arrive while this server runs can be read.
 * `dndUntil` is when a timed do-not-disturb ends (ms since the epoch).
 */
export type Notifications = {
  daemon: Daemon;
  dnd: boolean;
  dndUntil: number | null;
  count: number;
  list: Note[];
} | null;

/** Which daemon owns the notification bus name right now. */
async function daemon(): Promise<Daemon | null> {
  const status = await read(["busctl", "--user", "status", "org.freedesktop.Notifications"]);
  const comm = status && /^Comm=(.+)$/m.exec(status)?.[1];
  return comm === "swaync" || comm === "mako" || comm === "dunst" ? comm : null;
}

export async function readNotifications(): Promise<Notifications> {
  const which = await daemon();
  if (!which) return null;
  const [dnd, count] = await Promise.all([readDnd(which), readCount(which)]);
  if (!dnd) clearDndTimer();
  return { daemon: which, dnd, dndUntil, count: Math.max(count, notes.length), list: notes };
}

async function readDnd(which: Daemon): Promise<boolean> {
  if (which === "swaync") return (await read(["swaync-client", "--get-dnd"])) === "true";
  if (which === "dunst") return (await read(["dunstctl", "is-paused"])) === "true";
  return ((await read(["makoctl", "mode"])) ?? "").split("\n").includes("do-not-disturb");
}

async function readCount(which: Daemon): Promise<number> {
  if (which === "swaync") return Number((await read(["swaync-client", "--count"])) ?? 0) || 0;
  if (which === "dunst") return Number((await read(["dunstctl", "count", "displayed"])) ?? 0) || 0;
  return countMako((await read(["makoctl", "list"])) ?? "");
}

/**
 * `makoctl list` prints JSON before mako 1.9 and text after: a line
 * "Notification 12: summary" per notification.
 */
export function countMako(output: string): number {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed?.data?.[0]) ? parsed.data[0].length : 0;
  } catch {
    return output.split("\n").filter((line) => /^Notification \d+:/.test(line)).length;
  }
}

export async function setDnd(on: boolean) {
  const which = await daemon();
  if (which === "swaync") await run(["swaync-client", on ? "--dnd-on" : "--dnd-off"]);
  // mako needs a [mode=do-not-disturb] section in its config to hide anything.
  if (which === "mako") await run(["makoctl", "mode", on ? "-a" : "-r", "do-not-disturb"]);
  if (which === "dunst") await run(["dunstctl", "set-paused", String(on)]);
}

/* -------------------------------------------------------------------------- */
/* Timed do-not-disturb                                                       */
/* -------------------------------------------------------------------------- */

let dndUntil: number | null = null;
let dndTimer: ReturnType<typeof setTimeout> | undefined;

function clearDndTimer() {
  clearTimeout(dndTimer);
  dndUntil = null;
}

/** 07:00 tomorrow, or today if it's still before then. */
export function nextMorning(now = new Date()): Date {
  const morning = new Date(now);
  morning.setHours(7, 0, 0, 0);
  if (morning <= now) morning.setDate(morning.getDate() + 1);
  return morning;
}

/** Off, on until turned off, on for an hour, or on until morning. */
export async function setDndMode(mode: "off" | "on" | "hour" | "morning", onEnd?: () => void) {
  clearDndTimer();
  await setDnd(mode !== "off");
  if (mode === "off" || mode === "on") return;
  dndUntil = mode === "hour" ? Date.now() + 60 * 60 * 1000 : nextMorning().getTime();
  dndTimer = setTimeout(async () => {
    dndUntil = null;
    await setDnd(false);
    onEnd?.();
  }, dndUntil - Date.now());
}

/* -------------------------------------------------------------------------- */
/* Reading notifications as they arrive                                       */
/* -------------------------------------------------------------------------- */

const LIMIT = 50;
// Newest first. Kept in memory only, never written anywhere.
let notes: Note[] = [];
// The app's desktop entry, where it gave one, to find its window by.
const entries = new Map<number, string>();

type BusMessage = {
  type: "method_call" | "method_return" | "signal" | "error";
  sender: string | null;
  destination: string | null;
  member: string | null;
  cookie: number;
  reply_cookie: number | null;
  payload: { type: string; data: unknown[] };
};

/**
 * Follows the notification bus with `busctl monitor`, which any program of
 * the user's may do. A Notify call carries the notification, its reply the id
 * the daemon gave it, and NotificationClosed its end.
 */
export function followNotifications(onChange: () => void) {
  if (!installed("busctl")) return { stop() {} };
  const pending = new Map<string, Omit<Note, "id"> & { replaces: number; entry: string }>();
  let child: Subprocess<"ignore", "pipe", "ignore"> | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const handle = (message: BusMessage) => {
    if (message.type === "method_call" && message.member === "Notify") {
      const call = parseNotify(message.payload.data);
      if (call) pending.set(`${message.sender}:${message.cookie}`, call);
    } else if (message.type === "method_return" && message.reply_cookie !== null) {
      const key = `${message.destination}:${message.reply_cookie}`;
      const call = pending.get(key);
      const id = message.payload.data[0];
      if (!call || typeof id !== "number") return;
      pending.delete(key);
      const { replaces, entry, ...note } = call;
      notes = [{ id, ...note }, ...notes.filter((n) => n.id !== id && n.id !== replaces)].slice(0, LIMIT);
      if (entry) entries.set(id, entry);
      onChange();
    } else if (message.type === "signal" && message.member === "NotificationClosed") {
      const id = message.payload.data[0];
      if (!notes.some((note) => note.id === id)) return;
      notes = notes.filter((note) => note.id !== id);
      entries.delete(id as number);
      onChange();
    }
  };

  async function spawn() {
    if (stopped) return;
    try {
      child = Bun.spawn(["busctl", "--user", "monitor", "org.freedesktop.Notifications", "--json=short"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      let buffered = "";
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        const lines = (buffered + chunk).split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          try {
            handle(JSON.parse(line));
          } catch {
            // Not a message: busctl's own chatter.
          }
        }
        // Calls whose reply never came (an error, say) shouldn't pile up.
        if (pending.size > 100) pending.clear();
      }
      await child.exited;
    } catch {}
    if (!stopped) retry = setTimeout(spawn, 5000);
  }

  void spawn();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      child?.kill();
    },
  };
}

/** Notify(app_name, replaces_id, icon, summary, body, actions, hints, timeout). */
export function parseNotify(data: unknown[]) {
  const [app, replaces, , title, body, , hints] = data;
  if (typeof title !== "string") return null;
  const entry = (hints as Record<string, { data?: unknown }> | undefined)?.["desktop-entry"]?.data;
  return {
    app: typeof app === "string" && app ? app : typeof entry === "string" ? entry : "",
    title,
    body: plainText(typeof body === "string" ? body : ""),
    time: Date.now(),
    replaces: typeof replaces === "number" ? replaces : 0,
    entry: typeof entry === "string" ? entry : "",
  };
}

/** Notification bodies may carry a little markup; the phone shows plain text. */
export function plainText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/* -------------------------------------------------------------------------- */
/* Acting on them                                                             */
/* -------------------------------------------------------------------------- */

/** The notification and its app's names, if it's one the phone can see. */
export function findNote(id: number): { note: Note; names: string[] } | null {
  const note = notes.find((candidate) => candidate.id === id);
  if (!note) return null;
  return { note, names: [note.app, entries.get(id) ?? ""].filter(Boolean) };
}

/** Closes one, for every daemon alike: it's the standard bus call. */
export async function closeNote(id: number) {
  if (!notes.some((note) => note.id === id)) return;
  await run([
    "busctl",
    "--user",
    "call",
    "org.freedesktop.Notifications",
    "/org/freedesktop/Notifications",
    "org.freedesktop.Notifications",
    "CloseNotification",
    "u",
    String(id),
  ]);
}

export async function clearNotifications() {
  const which = await daemon();
  if (which === "swaync") await run(["swaync-client", "--close-all"]);
  if (which === "mako") await run(["makoctl", "dismiss", "--all"]);
  if (which === "dunst") await run(["dunstctl", "close-all"]);
  notes = [];
  entries.clear();
}
