import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { DOWNLOADS_DIR } from "../env";
import { dispatch } from "../hypr";
import { run, shellQuote } from "../run";

/**
 * Opens a link in the desktop's default browser. Through Hyprland's exec so
 * the browser isn't our child process; that exec goes through a shell, hence
 * the URL is normalised by the URL parser and then single-quoted.
 */
export async function openLink(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  await dispatch(`exec xdg-open ${shellQuote(url.href)}`);
  return true;
}

/**
 * A new file that's safe to write and doesn't overwrite anything: path parts
 * and odd characters are stripped, and "photo (2).jpg" style suffixes avoid
 * clobbering an existing file. Opened exclusively, so two uploads of the same
 * name can't both claim it between the check and the write.
 */
async function safeDestination(original: string): Promise<{ path: string; file: FileHandle }> {
  const cleaned = basename(original).replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "") || "file";
  const extension = extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - extension.length);

  await mkdir(DOWNLOADS_DIR, { recursive: true });
  for (let copy = 1; ; copy += 1) {
    const path = join(DOWNLOADS_DIR, copy === 1 ? cleaned : `${stem} (${copy})${extension}`);
    try {
      return { path, file: await open(path, "wx") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * Streams one upload to disk, so a big file never sits in memory. Returns the
 * saved name, or null when it passed `limit`; either way a failed upload
 * leaves nothing half-written behind.
 */
export async function saveUpload(
  name: string,
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | null> {
  const { path, file } = await safeDestination(name);
  let size = 0;
  let complete = false;
  try {
    // An empty file arrives with no body at all.
    for await (const chunk of body ?? []) {
      size += chunk.byteLength;
      if (size > limit) return null;
      await file.write(chunk);
    }
    complete = true;
  } finally {
    await file.close();
    if (!complete) await rm(path, { force: true });
  }

  await run([
    "notify-send",
    "--app-name=hypr-remote",
    "Received from phone",
    basename(path),
  ]);
  return basename(path);
}
