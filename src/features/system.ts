import { dispatch } from "../hypr";
import { read, run } from "../run";

export async function changeBrightness(by: "up" | "down") {
  await run(["brightnessctl", "--quiet", "set", `5%${by === "up" ? "+" : "-"}`]);
}

export async function setBrightness(percent: number) {
  // Floor of 5%: a remote that can black out the laptop panel can also strand
  // you in front of a screen you can't read.
  await run(["brightnessctl", "--quiet", "set", `${Math.max(5, percent)}%`]);
}

export async function readBrightness(): Promise<number | null> {
  const [current, max] = await Promise.all([
    read(["brightnessctl", "get"]),
    read(["brightnessctl", "max"]),
  ]);
  if (!current || !max) return null;
  return Math.round((Number(current) / Number(max)) * 100);
}

/**
 * Launched through Hyprland rather than as our child, so the lock screen
 * outlives this server and isn't killed if its service restarts.
 */
export async function lockScreen() {
  await dispatch("exec hyprlock");
}

export type Notifications = { dnd: boolean; count: number } | null;

export async function readNotifications(): Promise<Notifications> {
  const [dnd, count] = await Promise.all([
    read(["swaync-client", "--get-dnd"]),
    read(["swaync-client", "--count"]),
  ]);
  if (dnd === null) return null;
  return { dnd: dnd === "true", count: Number(count ?? 0) };
}

export async function setDnd(on: boolean) {
  await run(["swaync-client", on ? "--dnd-on" : "--dnd-off"]);
}

export async function toggleDnd() {
  await run(["swaync-client", "--toggle-dnd"]);
}

export async function clearNotifications() {
  await run(["swaync-client", "--close-all"]);
}

export type Radios = { wifi: boolean | null; bluetooth: boolean | null };

export async function readRadios(): Promise<Radios> {
  const [wifi, bluetooth] = await Promise.all([
    read(["nmcli", "radio", "wifi"]),
    read(["bluetoothctl", "show"]),
  ]);
  return {
    wifi: wifi === null ? null : wifi === "enabled",
    bluetooth: bluetooth === null ? null : /Powered:\s*yes/.test(bluetooth),
  };
}

export async function setRadio(device: "wifi" | "bluetooth", on: boolean) {
  if (device === "wifi") await run(["nmcli", "radio", "wifi", on ? "on" : "off"]);
  else await run(["bluetoothctl", "power", on ? "on" : "off"]);
}
