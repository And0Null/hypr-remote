import { describe, expect, test } from "bun:test";

import { parseBluetoothDevices, parseWifi } from "../src/features/radios";

describe("parseWifi", () => {
  test("names the Wi-Fi network", () => {
    const output = ["wifi:connected:Airtel_Wifi?", "loopback:connected (externally):lo", "ethernet:connected:Wired 1"].join("\n");
    expect(parseWifi(output)).toBe("Airtel_Wifi?");
  });

  test("unescapes colons in network names", () => {
    expect(parseWifi("wifi:connected:Cafe\\: guest")).toBe("Cafe: guest");
  });

  test("ignores devices that aren't connected", () => {
    expect(parseWifi("wifi:disconnected:\nethernet:connected:Wired 1")).toBeNull();
  });
});

describe("parseBluetoothDevices", () => {
  test("keeps the device names", () => {
    const output = "Device 61:13:D0:C7:1E:58 Airdopes Ace\nDevice 84:30:95:3F:54:4D Wireless Controller\n";
    expect(parseBluetoothDevices(output)).toEqual(["Airdopes Ace", "Wireless Controller"]);
  });

  test("is empty when nothing is connected", () => {
    expect(parseBluetoothDevices("")).toEqual([]);
  });
});
