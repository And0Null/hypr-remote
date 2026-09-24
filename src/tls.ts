import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR } from "./env";
import { run } from "./run";

/*
 * HTTPS is only needed for installing the remote as an app on the phone:
 * browsers refuse service workers, and so home-screen install, on a plain
 * http:// LAN address.
 *
 * There's no public certificate for 192.168.x.x, so this makes a private
 * certificate authority once, and from it a certificate for the current LAN
 * address. The phone trusts the authority (downloaded from /ca.crt) once, and
 * keeps trusting fresh certificates for new addresses without doing it again.
 */

const DIR = join(CONFIG_DIR, "tls");
const CA_KEY = join(DIR, "ca.key");
export const CA_CERT = join(DIR, "ca.crt");
const KEY = join(DIR, "server.key");
const CERT = join(DIR, "server.crt");
const FOR_ADDRESS = join(DIR, "server.address");

async function openssl(args: string[]) {
  const result = await run(["openssl", ...args], { timeoutMs: 15000 });
  if (result.code !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
}

async function ensureAuthority() {
  if (existsSync(CA_KEY) && existsSync(CA_CERT)) return;
  await openssl([
    "req", "-x509", "-new", "-nodes",
    "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-keyout", CA_KEY, "-out", CA_CERT, "-days", "3650",
    "-subj", "/CN=hypr-remote local authority",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
}

async function certificateIsCurrent(address: string): Promise<boolean> {
  if (!existsSync(CERT) || !existsSync(KEY) || !existsSync(FOR_ADDRESS)) return false;
  if ((await Bun.file(FOR_ADDRESS).text()).trim() !== address) return false;
  // Reissue a month before expiry.
  const expiring = await run(["openssl", "x509", "-checkend", "2592000", "-noout", "-in", CERT]);
  return expiring.code === 0;
}

/**
 * A certificate for `address`, reissued when the address changes or the old
 * one nears expiry. 397 days: the longest browsers accept.
 */
export async function ensureCertificate(address: string) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  await ensureAuthority();

  if (!(await certificateIsCurrent(address))) {
    const request = join(DIR, "server.csr");
    const extensions = join(DIR, "server.ext");
    await Bun.write(
      extensions,
      [
        `subjectAltName=IP:${address},DNS:localhost`,
        "basicConstraints=CA:FALSE",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=serverAuth",
      ].join("\n"),
    );
    await openssl([
      "req", "-new", "-nodes",
      "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", KEY, "-out", request, "-subj", "/CN=hypr-remote",
    ]);
    await openssl([
      "x509", "-req", "-in", request, "-CA", CA_CERT, "-CAkey", CA_KEY,
      "-CAcreateserial", "-out", CERT, "-days", "397", "-extfile", extensions,
    ]);
    await Bun.write(FOR_ADDRESS, address);
  }

  return { cert: Bun.file(CERT), key: Bun.file(KEY) };
}
