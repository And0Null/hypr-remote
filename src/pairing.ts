import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import QRCode from "qrcode";

import { CACHE_DIR, CONFIG_DIR } from "./env";

/**
 * Anyone on the same Wi-Fi can reach the port, so every socket and every
 * HTTP endpoint that does something needs this token. Kept on disk so a
 * paired phone stays paired across restarts; delete the file to unpair all.
 */
export async function loadToken(): Promise<string> {
  const path = join(CONFIG_DIR, "token");
  const file = Bun.file(path);
  if (await file.exists()) {
    const saved = (await file.text()).trim();
    if (saved.length >= 16) return saved;
  }
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(18).toString("base64url");
  await Bun.write(path, token);
  chmodSync(path, 0o600);
  return token;
}

export function tokenMatches(candidate: string | null, token: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The Wi-Fi/Ethernet address, skipping loopback and container bridges. */
export function lanAddress(): string {
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lo)/.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "localhost";
}

/**
 * Prints the pairing code in the terminal, and writes it as an image plus the
 * plain URL to ~/.cache/hypr-remote for the Quickshell control center tile.
 */
export async function publishPairing(url: string) {
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  await QRCode.toFile(join(CACHE_DIR, "pair.png"), url, {
    width: 360,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });
  await Bun.write(join(CACHE_DIR, "pair-url"), url);
  chmodSync(join(CACHE_DIR, "pair.png"), 0o600);
  chmodSync(join(CACHE_DIR, "pair-url"), 0o600);

  console.log(await QRCode.toString(url, { type: "terminal", small: true }));
  console.log(`Scan with your phone, or open:\n  ${url}\n`);
}
