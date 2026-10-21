import { randomBytes } from "node:crypto";

import { addDevice, deviceFor } from "./devices";

/**
 * Short-lived, single-use launch codes. A paired phone asks the server for a
 * manifest and gets one of these in its `start_url` instead of its reusable
 * device token, so an installed iOS web app can be handed off once without the
 * token living in the launch URL forever. Re-pairing the browser later never
 * touches the device the installed app redeemed, because redemption mints an
 * independent device.
 */

const TTL_MS = 10 * 60 * 1000;

type Record = {
  code: string;
  device: string | null;
  created: number;
  used: boolean;
};

const codes = new Map<string, Record>();

function prune() {
  const now = Date.now();
  for (const [key, rec] of codes) {
    if (rec.used || now - rec.created > TTL_MS) codes.delete(key);
  }
}

/**
 * Mint a launch code for a request that already proved it is a paired device.
 * Returns the code to embed in `start_url`.
 */
export function issueLaunchCode(deviceToken: string | null): string {
  prune();
  const code = `l_${randomBytes(12).toString("base64url")}`;
  const device = deviceToken ? deviceFor(deviceToken) : null;
  codes.set(code, { code, device: device?.id ?? null, created: Date.now(), used: false });
  return code;
}

/**
 * Redeem a launch code for a fresh device token. Single-use: a second call with
 * the same code returns null. Returns the new device token, or null when the code
 * is unknown, expired, or already used.
 */
export async function redeemLaunchCode(code: string | null, name: string): Promise<string | null> {
  if (typeof code !== "string" || !code.startsWith("l_")) return null;
  const rec = codes.get(code);
  if (!rec || rec.used) return null;
  if (Date.now() - rec.created > TTL_MS) {
    codes.delete(code);
    return null;
  }
  rec.used = true;
  const { token: own } = await addDevice(name, null);
  return own;
}

/** Test helper: drop every issued code. */
export function clearLaunchCodes(): void {
  codes.clear();
}

export { issueLaunchCode as issueLaunch, issueLaunchCode as mintLaunchCode };
export { redeemLaunchCode as redeem, redeemLaunchCode as redeemLaunch, redeemLaunchCode as exchangeLaunchCode };
export { clearLaunchCodes as clearLaunches };
