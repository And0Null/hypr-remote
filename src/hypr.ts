import { hyprSocket } from "./env";

/**
 * Talks to Hyprland's request socket directly instead of spawning hyprctl.
 * Same protocol hyprctl uses — write one command, read until Hyprland closes —
 * but without a process per call, which matters for the touchpad, where the
 * cursor moves sixty times a second.
 */
export function hyprRequest(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    Bun.connect({
      unix: hyprSocket("request"),
      socket: {
        open(socket) {
          socket.write(command);
        },
        data(_socket, chunk) {
          output += chunk.toString();
        },
        close() {
          resolve(output);
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}

export async function hyprJson<T>(command: string): Promise<T | null> {
  try {
    return JSON.parse(await hyprRequest(`j/${command}`)) as T;
  } catch {
    return null;
  }
}

/** Resolves true when Hyprland answers "ok". */
export async function dispatch(args: string): Promise<boolean> {
  try {
    return (await hyprRequest(`dispatch ${args}`)).trim() === "ok";
  } catch {
    return false;
  }
}

export type Monitor = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  focused: boolean;
  activeWorkspace: { id: number };
};

export type Client = {
  address: string;
  title: string;
  class: string;
  workspace: { id: number; name: string };
  monitor: number;
  focusHistoryID: number;
  fullscreen: number;
  floating: boolean;
};
