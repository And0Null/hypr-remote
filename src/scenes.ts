import { mkdirSync, watch } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { CONFIG_DIR } from "./env";
import { readVolume, setVolume } from "./features/audio";
import { readBrightness, readNightLight, setBrightness, setNightLight, WARMTH } from "./features/display";
import { mediaCommand } from "./features/media";
import { readNotifications, setDnd } from "./features/notifications";

/**
 * A scene is a set of states applied in one tap. Every step sets an absolute
 * value rather than toggling, so tapping a scene twice leaves you in the same
 * place, and scenes can be tapped in any order. `nightLight` is a warmth in
 * kelvin, or false for true colour.
 */
const Scene = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,24}$/),
  label: z.string().max(24),
  volume: z.number().int().min(0).max(100).optional(),
  brightness: z.number().int().min(5).max(100).optional(),
  dnd: z.boolean().optional(),
  nightLight: z.union([z.literal(false), z.number().int().min(WARMTH.min).max(WARMTH.max)]).optional(),
  media: z.enum(["play", "pause"]).optional(),
});

export type Scene = z.infer<typeof Scene>;

export const DEFAULT_SCENES: Scene[] = [
  { id: "movie", label: "movie", brightness: 40, volume: 70, dnd: true, media: "play" },
  { id: "focus", label: "focus", volume: 25, dnd: true },
  { id: "night", label: "night", brightness: 15, volume: 20, dnd: true, nightLight: 3500 },
  { id: "away", label: "away", brightness: 5, volume: 0, dnd: true, media: "pause" },
];

const FILE = join(CONFIG_DIR, "scenes.json");

/**
 * Written out on first run so the scenes can be edited by hand. A file that
 * doesn't validate is reported and ignored rather than half-applied.
 */
export async function loadScenes(): Promise<Scene[]> {
  const file = Bun.file(FILE);
  if (!(await file.exists())) {
    await writeScenes(DEFAULT_SCENES);
    return DEFAULT_SCENES;
  }

  const parsed = z.array(Scene).max(12).safeParse(await file.json().catch(() => null));
  if (!parsed.success) {
    console.warn(`${FILE} is invalid; using the default scenes.`);
    return DEFAULT_SCENES;
  }
  return parsed.data;
}

async function writeScenes(scenes: Scene[]) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  await Bun.write(FILE, `${JSON.stringify(scenes, null, 2)}\n`);
}

/** Calls back with the new scenes whenever scenes.json is saved, by hand or not. */
export function watchScenes(onChange: (scenes: Scene[]) => void) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let pending: ReturnType<typeof setTimeout> | undefined;
  // The directory, not the file: editors save by replacing it.
  return watch(CONFIG_DIR, (_event, name) => {
    if (name !== "scenes.json") return;
    clearTimeout(pending);
    pending = setTimeout(async () => onChange(await loadScenes()), 150);
  });
}

/* -------------------------------------------------------------------------- */
/* Applying, undoing and saving                                               */
/* -------------------------------------------------------------------------- */

/** The settings a scene can change, as they are right now. */
export type Settings = {
  volume: number | null;
  // Per screen, so undo puts each one back where it was.
  brightness: { id: string; level: number | null }[];
  dnd: boolean | null;
  nightLight: number | false | null;
};

async function readSettings(): Promise<Settings> {
  const [volume, brightness, notifications, night] = await Promise.all([
    readVolume(),
    readBrightness(),
    readNotifications(),
    readNightLight(),
  ]);
  return {
    volume: volume?.level ?? null,
    brightness: brightness.screens.map(({ id, level }) => ({ id, level })),
    dnd: notifications?.dnd ?? null,
    nightLight: night ? (night.on ? night.temperature : false) : null,
  };
}

/**
 * Whether the desktop is as the scene would leave it. Brightness is judged on
 * the first screen alone (the laptop): external ones are slow to read.
 * Play and pause aren't compared, since media stops for reasons of its own.
 */
export function sceneMatches(scene: Scene, now: Settings): boolean {
  const checks: boolean[] = [];
  if (scene.volume !== undefined) checks.push(now.volume === scene.volume);
  if (scene.brightness !== undefined) {
    const first = now.brightness[0]?.level;
    // brightnessctl rounds to its own steps.
    checks.push(first != null && Math.abs(first - scene.brightness) <= 1);
  }
  if (scene.dnd !== undefined) checks.push(now.dnd === scene.dnd);
  if (scene.nightLight !== undefined) checks.push(now.nightLight === scene.nightLight);
  return checks.length > 0 && checks.every(Boolean);
}

// What the last scene replaced, so tapping it again can put it back. In memory
// only: after a restart, a lit scene just applies again.
let undo: { id: string; before: Settings } | null = null;

/** The scene that can be undone right now, if any. */
export const undoableScene = () => undo?.id ?? null;

/** Applies a scene, or undoes it if it's the one on and nothing's moved since. */
export async function tapScene(scene: Scene): Promise<"on" | "off"> {
  const now = await readSettings();
  if (undo?.id === scene.id && sceneMatches(scene, now)) {
    await restore(undo.before);
    undo = null;
    return "off";
  }
  undo = { id: scene.id, before: now };
  await applyScene(scene);
  return "on";
}

export async function applyScene(scene: Scene) {
  await Promise.all([
    scene.volume !== undefined && setVolume(scene.volume),
    scene.brightness !== undefined && setBrightness(scene.brightness),
    scene.dnd !== undefined && setDnd(scene.dnd),
    scene.nightLight !== undefined &&
      setNightLight(scene.nightLight === false ? { on: false } : { temperature: scene.nightLight }),
    scene.media !== undefined && mediaCommand(scene.media),
  ]);
}

async function restore(before: Settings) {
  await Promise.all([
    before.volume !== null && setVolume(before.volume),
    ...before.brightness.map(({ id, level }) => level !== null && setBrightness(level, id)),
    before.dnd !== null && setDnd(before.dnd),
    before.nightLight !== null &&
      setNightLight(before.nightLight === false ? { on: false } : { temperature: before.nightLight }),
  ]);
}

/**
 * Saves what's on now into a scene: volume, brightness (the laptop's), do not
 * disturb and night light. Play or pause stays as the scene had it.
 */
export async function saveScene(scenes: Scene[], id: string): Promise<Scene[] | null> {
  const scene = scenes.find((candidate) => candidate.id === id);
  if (!scene) return null;
  const now = await readSettings();
  const brightness = now.brightness[0]?.level;
  const updated: Scene = {
    ...scene,
    ...(now.volume !== null && { volume: now.volume }),
    ...(brightness != null && { brightness: Math.max(5, brightness) }),
    ...(now.dnd !== null && { dnd: now.dnd }),
    ...(now.nightLight !== null && { nightLight: now.nightLight }),
  };
  const next = scenes.map((candidate) => (candidate.id === id ? updated : candidate));
  await writeScenes(next);
  // The scene now matches, and there's nothing sensible to undo back to.
  if (undo?.id === id) undo = null;
  return next;
}
