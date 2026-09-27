import { installed, read, readBytes, run } from "../run";
import { follow } from "../watch";
import { imageType } from "./media";

export const CLIPBOARD_LIMIT = 100_000;
/** Images either way; a full-screen PNG is a few megabytes. */
export const CLIP_IMAGE_LIMIT = 20 * 1024 * 1024;
const RING = 6;
const PREVIEW = 140;

/**
 * One thing that was copied, as the phone sees it: a line of text, or an
 * image it loads by `key` from /clip. Secrets (a password manager's copies)
 * show no preview.
 */
export type ClipView = { key: string; kind: "text" | "image"; preview: string };
export type Clipboard = { current: ClipView | null; history: ClipView[] };

type Clip = ClipView & { bytes: Uint8Array<ArrayBuffer>; type: string };

// What's on the clipboard now (null when it's empty or unreadable), and what
// this server saw copied since it started, newest first; the history when
// cliphist isn't installed.
let current: Clip | null = null;
let ring: Clip[] = [];
let counter = 0;
// cliphist's own ids, from its last listing: the only ones /clip will decode.
let cliphistIds = new Set<string>();
let history: ClipView[] = [];

const TEXT_TYPES = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "STRING", "TEXT"];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
// KeePassXC and others mark what they copy, so clipboard tools can skip it.
const SECRET_HINT = "x-kde-passwordManagerHint";

export async function setClipboard(text: string) {
  await run(["wl-copy"], { input: text, discardOutput: true });
}

/** Puts an image from the phone on the laptop's clipboard, if it really is one. */
export async function setClipboardImage(bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const type = imageType(bytes);
  if (!type || bytes.length > CLIP_IMAGE_LIMIT) return false;
  await run(["wl-copy", "--type", type], { input: bytes, discardOutput: true });
  return true;
}

/** One line of text, trimmed: what a row has room for. */
export function previewText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW ? `${line.slice(0, PREVIEW - 1)}…` : line;
}

/** Reads what's on the clipboard now, preferring an image over its text. */
async function readCurrent(): Promise<Clip | null> {
  const types = (await read(["wl-paste", "--list-types"]))?.split("\n") ?? [];
  const image = IMAGE_TYPES.find((type) => types.includes(type));
  const text = TEXT_TYPES.find((type) => types.includes(type));
  const type = image ?? text;
  if (!type) return null;

  const bytes = await readBytes(["wl-paste", "--no-newline", "--type", type]);
  if (!bytes || bytes.length === 0) return null;
  const key = `m${++counter}`;
  if (image) {
    if (bytes.length > CLIP_IMAGE_LIMIT) return null;
    return { key, kind: "image", preview: image.slice(6), bytes, type: image };
  }
  const clipped = bytes.subarray(0, CLIPBOARD_LIMIT * 4);
  const secret = types.includes(SECRET_HINT);
  return {
    key,
    kind: "text",
    preview: secret ? "••••••••" : previewText(new TextDecoder().decode(clipped)),
    bytes: clipped,
    type: "text/plain; charset=utf-8",
  };
}

/**
 * Follows the clipboard for as long as the server runs, so the phone can show
 * what was just copied. `wl-paste --watch` runs `echo` on every change; each
 * line it prints is a change.
 */
export function followClipboard(onChange: () => void) {
  if (!installed("wl-paste")) return;
  let pending: ReturnType<typeof setTimeout> | undefined;
  follow(["wl-paste", "--watch", "echo"], () => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      const clip = await readCurrent();
      if (clip && sameClip(clip, ring[0])) current = ring[0]!;
      else {
        current = clip;
        if (clip) ring = [clip, ...ring].slice(0, RING);
      }
      // Give cliphist's own watcher a moment to store it first.
      await Bun.sleep(300);
      history = await readHistory();
      onChange();
    }, 100);
  });
}

function sameClip(a: Clip, b: Clip | undefined) {
  return b !== undefined && a.type === b.type && Bun.deepEquals(a.bytes, b.bytes);
}

/**
 * The last few things copied before the current one. From cliphist when it's
 * installed (it remembers across restarts), otherwise from what this server
 * saw. cliphist's newest entry is the clipboard as it is now, so it's skipped.
 */
async function readHistory(): Promise<ClipView[]> {
  const listing = installed("cliphist") ? await read(["cliphist", "list"]) : null;
  if (listing === null) {
    return ring
      .filter((clip) => clip !== current)
      .slice(0, RING - 1)
      .map(({ key, kind, preview }) => ({ key, kind, preview }));
  }
  const entries = parseCliphist(listing);
  cliphistIds = new Set(entries.map((entry) => entry.key.slice(1)));
  return entries.slice(1, RING);
}

/** "4349\t[[ binary data 123 KiB png 773x828 ]]" is an image; anything else is text. */
export function parseCliphist(listing: string): ClipView[] {
  return listing
    .split("\n")
    .slice(0, RING)
    .map((line) => {
      const tab = line.indexOf("\t");
      const id = line.slice(0, tab);
      const rest = line.slice(tab + 1);
      if (tab < 1 || !/^\d+$/.test(id)) return null;
      const image = rest.match(/^\[\[ binary data .*? (png|jpe?g|webp|gif|bmp) (\d+x\d+) \]\]$/);
      return image
        ? { key: `c${id}`, kind: "image" as const, preview: `${image[1]} ${image[2]!.replace("x", "×")}` }
        : { key: `c${id}`, kind: "text" as const, preview: previewText(rest) };
    })
    .filter((entry) => entry !== null);
}

export function readClipboard(): Clipboard {
  return {
    current: current ? { key: current.key, kind: current.kind, preview: current.preview } : null,
    history,
  };
}

/**
 * The bytes behind a key from the state: the current clip, one this server
 * saw, or a cliphist entry from its latest listing. Nothing else.
 */
export async function readClip(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
  const seen = ring.find((clip) => clip.key === key);
  if (seen) return { bytes: seen.bytes, type: seen.type };

  const id = key.slice(1);
  if (!key.startsWith("c") || !cliphistIds.has(id)) return null;
  const bytes = await readBytes(["cliphist", "decode", id]);
  if (!bytes) return null;
  return { bytes, type: imageType(bytes) ?? "text/plain; charset=utf-8" };
}
