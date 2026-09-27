import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { CONFIG_DIR } from "./env";
import { read } from "./run";

/**
 * Settings that belong to the laptop rather than one phone, so every paired
 * phone sees the same: the running-hot alert and its temperature, where files
 * sent from a phone land, and whether they open there.
 */
export const Preferences = z.strictObject({
  hotAlert: z.boolean(),
  hotAt: z.number().int().min(60).max(100),
  receiveTo: z.enum(["downloads", "desktop", "documents", "pictures"]),
  openReceived: z.boolean(),
});

export type Preferences = z.infer<typeof Preferences>;

export const DEFAULT_PREFERENCES: Preferences = {
  hotAlert: true,
  hotAt: 90,
  receiveTo: "downloads",
  openReceived: true,
};

const FILE = join(CONFIG_DIR, "preferences.json");
let current: Preferences = DEFAULT_PREFERENCES;

/** Saved preferences over the defaults; anything that doesn't fit is dropped. */
export function parsePreferences(saved: unknown): Preferences {
  const merged: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
  if (saved && typeof saved === "object") {
    for (const [key, value] of Object.entries(saved)) {
      const field = Preferences.shape[key as keyof Preferences];
      if (field?.safeParse(value).success) merged[key] = value;
    }
  }
  return Preferences.parse(merged);
}

export async function loadPreferences(): Promise<Preferences> {
  current = parsePreferences(await Bun.file(FILE).json().catch(() => null));
  return current;
}

export function preferences(): Preferences {
  return current;
}

export async function setPreferences(change: Partial<Preferences>) {
  current = Preferences.parse({ ...current, ...change });
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await Bun.write(FILE, `${JSON.stringify(current, null, 2)}\n`);
  chmodSync(FILE, 0o600);
}

const XDG_NAMES = { downloads: "DOWNLOAD", desktop: "DESKTOP", documents: "DOCUMENTS", pictures: "PICTURES" } as const;
const FALLBACK = { downloads: "Downloads", desktop: "Desktop", documents: "Documents", pictures: "Pictures" } as const;

/** The folder files from the phone go to, as the desktop names it. */
export async function receiveDir(): Promise<string> {
  const which = current.receiveTo;
  // With the folder unset, xdg-user-dir answers with the home folder.
  const named = await read(["xdg-user-dir", XDG_NAMES[which]]);
  return named && named !== homedir() ? named : join(homedir(), FALLBACK[which]);
}
