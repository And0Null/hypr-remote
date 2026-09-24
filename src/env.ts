import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Makes the process look like it was started from inside the desktop session.
 *
 * Launched from a terminal, it already is. Launched by systemd at login it
 * isn't: `hyprctl` refuses to run without HYPRLAND_INSTANCE_SIGNATURE, and
 * wl-copy, grim and wtype need WAYLAND_DISPLAY. Both are discovered from the
 * runtime directory and written into process.env, so every child inherits them.
 *
 * Called again whenever the Hyprland socket drops, because restarting Hyprland
 * gives it a new signature.
 */
export function prepareEnvironment(): boolean {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
  process.env.XDG_RUNTIME_DIR = runtime;

  const hyprDir = join(runtime, "hypr");
  if (existsSync(hyprDir)) {
    // The newest live instance wins; stale directories outlive crashed sessions.
    const newest = readdirSync(hyprDir)
      .filter((name) => existsSync(join(hyprDir, name, ".socket.sock")))
      .map((name) => ({ name, time: statSync(join(hyprDir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)[0];
    if (newest) process.env.HYPRLAND_INSTANCE_SIGNATURE = newest.name;
  }

  if (!process.env.WAYLAND_DISPLAY) {
    const display = readdirSync(runtime).find((name) => /^wayland-\d+$/.test(name));
    if (display) process.env.WAYLAND_DISPLAY = display;
  }

  // ydotool's daemon socket, as installed by `bun run install-service`.
  process.env.YDOTOOL_SOCKET ??= join(runtime, ".ydotool_socket");

  return Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);
}

export function hyprSocket(kind: "request" | "events"): string {
  return join(
    process.env.XDG_RUNTIME_DIR!,
    "hypr",
    process.env.HYPRLAND_INSTANCE_SIGNATURE ?? "",
    kind === "request" ? ".socket.sock" : ".socket2.sock",
  );
}

export const CONFIG_DIR = join(homedir(), ".config", "hypr-remote");
export const CACHE_DIR = join(homedir(), ".cache", "hypr-remote");
export const DOWNLOADS_DIR = join(homedir(), "Downloads");
