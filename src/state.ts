import {
  readMicMuted,
  readVolume,
  type Volume,
} from "./features/audio";
import { readClipboard, type Clipboard } from "./features/clipboard";
import { readDesktop, type DesktopSnapshot } from "./features/desktop";
import { readBrightness, readNightLight, type Brightness, type NightLight } from "./features/display";
import { readFiles, type Files } from "./features/files";
import { readInputSupport } from "./features/input";
import { readMedia, type Media } from "./features/media";
import { readNotifications, type Notifications } from "./features/notifications";
import { readRadios, type Radios } from "./features/radios";
import { readStats, type Stats } from "./features/stats";
import { sceneMatches, undoableScene, type Scene, type Settings } from "./scenes";

/**
 * Everything the phone shows, split by how often it's worth re-reading.
 *
 * Fast: the desktop, volume, microphone and media — things you change
 * and expect to see move. Slow: brightness, night light, radios,
 * notifications, stats, the clipboard, files to take, and which optional
 * tools are installed — things that change rarely, are slow to read (DDC), or
 * only need to be roughly live.
 */
export type FastState = DesktopSnapshot & {
  volume: Volume | null;
  mic: { muted: boolean } | null;
  media: Media | null;
};

export type SlowState = {
  brightness: Brightness;
  nightLight: NightLight;
  notifications: Notifications;
  radios: Radios;
  stats: Stats;
  input: { keyboard: boolean; clicks: boolean };
  clipboard: Clipboard;
  files: Files;
};

/**
 * Scenes as the phone shows them: `active` while the desktop matches one,
 * `undo` while tapping it again would put things back.
 */
export type SceneView = Scene & { active: boolean; undo: boolean };

export type State = FastState & SlowState & { scenes: SceneView[] };

export async function readFast(): Promise<FastState> {
  const [desktop, volume, micMuted, media] = await Promise.all([
    readDesktop(),
    readVolume(),
    readMicMuted(),
    readMedia(),
  ]);
  return { ...desktop, volume, mic: micMuted === null ? null : { muted: micMuted }, media };
}

export async function readSlow(): Promise<SlowState> {
  const [brightness, nightLight, notifications, radios, stats, input, files] = await Promise.all([
    readBrightness(),
    readNightLight(),
    readNotifications(),
    readRadios(),
    readStats(),
    readInputSupport(),
    readFiles(),
  ]);
  return { brightness, nightLight, notifications, radios, stats, input, clipboard: readClipboard(), files };
}

export function viewScenes(scenes: Scene[], fast: FastState, slow: SlowState): SceneView[] {
  const night = slow.nightLight;
  const now: Settings = {
    volume: fast.volume?.level ?? null,
    brightness: slow.brightness.screens,
    dnd: slow.notifications?.dnd ?? null,
    nightLight: night === null ? null : night.on ? night.temperature : false,
  };
  const undo = undoableScene();
  return scenes.map((scene) => {
    const active = sceneMatches(scene, now);
    return { ...scene, active, undo: active && undo === scene.id };
  });
}
