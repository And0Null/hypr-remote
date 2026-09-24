import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { CONFIG_DIR } from "./env";
import { setVolume } from "./features/audio";
import { mediaCommand } from "./features/media";
import { setBrightness, setDnd } from "./features/system";

/**
 * A scene is a set of states applied in one tap. Every step sets an absolute
 * value rather than toggling, so tapping a scene twice leaves you in the same
 * place, and scenes can be tapped in any order.
 */
const Scene = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,24}$/),
  label: z.string().max(24),
  volume: z.number().int().min(0).max(100).optional(),
  brightness: z.number().int().min(5).max(100).optional(),
  dnd: z.boolean().optional(),
  media: z.enum(["play", "pause"]).optional(),
});

export type Scene = z.infer<typeof Scene>;

const DEFAULT_SCENES: Scene[] = [
  { id: "movie", label: "movie", brightness: 40, volume: 70, dnd: true, media: "play" },
  { id: "focus", label: "focus", volume: 25, dnd: true },
  { id: "night", label: "night", brightness: 15, volume: 20, dnd: true },
  { id: "day", label: "day", brightness: 80, volume: 50, dnd: false },
];

const FILE = join(CONFIG_DIR, "scenes.json");

/**
 * Written out on first run so the scenes can be edited by hand. A file that
 * doesn't validate is reported and ignored rather than half-applied.
 */
export async function loadScenes(): Promise<Scene[]> {
  const file = Bun.file(FILE);
  if (!(await file.exists())) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    await Bun.write(FILE, `${JSON.stringify(DEFAULT_SCENES, null, 2)}\n`);
    return DEFAULT_SCENES;
  }

  const parsed = z.array(Scene).max(12).safeParse(await file.json().catch(() => null));
  if (!parsed.success) {
    console.warn(`${FILE} is invalid; using the default scenes.`);
    return DEFAULT_SCENES;
  }
  return parsed.data;
}

export async function applyScene(scene: Scene) {
  await Promise.all([
    scene.volume !== undefined && setVolume(scene.volume),
    scene.brightness !== undefined && setBrightness(scene.brightness),
    scene.dnd !== undefined && setDnd(scene.dnd),
    scene.media !== undefined && mediaCommand(scene.media),
  ]);
}
