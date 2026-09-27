import { CONFIG_DIR } from "../env";
import { dispatch } from "../hypr";
import { installed, read, run, shellQuote } from "../run";

/**
 * `wifi.network` is the connection's name, which NetworkManager takes from
 * the SSID. `wired` says whether Wi-Fi can go off without cutting the remote.
 */
export type Radios = {
  wifi: { on: boolean; network: string | null } | null;
  wired: boolean;
  bluetooth: { on: boolean; connected: string[] } | null;
};

export async function readRadios(): Promise<Radios> {
  const [radio, devices, bluetooth, connected] = await Promise.all([
    read(["nmcli", "radio", "wifi"]),
    read(["nmcli", "-t", "-f", "TYPE,STATE,CONNECTION", "device"]),
    read(["bluetoothctl", "show"]),
    read(["bluetoothctl", "devices", "Connected"]),
  ]);
  const links = parseDevices(devices ?? "");
  return {
    wifi: radio === null ? null : { on: radio === "enabled", network: links.wifi },
    wired: links.wired,
    bluetooth:
      bluetooth === null
        ? null
        : { on: /Powered:\s*yes/.test(bluetooth), connected: parseBluetoothDevices(connected ?? "") },
  };
}

/** `nmcli -t -f TYPE,STATE,CONNECTION device`: "wifi:connected:Home" per line. */
export function parseDevices(output: string): { wifi: string | null; wired: boolean } {
  let wifi: string | null = null;
  let wired = false;
  for (const line of output.split("\n")) {
    // Colons inside the name come escaped as "\:".
    const [type, state, ...name] = line.split(/(?<!\\):/);
    if (state !== "connected") continue;
    if (type === "wifi") wifi ??= name.join(":").replaceAll("\\:", ":");
    if (type === "ethernet") wired = true;
  }
  return { wifi, wired };
}

/** `bluetoothctl devices Connected`: "Device AA:BB:CC:DD:EE:FF Airdopes Ace" per line. */
export function parseBluetoothDevices(output: string): string[] {
  return output
    .split("\n")
    .map((line) => /^Device\s+\S+\s+(.+)$/.exec(line.trim())?.[1])
    .filter((name): name is string => Boolean(name));
}

export async function setRadio(device: "wifi" | "bluetooth", on: boolean) {
  if (device === "wifi") await run(["nmcli", "radio", "wifi", on ? "on" : "off"]);
  else await run(["bluetoothctl", "power", on ? "on" : "off"]);
}

/* -------------------------------------------------------------------------- */
/* The laptop's own Wi-Fi and Bluetooth menus                                  */
/* -------------------------------------------------------------------------- */

const FALLBACK = { wifi: "nm-connection-editor", bluetooth: "blueman-manager" } as const;
const MENUS_FILE = `${CONFIG_DIR}/menus.json`;

/**
 * Opens the laptop's menu for Wi-Fi or Bluetooth, in this order:
 * a command in ~/.config/hypr-remote/menus.json ({"wifi": "...", "bluetooth": "..."}),
 * then a running Quickshell with a control center, then the standard windows.
 * Returns false when there's nothing to open.
 */
export async function openMenu(which: "wifi" | "bluetooth"): Promise<boolean> {
  const command = (await configuredMenu(which)) ?? (await quickshellControlCenter()) ?? fallback(which);
  if (!command) return false;
  // Through Hyprland, so the window belongs to the session and not to us.
  return dispatch(`exec ${command}`);
}

async function configuredMenu(which: "wifi" | "bluetooth"): Promise<string | null> {
  const menus = await Bun.file(MENUS_FILE)
    .json()
    .catch(() => null);
  const command = menus?.[which];
  return typeof command === "string" && command.trim() ? command : null;
}

/** A Quickshell instance that answers `controlcenter open` over IPC. */
async function quickshellControlCenter(): Promise<string | null> {
  const qs = installed("qs") ? "qs" : installed("quickshell") ? "quickshell" : null;
  if (!qs) return null;
  const list = await read([qs, "list", "--all"]);
  for (const id of parseQuickshellInstances(list ?? "")) {
    const targets = await read([qs, "ipc", "-i", id, "show"]);
    if (targets && /target controlcenter\n(?:\s+function .*\n)*?\s+function open\(\)/.test(`${targets}\n`)) {
      return `${qs} ipc -i ${shellQuote(id)} call controlcenter open`;
    }
  }
  return null;
}

/** `qs list --all`: "Instance u2y18kwylt:" per running instance. */
export function parseQuickshellInstances(output: string): string[] {
  return [...output.matchAll(/^Instance (\w+):/gm)].map((match) => match[1]!);
}

function fallback(which: "wifi" | "bluetooth"): string | null {
  return installed(FALLBACK[which]) ? FALLBACK[which] : null;
}
