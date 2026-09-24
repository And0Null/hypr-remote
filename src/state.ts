import { readSinks, readVolume, type Sink, type Volume } from "./features/audio";
import { readDesktop, type DesktopSnapshot } from "./features/desktop";
import { readInputSupport } from "./features/input";
import { readMedia, type Media } from "./features/media";
import { readStats, type Stats } from "./features/stats";
import {
  readBrightness,
  readNotifications,
  readRadios,
  type Notifications,
  type Radios,
} from "./features/system";
import type { Scene } from "./scenes";

/**
 * Everything the phone shows, split by how often it's worth re-reading.
 *
 * Fast: the desktop, volume and media — things you change and expect to see
 * move. Slow: outputs, radios, notifications, stats, and which optional tools
 * are installed — things that change rarely or only need to be roughly live.
 */
export type FastState = DesktopSnapshot & {
  volume: Volume | null;
  media: Media | null;
};

export type SlowState = {
  sinks: Sink[];
  brightness: number | null;
  notifications: Notifications;
  radios: Radios;
  stats: Stats;
  input: { keyboard: boolean; clicks: boolean };
};

export type State = FastState & SlowState & { scenes: Pick<Scene, "id" | "label">[] };

export async function readFast(): Promise<FastState> {
  const [desktop, volume, media] = await Promise.all([readDesktop(), readVolume(), readMedia()]);
  return { ...desktop, volume, media };
}

export async function readSlow(): Promise<SlowState> {
  const [sinks, brightness, notifications, radios, stats, input] = await Promise.all([
    readSinks(),
    readBrightness(),
    readNotifications(),
    readRadios(),
    readStats(),
    readInputSupport(),
  ]);
  return { sinks, brightness, notifications, radios, stats, input };
}
