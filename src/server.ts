import { extname, join, normalize } from "node:path";

import type { Server, ServerWebSocket } from "bun";

import { Action, runAction, type Reply } from "./actions";
import { hyprSocket, prepareEnvironment } from "./env";
import { captureMonitor } from "./features/screen";
import { saveUpload } from "./features/send";
import { lanAddress, loadToken, publishPairing, tokenMatches } from "./pairing";
import { loadScenes } from "./scenes";
import { readFast, readSlow, type FastState, type SlowState } from "./state";
import { CA_CERT, ensureCertificate } from "./tls";

const HTTP_PORT = Number(process.env.PORT ?? 4000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 4443);
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const UPLOAD_LIMIT = 512 * 1024 * 1024;

// Under systemd, exiting is how we restart: it relaunches us with fresh state.
const UNDER_SYSTEMD = Boolean(process.env.INVOCATION_ID);

if (!prepareEnvironment()) {
  console.error("No running Hyprland session found.");
  // Non-zero so systemd retries until Hyprland is up after login.
  process.exit(1);
}

const token = await loadToken();
const scenes = await loadScenes();
const address = lanAddress();

/* -------------------------------------------------------------------------- */
/* Live state                                                                 */
/* -------------------------------------------------------------------------- */

const clients = new Set<ServerWebSocket<undefined>>();
let fast: FastState | null = null;
let slow: SlowState | null = null;
let lastSent = "";

function send(socket: ServerWebSocket<undefined>, message: unknown) {
  socket.send(JSON.stringify(message));
}

/** Sends state to every phone, but only when something in it changed. */
function broadcast(force = false) {
  if (!fast || !slow) return;
  const message = JSON.stringify({
    type: "state",
    state: { ...fast, ...slow, scenes: scenes.map(({ id, label }) => ({ id, label })) },
  });
  if (!force && message === lastSent) return;
  lastSent = message;
  for (const client of clients) client.send(message);
}

async function refresh(which: "fast" | "slow" | "both") {
  if (clients.size === 0) return;
  const [nextFast, nextSlow] = await Promise.all([
    which !== "slow" ? readFast() : fast,
    which !== "fast" ? readSlow() : slow,
  ]);
  fast = nextFast;
  slow = nextSlow;
  broadcast();
}

// Bursts of Hyprland events (a workspace switch fires several) become one read.
let pendingRefresh: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh() {
  clearTimeout(pendingRefresh);
  pendingRefresh = setTimeout(() => void refresh("fast"), 40);
}

/** Workspace and window changes arrive from Hyprland the instant they happen. */
async function followHyprland() {
  const retry = () => {
    // A restarted Hyprland has a new signature, so look it up again.
    prepareEnvironment();
    setTimeout(followHyprland, 2000);
  };
  try {
    await Bun.connect({
      unix: hyprSocket("events"),
      socket: {
        data: scheduleRefresh,
        close: retry,
        error: retry,
      },
    });
  } catch {
    retry();
  }
}

setInterval(() => void refresh("fast"), 1500);
setInterval(() => void refresh("slow"), 4000);
void followHyprland();

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Files from public/, and nothing that resolves outside it. */
async function serveStatic(pathname: string): Promise<Response | null> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = normalize(join(PUBLIC_DIR, relative));
  const type = STATIC_TYPES[extname(path)];
  if (!path.startsWith(PUBLIC_DIR + "/") || !type) return null;

  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return new Response(file, {
    headers: {
      "Content-Type": type,
      // The page and worker must never be stale; icons may be cached.
      "Cache-Control": type.startsWith("image/") ? "max-age=86400" : "no-store",
    },
  });
}

function authorised(request: Request, url: URL) {
  return tokenMatches(url.searchParams.get("t") ?? request.headers.get("x-token"), token);
}

async function handle(request: Request, server: Server<undefined>): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (url.pathname === "/ws") {
    if (!authorised(request, url)) return new Response("Not paired", { status: 401 });
    return server.upgrade(request)
      ? undefined
      : new Response("Expected a WebSocket", { status: 400 });
  }

  // 2.2 — a live look at one monitor.
  if (url.pathname === "/screen") {
    if (!authorised(request, url)) return new Response("Not paired", { status: 401 });
    const image = await captureMonitor(url.searchParams.get("m") ?? "");
    return image
      ? new Response(image, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } })
      : new Response("No such monitor", { status: 404 });
  }

  // 2.3 — files from the phone land in ~/Downloads.
  if (url.pathname === "/upload" && request.method === "POST") {
    if (!authorised(request, url)) return new Response("Not paired", { status: 401 });
    const form = await request.formData().catch(() => null);
    const files = form?.getAll("file").filter((entry): entry is File => entry instanceof File) ?? [];
    if (files.length === 0) return Response.json({ saved: [] }, { status: 400 });
    const saved = [];
    for (const file of files) saved.push(await saveUpload(file));
    return Response.json({ saved });
  }

  // 4.3 — the certificate authority the phone installs to trust HTTPS. Public
  // by design: a certificate is not a secret; its private key never leaves
  // ~/.config/hypr-remote.
  if (url.pathname === "/ca.crt") {
    return new Response(Bun.file(CA_CERT), {
      headers: {
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition": 'attachment; filename="hypr-remote-ca.crt"',
      },
    });
  }

  if (url.pathname === "/config.json") {
    return Response.json({ httpsPort: HTTPS_PORT, address });
  }

  if (request.method === "GET") {
    const file = await serveStatic(url.pathname);
    if (file) return file;
  }

  return new Response("Not found", { status: 404 });
}

const websocket = {
  open(socket: ServerWebSocket<undefined>) {
    clients.add(socket);
    // A fresh phone needs a full picture now, not on the next tick.
    void refresh("both").then(() => broadcast(true));
  },
  close(socket: ServerWebSocket<undefined>) {
    clients.delete(socket);
  },
  async message(socket: ServerWebSocket<undefined>, raw: string | Buffer) {
    let json: unknown;
    try {
      json = JSON.parse(String(raw));
    } catch {
      return;
    }
    const parsed = Action.safeParse(json);
    if (!parsed.success) return;

    try {
      const { changed, reply } = await runAction(parsed.data, scenes);
      if (reply) send(socket, reply satisfies Reply);
      if (changed) await refresh("both");
    } catch (error) {
      console.warn(`${parsed.data.type} failed:`, error);
    }
  },
};

const common = { fetch: handle, websocket, maxRequestBodySize: UPLOAD_LIMIT };

Bun.serve({ ...common, port: HTTP_PORT, hostname: "0.0.0.0" });

try {
  Bun.serve({ ...common, port: HTTPS_PORT, hostname: "0.0.0.0", tls: await ensureCertificate(address) });
} catch (error) {
  // HTTPS is only for installing as an app; everything else works without it.
  console.warn("HTTPS disabled:", error instanceof Error ? error.message : error);
}

console.log("\nhypr-remote is running.\n");
await publishPairing(`http://${address}:${HTTP_PORT}/?t=${token}`);
console.log("Phone and laptop must be on the same Wi-Fi.");

// A new network means a new address: the pairing code and certificate are
// both for the old one. Under systemd, restart to reissue them.
setInterval(() => {
  if (lanAddress() === address) return;
  console.log(`Address changed to ${lanAddress()}.`);
  if (UNDER_SYSTEMD) process.exit(0);
}, 30_000);
