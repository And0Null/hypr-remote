import { fileURLToPath } from "node:url";

import { read, run } from "../run";

/**
 * `position` and `length` are in seconds, null when the player doesn't say.
 * `art` is a key for /art, not the art's address: the phone never learns a
 * path on this laptop, and can't ask for one.
 */
export type Media = {
  status: string;
  artist: string;
  title: string;
  player: string;
  position: number | null;
  length: number | null;
  art: string | null;
};

// A separator no song title will contain.
const SEPARATOR = "␟";
export const MEDIA_FORMAT = [
  "{{status}}",
  "{{artist}}",
  "{{title}}",
  "{{playerName}}",
  "{{position}}",
  "{{mpris:length}}",
  "{{mpris:artUrl}}",
].join(SEPARATOR);

/** The art the current track reports, which is the only art /art serves. */
let currentArt: { key: string; url: string } | null = null;

export async function readMedia(): Promise<Media | null> {
  const output = await read(["playerctl", "metadata", "--format", MEDIA_FORMAT]);
  const parsed = output ? parseMedia(output) : null;
  currentArt = parsed?.artUrl ? { key: Bun.hash(parsed.artUrl).toString(36), url: parsed.artUrl } : null;
  return parsed && { ...parsed.media, art: currentArt?.key ?? null };
}

/** MPRIS reports times in microseconds; players that don't know leave it out. */
const seconds = (micro = "") => (/^\d+$/.test(micro) ? Number(micro) / 1e6 : null);

export function parseMedia(output: string): { media: Omit<Media, "art">; artUrl: string } {
  const [status = "", artist = "", title = "", player = "", position, length, artUrl = ""] =
    output.split(SEPARATOR);
  return {
    // A length of 0 is a live stream, or a player that doesn't know.
    media: { status, artist, title, player, position: seconds(position), length: seconds(length) || null },
    artUrl,
  };
}

export async function mediaCommand(command: "play-pause" | "next" | "previous" | "pause" | "play") {
  await run(["playerctl", command]);
}

/** Skips by a number of seconds, or jumps to a point in the track. */
export async function seekMedia(target: { by: number } | { to: number }) {
  const offset =
    "to" in target ? String(target.to) : `${Math.abs(target.by)}${target.by < 0 ? "-" : "+"}`;
  await run(["playerctl", "position", offset]);
}

/* -------------------------------------------------------------------------- */
/* Album art                                                                  */
/* -------------------------------------------------------------------------- */

const ART_LIMIT = 5 * 1024 * 1024;

/**
 * The current track's art, if `key` still names it. Players give a local file
 * (browsers write one to /tmp or their profile), a web address, or the image
 * itself as a data: URL.
 * Whatever comes back must really be an image: a player could name any file.
 */
export async function readArt(key: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
  if (!currentArt || currentArt.key !== key) return null;
  const bytes = await fetchArt(currentArt.url).catch(() => null);
  const type = bytes && imageType(bytes);
  return bytes && type ? { bytes, type } : null;
}

async function fetchArt(url: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (url.startsWith("file://")) {
    const file = Bun.file(fileURLToPath(url));
    if (!(await file.exists()) || file.size > ART_LIMIT) return null;
    return new Uint8Array(await file.arrayBuffer());
  }
  // mpv hands over embedded cover art inline.
  const inline = /^data:image\/[\w.+-]+;base64,(.+)$/.exec(url);
  if (inline) {
    const bytes = new Uint8Array(Buffer.from(inline[1]!, "base64"));
    return bytes.length <= ART_LIMIT ? bytes : null;
  }
  if (url.startsWith("https://")) {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "error" });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length <= ART_LIMIT ? bytes : null;
  }
  return null;
}

/** The image type from the file's first bytes, or null if it isn't one. */
export function imageType(bytes: Uint8Array): string | null {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  const text = new TextDecoder().decode(bytes.subarray(0, 12));
  if (text.startsWith("RIFF") && text.endsWith("WEBP")) return "image/webp";
  return null;
}
