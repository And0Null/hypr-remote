import { dispatch } from "../hypr";
import { run } from "../run";

/**
 * Launched through Hyprland rather than as our child, so the lock screen
 * outlives this server and isn't killed if its service restarts.
 */
export async function lockScreen() {
  await dispatch("exec hyprlock");
}

/** Every screen dark or lit; audio and this remote carry on either way. */
export async function setScreens(on: boolean) {
  await dispatch(`dpms ${on ? "on" : "off"}`);
}

const SYSTEMCTL = { sleep: "suspend", restart: "reboot", "shut-down": "poweroff" } as const;
export type PowerOp = keyof typeof SYSTEMCTL;

/**
 * Each of these ends the connection to the phone, so the caller replies first
 * and this runs a moment later.
 */
export async function powerOff(op: PowerOp) {
  await run(["systemctl", SYSTEMCTL[op]]);
}
