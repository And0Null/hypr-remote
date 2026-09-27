import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { CONFIG_DIR } from "./env";

/**
 * Every paired phone gets a token of its own in exchange for the pairing
 * code's, so one phone can be removed without re-pairing the rest. Only a
 * hash of each token is kept. Device tokens start "d_", which is how a phone
 * tells one from a pairing code it still has to exchange.
 */
const Device = z.object({
  id: z.string(),
  name: z.string(),
  hash: z.string(),
  paired: z.number(),
  seen: z.number(),
});

export type Device = z.infer<typeof Device>;

/** What a phone is shown: no hashes. */
export type DeviceView = Omit<Device, "hash">;

const FILE = join(CONFIG_DIR, "devices.json");
let devices: Device[] = [];

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

export async function loadDevices() {
  const parsed = z.array(Device).safeParse(await Bun.file(FILE).json().catch(() => null));
  devices = parsed.success ? parsed.data : [];
}

async function save() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await Bun.write(FILE, `${JSON.stringify(devices, null, 2)}\n`);
  chmodSync(FILE, 0o600);
}

/** The device a token belongs to, or null. */
export function findDevice(list: Device[], token: string | null): Device | null {
  if (!token?.startsWith("d_")) return null;
  const wanted = Buffer.from(hashOf(token));
  return list.find((device) => timingSafeEqual(Buffer.from(device.hash), wanted)) ?? null;
}

export const deviceFor = (token: string | null) => findDevice(devices, token);

/**
 * A new device and its token. `previous`, the token this phone had before,
 * is replaced rather than left as a second entry for the same phone.
 */
export function issueDevice(list: Device[], name: string, previous: string | null, now = Date.now()) {
  const token = `d_${randomBytes(24).toString("base64url")}`;
  const old = findDevice(list, previous);
  const device: Device = {
    id: old?.id ?? randomBytes(6).toString("hex"),
    name: name.trim().slice(0, 40) || "phone",
    hash: hashOf(token),
    paired: now,
    seen: now,
  };
  return { list: [...list.filter((candidate) => candidate !== old), device], device, token };
}

export async function addDevice(name: string, previous: string | null) {
  const issued = issueDevice(devices, name, previous);
  devices = issued.list;
  await save();
  return issued;
}

export async function removeDevice(id: string): Promise<boolean> {
  const before = devices.length;
  devices = devices.filter((device) => device.id !== id);
  if (devices.length === before) return false;
  await save();
  return true;
}

export async function clearDevices() {
  devices = [];
  await save();
}

/** Marks a device as seen now; written out at most once a minute per device. */
export function touchDevice(id: string) {
  const device = devices.find((candidate) => candidate.id === id);
  if (!device) return;
  const stale = Date.now() - device.seen > 60_000;
  device.seen = Date.now();
  if (stale) void save();
}

export function listDevices(): DeviceView[] {
  return devices.map(({ hash: _hash, ...view }) => view);
}
