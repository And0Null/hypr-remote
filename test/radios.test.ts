import { describe, expect, test } from "bun:test";

import { parseBluetoothDevices, parseDevices, parseQuickshellInstances } from "../src/features/radios";

describe("parseDevices", () => {
  test("names the Wi-Fi network and notices a cable", () => {
    const output = ["wifi:connected:Airtel_Wifi?", "loopback:connected (externally):lo", "ethernet:connected:Wired 1"].join("\n");
    expect(parseDevices(output)).toEqual({ wifi: "Airtel_Wifi?", wired: true });
  });

  test("unescapes colons in network names", () => {
    expect(parseDevices("wifi:connected:Cafe\\: guest").wifi).toBe("Cafe: guest");
  });

  test("ignores devices that aren't connected", () => {
    expect(parseDevices("wifi:disconnected:\nethernet:unavailable:")).toEqual({ wifi: null, wired: false });
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

describe("parseQuickshellInstances", () => {
  test("finds every running instance", () => {
    const output = "Instance p2y18kwylt:\n  Process ID: 90817\n\nInstance u2y18kwylt:\n  Process ID: 90822\n";
    expect(parseQuickshellInstances(output)).toEqual(["p2y18kwylt", "u2y18kwylt"]);
  });
});
