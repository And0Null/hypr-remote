import { read, run } from "../run";

/** `wifi.network` is the connection's name, which NetworkManager takes from the SSID. */
export type Radios = {
  wifi: { on: boolean; network: string | null } | null;
  bluetooth: { on: boolean; connected: string[] } | null;
};

export async function readRadios(): Promise<Radios> {
  const [radio, devices, bluetooth, connected] = await Promise.all([
    read(["nmcli", "radio", "wifi"]),
    read(["nmcli", "-t", "-f", "TYPE,STATE,CONNECTION", "device"]),
    read(["bluetoothctl", "show"]),
    read(["bluetoothctl", "devices", "Connected"]),
  ]);
  return {
    wifi: radio === null ? null : { on: radio === "enabled", network: parseWifi(devices ?? "") },
    bluetooth:
      bluetooth === null
        ? null
        : { on: /Powered:\s*yes/.test(bluetooth), connected: parseBluetoothDevices(connected ?? "") },
  };
}

/** `nmcli -t -f TYPE,STATE,CONNECTION device`: "wifi:connected:Home" per line. */
export function parseWifi(output: string): string | null {
  for (const line of output.split("\n")) {
    // Colons inside the name come escaped as "\:".
    const [type, state, ...name] = line.split(/(?<!\\):/);
    if (type === "wifi" && state === "connected") return name.join(":").replaceAll("\\:", ":");
  }
  return null;
}

/** `bluetoothctl devices Connected`: "Device AA:BB:CC:DD:EE:FF Airdopes Ace" per line. */
export function parseBluetoothDevices(output: string): string[] {
  return output
    .split("\n")
    .map((line) => /^Device\s+\S+\s+(.+)$/.exec(line.trim())?.[1])
    .filter((name): name is string => Boolean(name));
}

export async function setBluetooth(on: boolean) {
  await run(["bluetoothctl", "power", on ? "on" : "off"]);
}
