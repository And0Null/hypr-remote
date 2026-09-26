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
import { watchAudioAndMedia } from "./watch";

const HTTP_PORT = Number(process.env.PORT ?? 4000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 4443);
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const UPLOAD_LIMIT = 512 * 1024 * 1024;
// Opt back into pairing over plain HTTP even while HTTPS runs.
const ALLOW_HTTP = process.env.HYPR_REMOTE_ALLOW_HTTP === "1";

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

// Reads overlap (timers, events, actions) and an older one can finish last.
// Each read is numbered as it starts, and its result is kept only if no newer
// read of the same kind has landed, so stale state never replaces fresh.
const started = { fast: 0, slow: 0 };
const landed = { fast: 0, slow: 0 };

async function refresh(which: "fast" | "slow" | "both") {
  if (clients.size === 0) return;
  const fastRead = which !== "slow" ? ++started.fast : 0;
  const slowRead = which !== "fast" ? ++started.slow : 0;
  const [nextFast, nextSlow] = await Promise.all([
    fastRead ? readFast() : null,
    slowRead ? readSlow() : null,
  ]);
  if (nextFast && fastRead > landed.fast) {
    fast = nextFast;
    landed.fast = fastRead;
  }
  if (nextSlow && slowRead > landed.slow) {
    slow = nextSlow;
    landed.slow = slowRead;
  }
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
  // One failure can fire both close and error; each would schedule its own
  // reconnect, doubling the connections every time Hyprland restarts.
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
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

// Volume, sound output and media arrive live too, while a phone is connected.
const audioAndMedia = watchAudioAndMedia((stale) => void refresh(stale));

// Only a fallback now: events cover what changes fast.
setInterval(() => void refresh("fast"), 5000);
setInterval(() => void refresh("slow"), 10_000);
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
  ".woff2": "font/woff2",
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
      // The page and worker must never be stale; icons and fonts may be cached.
      "Cache-Control": type.startsWith("image/") || type.startsWith("font/") ? "max-age=86400" : "no-store",
    },
  });
}

/**
 * The token comes in the x-token header, which stays out of history and logs.
 * Only /ws passes `url` to allow ?t=: browsers can't set WebSocket headers.
 */
function authorised(request: Request, url?: URL) {
  return tokenMatches(url?.searchParams.get("t") ?? request.headers.get("x-token"), token);
}

// Set once HTTPS is up. From then on the token, and with it typing on this
// laptop, never crosses plain HTTP, where anyone on the Wi-Fi can read it.
let httpsRunning = false;
const PAIRED_PATHS = new Set(["/ws", "/screen", "/upload"]);

async function handle(request: Request, server: Server<undefined>): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (PAIRED_PATHS.has(url.pathname) && httpsRunning && !ALLOW_HTTP && server.url.protocol === "http:") {
    return new Response("Plain HTTP is off: open the https:// address, or re-scan the QR code.", {
      status: 403,
    });
  }

  if (url.pathname === "/ws") {
    if (!authorised(request, url)) return new Response("Not paired", { status: 401 });
    return server.upgrade(request)
      ? undefined
      : new Response("Expected a WebSocket", { status: 400 });
  }

  // 2.2 — a live look at one monitor.
  if (url.pathname === "/screen") {
    if (!authorised(request)) return new Response("Not paired", { status: 401 });
    const image = await captureMonitor(url.searchParams.get("m") ?? "");
    return image
      ? new Response(image, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } })
      : new Response("No such monitor", { status: 404 });
  }

  // 2.3 — files from the phone land in ~/Downloads. One file per request, as
  // the raw body, streamed to disk; the name comes URI-encoded in a header.
  if (url.pathname === "/upload" && request.method === "POST") {
    if (!authorised(request)) return new Response("Not paired", { status: 401 });
    let name: string;
    try {
      name = decodeURIComponent(request.headers.get("x-filename") ?? "");
    } catch {
      return new Response("Bad file name", { status: 400 });
    }
    try {
      const saved = await saveUpload(name, request.body, UPLOAD_LIMIT);
      return saved ? Response.json({ saved }) : new Response("Too large", { status: 413 });
    } catch (error) {
      console.warn("Upload failed:", error);
      return new Response("Upload failed", { status: 500 });
    }
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
    return Response.json({ httpsPort: HTTPS_PORT, address, httpAllowed: !httpsRunning || ALLOW_HTTP });
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
    audioAndMedia.start();
    // A fresh phone needs a full picture now, not on the next tick.
    void refresh("both").then(() => broadcast(true));
  },
  close(socket: ServerWebSocket<undefined>) {
    clients.delete(socket);
    if (clients.size === 0) audioAndMedia.stop();
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

// Bun's cap has to admit an upload; /upload enforces the real limit while it
// streams, and no other route reads a body.
const common = { fetch: handle, websocket, maxRequestBodySize: UPLOAD_LIMIT };

// Listen on the LAN address only, not every interface (VPNs, containers).
// That ties the sockets to this network; the address check below restarts us
// on a new one.
const hostname = address;

// HTTPS first, so plain HTTP knows from its first request whether to refuse
// the token.
try {
  Bun.serve({ ...common, port: HTTPS_PORT, hostname, tls: await ensureCertificate(address) });
  httpsRunning = true;
} catch (error) {
  console.warn("HTTPS disabled:", error instanceof Error ? error.message : error);
}

Bun.serve({ ...common, port: HTTP_PORT, hostname });

console.log("\nhypr-remote is running.\n");
if (httpsRunning) {
  await publishPairing(`https://${address}:${HTTPS_PORT}/?t=${token}`);
} else {
  console.warn("Pairing over plain HTTP: anyone on this Wi-Fi can read the token.\n");
  await publishPairing(`http://${address}:${HTTP_PORT}/?t=${token}`);
}
console.log("Phone and laptop must be on the same Wi-Fi.");

// A new network means a new address: the pairing code and certificate are
// both for the old one, and the sockets listen on it. Under systemd, restart
// to reissue them and listen on the new one.
setInterval(() => {
  if (lanAddress() === address) return;
  console.log(`Address changed to ${lanAddress()}.${UNDER_SYSTEMD ? "" : " Restart hypr-remote to follow it."}`);
  if (UNDER_SYSTEMD) process.exit(0);
}, 30_000);
