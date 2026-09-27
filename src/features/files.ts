import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

import { DOWNLOADS_DIR } from "../env";
import { read } from "../run";

/**
 * Files the phone can take from the laptop: the newest screenshot and the
 * last few downloads. `key` is all the phone gets; /file serves only keys
 * from the latest listing, never a path the phone names.
 */
export type FileView = { key: string; name: string; size: number; time: number; image: boolean };
export type Files = { screenshot: FileView | null; downloads: FileView[] };

// The most a phone shows; each phone picks how many in its settings.
const DOWNLOADS_SHOWN = 10;
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
// Browsers write these while a download is still arriving.
const PARTIAL = new Set([".part", ".crdownload", ".download", ".tmp", ".partial"]);

let paths = new Map<string, string>();

type Entry = { path: string; name: string; size: number; time: number };

// Listing a big Downloads folder means a stat per file, so each folder's
// listing is kept until the folder itself changes.
const listings = new Map<string, { mtime: number; entries: Entry[] }>();

async function list(dir: string): Promise<Entry[]> {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return [];
  const cached = listings.get(dir);
  if (cached?.mtime === info.mtimeMs) return cached.entries;

  const names = (await readdir(dir).catch(() => [])).filter((name) => !name.startsWith("."));
  const entries = (
    await Promise.all(
      names.map(async (name) => {
        const path = join(dir, name);
        const file = await stat(path).catch(() => null);
        return file?.isFile() ? { path, name, size: file.size, time: file.mtimeMs } : null;
      }),
    )
  )
    .filter((entry) => entry !== null)
    .sort((a, b) => b.time - a.time);
  listings.set(dir, { mtime: info.mtimeMs, entries });
  return entries;
}

/** Where screenshot tools save: their own setting, then the usual folders. */
async function screenshotDirs(): Promise<{ dir: string; all: boolean }[]> {
  // With no Pictures folder set, xdg-user-dir answers with the home folder.
  const named = await read(["xdg-user-dir", "PICTURES"]);
  const pictures = named && named !== homedir() ? named : join(homedir(), "Pictures");
  const own = [process.env.XDG_SCREENSHOTS_DIR, process.env.HYPRSHOT_DIR];
  return [
    ...own.filter((dir): dir is string => Boolean(dir)).map((dir) => ({ dir, all: true })),
    { dir: join(pictures, "Screenshots"), all: true },
    // Loose in Pictures, only files named like screenshots (grim's "…_grim.png").
    { dir: pictures, all: false },
    { dir: homedir(), all: false },
  ];
}

export const isScreenshotName = (name: string) => /screenshot|screen[ _-]?shot|_grim\.|^grim/i.test(name);

export async function readFiles(): Promise<Files> {
  const next = new Map<string, string>();
  const view = (entry: Entry): FileView => {
    const key = Bun.hash(`${entry.path}\0${entry.time}`).toString(36);
    next.set(key, entry.path);
    return {
      key,
      name: entry.name,
      size: entry.size,
      time: Math.round(entry.time),
      image: IMAGES.has(extname(entry.name).toLowerCase()),
    };
  };

  let newest: Entry | null = null;
  for (const { dir, all } of await screenshotDirs()) {
    const found = (await list(dir)).find(
      (entry) => IMAGES.has(extname(entry.name).toLowerCase()) && (all || isScreenshotName(entry.name)),
    );
    if (found && (!newest || found.time > newest.time)) newest = found;
  }

  const downloads = (await list(DOWNLOADS_DIR))
    .filter((entry) => !PARTIAL.has(extname(entry.name).toLowerCase()))
    .slice(0, DOWNLOADS_SHOWN);

  const files = { screenshot: newest ? view(newest) : null, downloads: downloads.map(view) };
  paths = next;
  return files;
}

/** The file behind a key from the latest listing, or null. */
export function fileFor(key: string): string | null {
  return paths.get(key) ?? null;
}
