import { existsSync, mkdirSync } from "node:fs";
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
 * A name that's safe to write and doesn't overwrite anything: path parts and
 * odd characters are stripped, and "photo (2).jpg" style suffixes avoid
 * clobbering an existing file.
 */
function safeDestination(original: string): string {
  const cleaned = basename(original).replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "") || "file";
  const extension = extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - extension.length);

  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  let candidate = join(DOWNLOADS_DIR, cleaned);
  for (let copy = 2; existsSync(candidate); copy += 1) {
    candidate = join(DOWNLOADS_DIR, `${stem} (${copy})${extension}`);
  }
  return candidate;
}

export async function saveUpload(file: File): Promise<string> {
  const destination = safeDestination(file.name);
  await Bun.write(destination, file);
  await run([
    "notify-send",
    "--app-name=hypr-remote",
    "Received from phone",
    basename(destination),
  ]);
  return basename(destination);
}
