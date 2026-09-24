// Installs hypr-remote (and ydotoold, when present) as systemd user services,
// so the remote is up whenever you're logged in. Re-run after moving the repo.
// Undo with: systemctl --user disable --now hypr-remote ydotoold

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { run } from "../src/run";

const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const server = resolve(import.meta.dir, "..", "src", "server.ts");

const remoteUnit = `[Unit]
Description=hypr-remote: control Hyprland from your phone
After=graphical-session.target
# Keep retrying: at login Hyprland may not be up yet.
StartLimitIntervalSec=0

[Service]
ExecStart=${process.execPath} ${server}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;

// ydotoold is what turns clicks and scrolls into real input events. Run as
// you, not root, with a socket only you can use.
const ydotoolUnit = (binary: string) => `[Unit]
Description=ydotoold for hypr-remote clicks and scrolling

[Service]
ExecStart=${binary} --socket-path=%t/.ydotool_socket --socket-perm=0600
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;

async function systemctl(...args: string[]) {
  const result = await run(["systemctl", "--user", ...args]);
  if (result.code !== 0) throw new Error(`systemctl ${args.join(" ")}: ${result.stderr.trim()}`);
}

await mkdir(UNIT_DIR, { recursive: true });
await Bun.write(join(UNIT_DIR, "hypr-remote.service"), remoteUnit);
const units = ["hypr-remote.service"];

const ydotoold = Bun.which("ydotoold");
if (ydotoold) {
  await Bun.write(join(UNIT_DIR, "ydotoold.service"), ydotoolUnit(ydotoold));
  units.unshift("ydotoold.service");
} else {
  console.log("ydotoold not found: clicks and scrolling stay off. `sudo dnf install ydotool`, then re-run.");
}

await systemctl("daemon-reload");
await systemctl("enable", ...units);
// restart, not start: picks up a changed unit or code on re-runs.
await systemctl("restart", ...units);

console.log(`Enabled and started: ${units.join(", ")}`);
console.log("Logs: journalctl --user -u hypr-remote -f");
