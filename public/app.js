// @ts-check
// hypr-remote phone client. Plain JS, no build step: the server serves this
// file as-is. The JSDoc types come from the server, so `bun run check` catches
// the two drifting apart.

/** @typedef {import("../src/actions").Action} Action */
/** @typedef {import("../src/actions").Reply} Reply */
/** @typedef {import("../src/state").State} State */
/** @typedef {{ type: "state"; state: State } | Reply} Message */

// Every id looked up is in index.html; a missing one is a bug, not a state.
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const pad2 = (/** @type {number} */ n) => String(n).padStart(2, "0");

/* -------------------------------------------------------------------------- */
/* Pairing                                                                    */
/* -------------------------------------------------------------------------- */

// The terminal's QR code carries ?t=<token>. Keep it, then drop it from the
// address bar so it isn't left in screenshots or history.
const params = new URLSearchParams(location.search);
/**
 * @param {"get" | "set"} action
 * @param {string | null} [value]
 */
function storage(action, value) {
  try {
    if (action === "get") return localStorage.getItem("hypr-remote-token");
    localStorage.setItem("hypr-remote-token", /** @type {string} */ (value));
  } catch {
    return null;
  }
}
if (params.get("t")) {
  storage("set", params.get("t"));
  history.replaceState(null, "", location.pathname);
}
const token = storage("get") ?? params.get("t");

// On plain http: where the secure version is, and whether this page may use
// the token at all (not once the laptop runs https).
const config = location.protocol === "http:" ? fetch("/config.json").then((r) => r.json()) : null;

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

/** @type {WebSocket | null} */
let socket = null;
let retry = 500;
let everOpened = false;
// Unset until the first state message; only the touchpad reads it before then.
/** @type {State} */
let state;

/** @param {string} text */
function showBanner(text) {
  $("banner").textContent = text;
  $("banner").dataset.show = text ? "true" : "false";
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;
/** @param {string} text */
function toast(text) {
  $("toast").textContent = text;
  $("toast").dataset.show = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").dataset.show = "false"), 1800);
}

function connect() {
  if (!token) {
    showBanner("not paired. scan the qr code in the terminal, or in the control center on your laptop.");
    return;
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/ws?t=${encodeURIComponent(token)}`);

  socket.onopen = () => {
    everOpened = true;
    retry = 500;
    $("status").dataset.live = "true";
    $("status-text").textContent = "live";
    showBanner("");
  };

  socket.onmessage = (event) => {
    /** @type {Message} */
    const message = JSON.parse(event.data);
    if (message.type === "state") render(message.state);
    if (message.type === "toast") toast(message.text);
    if (message.type === "clipboard") receiveClipboard(message.text);
  };

  socket.onclose = () => {
    $("status").dataset.live = "false";
    $("status-text").textContent = "offline";
    // Refused before ever opening is almost always a stale token.
    if (!everOpened) showBanner("couldn't connect. if the laptop is on, re-scan its qr code to pair again.");
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
}

/**
 * The old http:// address can't pair any more; point at the secure one.
 * @param {{ address: string; httpsPort: number }} config
 */
function guideToSecure({ address, httpsPort }) {
  if (!token) return connect(); // shows "not paired"
  $("status-text").textContent = "offline";
  showBanner("this is the old http address, which would show your pairing to the whole wi-fi. ");
  const link = document.createElement("a");
  link.href = `https://${address}:${httpsPort}/?t=${encodeURIComponent(token)}`;
  link.textContent = "open the secure version";
  $("banner").append(
    link,
    " or re-scan the qr code. if the browser warns about the certificate, continue anyway, " +
      "or install the certificate from the bridge tab first.",
  );
}

/**
 * @param {Action} action
 * @param {{ buzz?: boolean }} [options]
 */
function send(action, { buzz = true } = {}) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(action));
  if (buzz) navigator.vibrate?.(8);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                       */
/* -------------------------------------------------------------------------- */

/** @param {string} name */
function showTab(name) {
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[role=tab]")).forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  });
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".tab")).forEach((section) => {
    section.dataset.active = String(section.id === `tab-${name}`);
  });
  try {
    localStorage.setItem("hypr-remote-tab", name);
  } catch {}
  updateScreenPolling();
}

/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[role=tab]")).forEach((tab) =>
  tab.addEventListener("click", () => showTab(/** @type {string} */ (tab.dataset.tab))),
);
try {
  showTab(localStorage.getItem("hypr-remote-tab") ?? "desk");
} catch {}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} id
 * @param {number | null} percent
 */
function setMeter(id, percent, alert = false) {
  const meter = $(id);
  meter.dataset.alert = String(alert);
  /** @type {HTMLElement} */ (meter.firstElementChild).style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
}

// Sliders are left alone while a finger is on them, or the next state update
// would yank the thumb back mid-drag.
const dragging = new Set();
/**
 * @param {string} id
 * @param {number | null | undefined} value
 */
function setSlider(id, value) {
  const slider = /** @type {HTMLInputElement} */ ($(id));
  if (dragging.has(id) || value == null) return;
  slider.value = String(value);
  const [min, max] = [Number(slider.min), Number(slider.max)];
  slider.style.setProperty("--fill", `${((value - min) / (max - min)) * 100}%`);
}

/** @param {State} next */
function render(next) {
  state = next;
  renderDesk();
  renderControl();
  renderBridge();
  renderInput();
}

function renderDesk() {
  $("workspace").textContent = state.activeWorkspace ? pad2(state.activeWorkspace) : "--";
  $("window").textContent = state.activeWindow ?? "—";
  renderTiles($("workspaces"), { actions: true });
  renderWindows();
  renderMedia();
}

/* -------------------------------------------------------------------------- */
/* Desk: workspaces                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The workspaces worth a tile: every one with windows or on a screen, then the
 * lowest free number, to start a new one.
 */
function workspaceIds() {
  const ids = new Set(state.workspaces.filter((w) => w.windows > 0).map((w) => w.id));
  for (const monitor of state.monitors) if (monitor.workspace > 0) ids.add(monitor.workspace);
  if (state.activeWorkspace && state.activeWorkspace > 0) ids.add(state.activeWorkspace);
  return [...ids, freeWorkspace(ids)].sort((a, b) => a - b);
}

/** @param {Set<number>} taken */
function freeWorkspace(taken) {
  let id = 1;
  while (taken.has(id)) id++;
  return id;
}

/**
 * The name a workspace was given in Hyprland, or null for a plain numbered one.
 * @param {number} id
 */
function workspaceName(id) {
  const name = state.workspaces.find((w) => w.id === id)?.name;
  return name && name !== String(id) ? name : null;
}

/** @param {number} id */
const workspaceLabel = (id) => workspaceName(id) ?? String(id);

/**
 * What's on a workspace, as the app used there most recently. Windows arrive
 * most recent first within each workspace.
 * @param {number} id
 */
const workspaceApp = (id) => state.windows.find((w) => w.workspace === id)?.app ?? "";

/**
 * Fills a grid of workspace tiles: the one on the desk, or the drop strip
 * shown while a window is dragged. Tiles with `actions` switch on tap.
 * @param {HTMLElement} grid
 * @param {{ actions: boolean }} options
 */
function renderTiles(grid, { actions }) {
  const ids = workspaceIds();
  const occupied = new Set(state.workspaces.filter((w) => w.windows > 0).map((w) => w.id));
  const elsewhere = new Set(state.monitors.filter((m) => !m.focused).map((m) => m.workspace));
  /** @param {number} id */
  const hint = (id) => workspaceApp(id) || (occupied.has(id) || elsewhere.has(id) ? "" : "new");

  // Rebuilt only when the tiles themselves change, so one being held isn't
  // replaced under the finger.
  const key = ids.map((id) => `${id}:${workspaceLabel(id)}:${hint(id)}`).join();
  if (grid.dataset.key !== key) {
    grid.dataset.key = key;
    grid.replaceChildren(
      ...ids.map((id) => {
        const button = document.createElement("button");
        const label = document.createElement("span");
        label.className = "num truncate";
        label.textContent = workspaceLabel(id);
        const app = document.createElement("span");
        app.className = "app truncate";
        app.textContent = hint(id);
        button.append(label, app);
        button.setAttribute("aria-label", `workspace ${workspaceName(id) ?? id}${hint(id) ? `, ${hint(id)}` : ""}`);
        if (actions) button.dataset.action = JSON.stringify({ type: "workspace", id });
        button.dataset.id = String(id);
        button.dataset.drop = "true";
        return button;
      }),
    );
  }
  grid.querySelectorAll("button").forEach((button) => {
    const id = Number(button.dataset.id);
    button.dataset.active = String(id === state.activeWorkspace);
    button.dataset.occupied = String(occupied.has(id));
    button.dataset.visible = String(elsewhere.has(id) && id !== state.activeWorkspace);
  });
}

/**
 * Swipe across the card for the next or previous workspace with windows; hold
 * a tile to send the focused window there.
 */
function wireWorkspaceCard() {
  const card = $("workspaces-card");
  /** @type {{ x: number; y: number } | null} */
  let start = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let holdTimer;
  // A swipe or hold that ends on a tile mustn't also count as a tap on it.
  let swallowClick = false;

  card.addEventListener("pointerdown", (event) => {
    swallowClick = false;
    start = { x: event.clientX, y: event.clientY };
    clearTimeout(holdTimer);
    /** @type {HTMLElement | null} */
    const tile = /** @type {Element} */ (event.target).closest("#workspaces button");
    if (!tile) return;
    holdTimer = setTimeout(() => {
      start = null;
      swallowClick = true;
      tile.dataset.holding = "true";
      setTimeout(() => (tile.dataset.holding = "false"), 250);
      moveFocusedTo(Number(tile.dataset.id));
    }, 500);
  });

  card.addEventListener("pointermove", (event) => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clearTimeout(holdTimer);
  });

  card.addEventListener("pointerup", (event) => {
    clearTimeout(holdTimer);
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swallowClick = true;
      stepWorkspace(dx < 0 ? 1 : -1);
    }
  });

  card.addEventListener("pointercancel", () => {
    clearTimeout(holdTimer);
    start = null;
  });

  card.addEventListener(
    "click",
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
    },
    true,
  );
  card.addEventListener("contextmenu", (event) => event.preventDefault());
}
wireWorkspaceCard();

/** @param {1 | -1} direction */
function stepWorkspace(direction) {
  const current = state?.activeWorkspace;
  if (!current) return;
  const occupied = state.workspaces.filter((w) => w.windows > 0).map((w) => w.id);
  const next = direction > 0 ? occupied.find((id) => id > current) : occupied.findLast((id) => id < current);
  if (next) send({ type: "workspace", id: next });
  else navigator.vibrate?.([10, 60, 10]);
}

/** @param {number} id */
function moveFocusedTo(id) {
  const focused = state?.windows.find((w) => w.focused);
  if (!focused) return toast("no window is focused");
  if (focused.workspace === id) return toast(`${focused.app || "it"} is already on ${workspaceLabel(id)}`);
  send({ type: "window-move", address: focused.address, workspace: id });
  toast(`moved ${focused.app || "window"} to ${workspaceLabel(id)}`);
}

/* -------------------------------------------------------------------------- */
/* Desk: windows                                                              */
/* -------------------------------------------------------------------------- */

// Enough for most desks, and short enough to keep media in reach.
const WINDOW_CAP = 6;

// The list is rebuilt only when what it shows changes, and never while a
// finger is on a row: it'd be replaced mid-swipe or mid-drag.
let windowsKey = "";
let touchingWindow = false;
let showAllWindows = false;
/** The row swiped open to show close. @type {string | null} */
let revealedAddress = null;
/** The row held open to show its menu. @type {string | null} */
let menuAddress = null;

/** @param {State["windows"]} windows */
function shownWindows(windows) {
  if (showAllWindows || windows.length <= WINDOW_CAP) return windows;
  const shown = windows.slice(0, WINDOW_CAP);
  // The focused window always makes the cut. Windows are in workspace order,
  // so one past the cut belongs at the end.
  const focused = windows.find((w) => w.focused);
  if (focused && !shown.includes(focused)) shown[WINDOW_CAP - 1] = focused;
  return shown;
}

function renderWindows() {
  const windows = state.windows;
  $("window-count").textContent = String(windows.length);
  if (touchingWindow) return;

  const shown = shownWindows(windows);
  const key = JSON.stringify([
    shown.map((w) => [w.address, w.title, w.app, w.workspace, w.focused, w.fullscreen, w.floating]),
    windows.length,
    revealedAddress,
    menuAddress,
  ]);
  if (key === windowsKey) return;
  windowsKey = key;

  const more = /** @type {HTMLButtonElement} */ ($("windows-more"));
  more.hidden = windows.length <= WINDOW_CAP;
  more.textContent = showAllWindows ? "show less" : `show ${windows.length - shown.length} more`;

  $("windows").replaceChildren(
    ...shown.map((win) => {
      const item = document.createElement("div");
      const row = document.createElement("div");
      row.className = "window";
      row.dataset.focused = String(win.focused);
      row.innerHTML = `
        <button class="close">close</button>
        <div class="window-body">
          <span class="ws"></span>
          <div style="min-width: 0">
            <p class="app truncate" style="margin: 0"></p>
            <p class="title truncate" style="margin: 0"></p>
          </div>
        </div>`;
      const body = /** @type {HTMLElement} */ (row.querySelector(".window-body"));
      const close = /** @type {HTMLElement} */ (row.querySelector(".close"));
      // textContent, not innerHTML: window titles are arbitrary text.
      /** @type {HTMLElement} */ (row.querySelector(".ws")).textContent = String(win.workspace);
      /** @type {HTMLElement} */ (row.querySelector(".app")).textContent =
        win.app + (win.fullscreen ? " · fullscreen" : win.floating ? " · floating" : "");
      /** @type {HTMLElement} */ (row.querySelector(".title")).textContent = win.title;
      close.setAttribute("aria-label", `close ${win.app || win.title}`);
      close.addEventListener("click", () => {
        send({ type: "window", op: "close", address: win.address });
        revealedAddress = null;
      });
      if (revealedAddress === win.address) {
        row.dataset.open = "true";
        body.style.transform = "translateX(-5.5rem)";
      }
      body.addEventListener("contextmenu", (event) => event.preventDefault());

      item.append(row);
      if (menuAddress === win.address) item.append(windowMenu(win));
      attachWindowGestures(row, body, win);
      return item;
    }),
  );
}

$("windows-more").addEventListener("click", () => {
  showAllWindows = !showAllWindows;
  renderWindows();
});

/** @param {State["windows"][number]} win */
function windowMenu(win) {
  const menu = document.createElement("div");
  menu.className = "window-menu";
  /** @type {[string, "fullscreen" | "float" | "kill"][]} */
  const items = [
    [win.fullscreen ? "exit fullscreen" : "fullscreen", "fullscreen"],
    [win.floating ? "tile" : "float", "float"],
    ["force kill", "kill"],
  ];
  for (const [label, op] of items) {
    const button = document.createElement("button");
    button.textContent = label;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let disarm;
    button.addEventListener("click", () => {
      // Killing loses unsaved work, so it takes a second tap.
      if (op === "kill" && button.dataset.armed !== "true") {
        button.dataset.armed = "true";
        button.textContent = "tap again";
        disarm = setTimeout(() => {
          button.dataset.armed = "false";
          button.textContent = label;
        }, 3000);
        return;
      }
      clearTimeout(disarm);
      send({ type: "window", op, address: win.address });
      menuAddress = null;
      renderWindows();
    });
    menu.append(button);
  }
  return menu;
}

/**
 * One row's gestures: tap to focus; swipe left to reveal close, or all the way
 * to close at once; hold, then drag onto a workspace or let go for the menu.
 * @param {HTMLElement} row
 * @param {HTMLElement} body
 * @param {State["windows"][number]} win
 */
function attachWindowGestures(row, body, win) {
  /** @type {{ x: number; y: number } | null} */
  let start = null;
  /** @type {"press" | "swipe" | "scroll" | "held" | "drag"} */
  let mode = "press";
  let dx = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let holdTimer;
  const revealWidth = () => /** @type {HTMLElement} */ (row.querySelector(".close")).offsetWidth;
  const offset = () => (revealedAddress === win.address ? -revealWidth() : 0);

  body.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY };
    mode = "press";
    dx = offset();
    touchingWindow = true;
    body.setPointerCapture(event.pointerId);
    holdTimer = setTimeout(() => {
      mode = "held";
      body.dataset.held = "true";
      navigator.vibrate?.(15);
    }, 450);
  });

  body.addEventListener("pointermove", (event) => {
    if (!start) return;
    const mx = event.clientX - start.x;
    const my = event.clientY - start.y;
    if (mode === "press" && Math.hypot(mx, my) > 10) {
      clearTimeout(holdTimer);
      mode = Math.abs(mx) > Math.abs(my) ? "swipe" : "scroll";
      if (mode === "swipe") {
        body.dataset.dragging = "true";
        row.dataset.open = "true";
      }
    }
    if (mode === "swipe") {
      dx = Math.min(0, offset() + mx);
      body.style.transform = `translateX(${dx}px)`;
    }
    if (mode === "held" && Math.hypot(mx, my) > 10) {
      mode = "drag";
      body.dataset.held = "false";
      startDrag(win, body);
    }
    if (mode === "drag") moveDrag(event.clientX, event.clientY);
  });

  // Once held, the finger drags the window, not the page.
  body.addEventListener(
    "touchmove",
    (event) => {
      if (mode === "held" || mode === "drag") event.preventDefault();
    },
    { passive: false },
  );

  /** @param {boolean} cancelled */
  const end = (cancelled) => {
    clearTimeout(holdTimer);
    if (!start) return;
    start = null;
    touchingWindow = false;
    body.dataset.held = "false";
    body.dataset.dragging = "false";

    if (cancelled) {
      endDrag(false);
      body.style.transform = offset() ? `translateX(${offset()}px)` : "";
      row.dataset.open = String(Boolean(offset()));
    } else if (mode === "press") {
      // A tap on an open row, or while another is open, just closes it.
      if (revealedAddress) revealedAddress = null;
      else send({ type: "window", op: "focus", address: win.address });
      menuAddress = null;
    } else if (mode === "swipe") {
      if (-dx > row.clientWidth * 0.6) {
        body.style.transform = "translateX(-100%)";
        send({ type: "window", op: "close", address: win.address });
        revealedAddress = null;
      } else if (-dx > revealWidth() / 2) {
        body.style.transform = `translateX(-${revealWidth()}px)`;
        revealedAddress = win.address;
      } else {
        body.style.transform = "";
        if (revealedAddress === win.address) revealedAddress = null;
        body.addEventListener("transitionend", () => (row.dataset.open = "false"), { once: true });
      }
    } else if (mode === "held") {
      menuAddress = menuAddress === win.address ? null : win.address;
    } else if (mode === "drag") {
      endDrag(true);
    }
    mode = "press";
    // Catch up on anything that arrived while the finger was down.
    renderWindows();
  };
  body.addEventListener("pointerup", () => end(false));
  body.addEventListener("pointercancel", () => end(true));
}

/**
 * The window being dragged, its stand-in under the finger, and the tile it's
 * over.
 * @type {{ win: State["windows"][number]; body: HTMLElement; ghost: HTMLElement; target: HTMLElement | null } | null}
 */
let drag = null;

/**
 * @param {State["windows"][number]} win
 * @param {HTMLElement} body
 */
function startDrag(win, body) {
  const ghost = document.createElement("div");
  ghost.className = "ghost truncate";
  ghost.textContent = win.app || win.title;
  document.body.append(ghost);
  body.dataset.lifted = "true";
  // Tiles pinned to the top, reachable however far down the list is.
  renderTiles($("drop-targets"), { actions: false });
  $("drop-strip").hidden = false;
  drag = { win, body, ghost, target: null };
  navigator.vibrate?.(8);
}

/**
 * @param {number} x
 * @param {number} y
 */
function moveDrag(x, y) {
  if (!drag) return;
  drag.ghost.style.left = `${x}px`;
  drag.ghost.style.top = `${y}px`;
  /** @type {HTMLElement | null} */
  const tile = document.elementFromPoint(x, y)?.closest("[data-drop]") ?? null;
  if (tile === drag.target) return;
  if (drag.target) drag.target.dataset.target = "false";
  drag.target = tile;
  if (tile) {
    tile.dataset.target = "true";
    navigator.vibrate?.(5);
  }
}

/** @param {boolean} drop */
function endDrag(drop) {
  if (!drag) return;
  const { win, body, ghost, target } = drag;
  drag = null;
  ghost.remove();
  body.dataset.lifted = "false";
  if (target) target.dataset.target = "false";
  $("drop-strip").hidden = true;
  if (!drop || !target) return;
  const id = Number(target.dataset.id);
  if (id === win.workspace) return;
  send({ type: "window-move", address: win.address, workspace: id });
  toast(`moved ${win.app || "window"} to ${workspaceLabel(id)}`);
}

/* -------------------------------------------------------------------------- */
/* Desk: media                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where the track was when the laptop last said, and when that was: the bar
 * counts on from there on its own, rather than asking every second.
 */
let mediaClock = { position: 0, at: 0, playing: false };

/** @param {number} total */
function clockTime(total) {
  const s = Math.max(0, Math.floor(total));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours ? `${hours}:${pad2(minutes)}:${pad2(s % 60)}` : `${minutes}:${pad2(s % 60)}`;
}

function renderMedia() {
  const media = state.media;
  $("media-status").textContent = media?.status ? `${media.status} · ${media.player}` : "nothing playing";
  $("media-title").textContent = media?.title || "—";
  $("media-artist").textContent = media?.artist || " ";
  $("play-icon").innerHTML =
    media?.status === "Playing" ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z" />' : '<path d="M8 5v14l11-7z" />';

  mediaClock = { position: media?.position ?? 0, at: performance.now(), playing: media?.status === "Playing" };
  const seek = /** @type {HTMLInputElement} */ ($("media-seek"));
  const length = media?.length ?? null;
  seek.disabled = !length || media?.position == null;
  seek.max = String(Math.max(1, Math.round(length ?? 1)));
  $("media-length").textContent = length ? clockTime(length) : "--:--";
  tickMedia();

  $("media-volume-level").textContent = state.volume ? String(state.volume.level) : "--";
  setSlider("media-volume", state.volume?.level);
  loadArt(media?.art ?? null);
}

function tickMedia() {
  const media = state?.media;
  if (dragging.has("media-seek")) return;
  if (media?.position == null) {
    $("media-elapsed").textContent = "--:--";
    setSlider("media-seek", 0);
    return;
  }
  const running = mediaClock.playing ? (performance.now() - mediaClock.at) / 1000 : 0;
  const elapsed = Math.min(media.length ?? Infinity, mediaClock.position + running);
  $("media-elapsed").textContent = clockTime(elapsed);
  setSlider("media-seek", Math.round(elapsed));
}
setInterval(() => {
  if (state && document.visibilityState === "visible" && $("tab-desk").dataset.active === "true") tickMedia();
}, 500);

// Seeking waits for the finger to lift: one jump, not one per pixel.
{
  const seek = /** @type {HTMLInputElement} */ ($("media-seek"));
  seek.addEventListener("pointerdown", () => dragging.add("media-seek"));
  seek.addEventListener("pointercancel", () => dragging.delete("media-seek"));
  seek.addEventListener("input", () => {
    seek.style.setProperty("--fill", `${(Number(seek.value) / Number(seek.max)) * 100}%`);
    $("media-elapsed").textContent = clockTime(Number(seek.value));
  });
  seek.addEventListener("change", () => {
    send({ type: "media-seek", to: Number(seek.value) }, { buzz: false });
    mediaClock = { ...mediaClock, position: Number(seek.value), at: performance.now() };
    dragging.delete("media-seek");
  });
}

// Album art comes over HTTP with the token in a header, like screen frames.
/** @type {string | null} */
let artKey = null;
/** @type {string | null} */
let artUrl = null;

/** @param {string | null} key */
function loadArt(key) {
  if (key === artKey) return;
  artKey = key;
  const image = /** @type {HTMLImageElement} */ ($("media-art"));
  /** @param {string | null} url */
  const show = (url) => {
    if (artUrl) URL.revokeObjectURL(artUrl);
    artUrl = url;
    image.hidden = !url;
    if (url) image.src = url;
    else image.removeAttribute("src");
  };
  if (!key) return show(null);
  fetch(`/art?k=${encodeURIComponent(key)}`, { headers: { "x-token": token ?? "" } })
    .then((response) => {
      if (!response.ok) throw new Error(`art: ${response.status}`);
      return response.blob();
    })
    .then((blob) => artKey === key && show(URL.createObjectURL(blob)))
    .catch(() => artKey === key && show(null));
}

function renderControl() {
  // Scenes
  const scenes = $("scenes");
  if (scenes.children.length !== state.scenes.length) {
    scenes.replaceChildren(
      ...state.scenes.map((scene) => {
        const button = document.createElement("button");
        button.textContent = scene.label;
        button.style.minHeight = "4rem";
        button.style.borderRadius = "1.25rem";
        button.dataset.action = JSON.stringify({ type: "scene", id: scene.id });
        return button;
      }),
    );
  }

  // Volume
  const volume = state.volume;
  $("volume").textContent = volume ? pad2(volume.level) : "--";
  $("volume-label").textContent = volume?.muted ? "volume · muted" : "volume";
  setSlider("volume-slider", volume?.level);

  const sinks = $("sinks");
  const sinksKey = JSON.stringify(state.sinks);
  if (sinks.dataset.key !== sinksKey) {
    sinks.dataset.key = sinksKey;
    sinks.replaceChildren(
      ...state.sinks.map((sink) => {
        const button = document.createElement("button");
        button.textContent = sink.label;
        button.dataset.active = String(sink.active);
        button.dataset.action = JSON.stringify({ type: "sink", name: sink.name });
        return button;
      }),
    );
  }

  // Brightness
  $("brightness").textContent = state.brightness == null ? "--" : pad2(state.brightness);
  setSlider("brightness-slider", state.brightness);

  // Notifications
  const notifications = state.notifications;
  $("dnd").dataset.on = String(Boolean(notifications?.dnd));
  $("notification-count").textContent = notifications
    ? `${notifications.count} notification${notifications.count === 1 ? "" : "s"}`
    : "swaync isn't running";

  // Radios
  $("wifi").dataset.on = String(Boolean(state.radios.wifi));
  $("bluetooth").dataset.on = String(Boolean(state.radios.bluetooth));
  $("bluetooth-note").textContent = state.radios.bluetooth === null ? "no adapter" : " ";
}

function renderBridge() {
  // Monitors for the screen preview.
  const monitors = $("monitors");
  const key = state.monitors.map((m) => m.name).join();
  if (monitors.dataset.key !== key) {
    monitors.dataset.key = key;
    monitors.replaceChildren(
      ...state.monitors.map((monitor) => {
        const button = document.createElement("button");
        button.textContent = monitor.name;
        button.addEventListener("click", () => {
          previewMonitor = previewMonitor === monitor.name ? null : monitor.name;
          renderMonitorPills();
          updateScreenPolling();
        });
        button.dataset.name = monitor.name;
        return button;
      }),
    );
    renderMonitorPills();
  }

  // Stats
  const stats = state.stats;
  $("cpu").textContent = stats.cpu == null ? "--" : pad2(stats.cpu);
  setMeter("cpu-meter", stats.cpu, (stats.cpu ?? 0) > 85);
  if (stats.memory) {
    $("memory").textContent = (stats.memory.used / 1024).toFixed(1);
    setMeter("memory-meter", (stats.memory.used / stats.memory.total) * 100);
  }
  if (stats.battery) {
    $("battery").textContent = pad2(stats.battery.level);
    $("battery-label").textContent = stats.battery.charging ? "battery · charging" : "battery";
    setMeter("battery-meter", stats.battery.level, stats.battery.level <= 15 && !stats.battery.charging);
  }
  $("temperature").textContent = String(stats.temperature ?? "--");
  setMeter("temperature-meter", stats.temperature, (stats.temperature ?? 0) >= 85);
  if (stats.uptimeMinutes != null) {
    const hours = Math.floor(stats.uptimeMinutes / 60);
    $("uptime").textContent = `up ${hours ? `${hours}h ` : ""}${stats.uptimeMinutes % 60}m`;
  }
}

function renderInput() {
  const { keyboard, clicks } = state.input;
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-needs="keyboard"]')).forEach(
    (b) => (b.disabled = !keyboard),
  );
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-needs="clicks"]')).forEach(
    (b) => (b.disabled = !clicks),
  );
  /** @type {HTMLInputElement} */ ($("typing")).disabled = !keyboard;
  $("keyboard-hint").hidden = keyboard;
  $("clicks-hint").hidden = clicks;
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                    */
/* -------------------------------------------------------------------------- */

// data-action sends its JSON; data-key presses a named key. Either can carry
// data-repeat to keep firing while held (volume, arrows, backspace).
/** @type {ReturnType<typeof setTimeout> | undefined} */
let repeatTimer = undefined;
let repeated = false;
function stopRepeat() {
  clearTimeout(repeatTimer);
  clearInterval(repeatTimer);
  repeatTimer = undefined;
}

/**
 * @param {HTMLElement} button
 * @returns {Action}
 */
const actionOf = (button) =>
  button.dataset.action
    ? JSON.parse(button.dataset.action)
    : /** @type {Action} */ ({ type: "key", key: button.dataset.key });

// Click, not pointerdown: the browser withholds it when a touch turns into a
// scroll, and keyboards and switch access produce it too.
document.addEventListener("click", (event) => {
  /** @type {HTMLButtonElement | null} */
  const button = /** @type {Element} */ (event.target).closest("[data-action], [data-key]");
  if (!button || button.disabled) return;
  // A hold has already sent; its release shouldn't add one more. Keyboard
  // clicks (detail 0) never follow a hold.
  if (repeated && event.detail !== 0) return;
  send(actionOf(button));
});

// Holding a data-repeat button starts sending once the hold is sure. A scroll
// begun on it is a pointercancel before then, so it sends nothing.
document.addEventListener("pointerdown", (event) => {
  stopRepeat();
  repeated = false;
  /** @type {HTMLButtonElement | null} */
  const button = /** @type {Element} */ (event.target).closest("[data-repeat]");
  if (!button || button.disabled) return;
  const action = actionOf(button);
  repeatTimer = setTimeout(() => {
    repeated = true;
    send(action);
    repeatTimer = setInterval(() => send(action, { buzz: false }), 110);
  }, 400);
});
["pointerup", "pointercancel"].forEach((type) => document.addEventListener(type, stopRepeat));

/**
 * Sliders send while dragging, at most every 80ms.
 * @param {string} id
 * @param {(level: number) => Action} toAction
 */
function wireSlider(id, toAction) {
  const slider = /** @type {HTMLInputElement} */ ($(id));
  let last = 0;
  slider.addEventListener("pointerdown", () => dragging.add(id));
  slider.addEventListener("input", () => {
    const [min, max] = [Number(slider.min), Number(slider.max)];
    slider.style.setProperty("--fill", `${((Number(slider.value) - min) / (max - min)) * 100}%`);
    if (Date.now() - last < 80) return;
    last = Date.now();
    send(toAction(Number(slider.value)), { buzz: false });
  });
  slider.addEventListener("change", () => {
    send(toAction(Number(slider.value)), { buzz: false });
    dragging.delete(id);
  });
}
wireSlider("volume-slider", (level) => ({ type: "volume-set", level }));
wireSlider("media-volume", (level) => ({ type: "volume-set", level }));
wireSlider("brightness-slider", (level) => ({ type: "brightness-set", level }));

$("dnd").addEventListener("click", () => send({ type: "notifications", op: "toggle-dnd" }));
$("bluetooth").addEventListener("click", () =>
  send({ type: "radio", device: "bluetooth", on: $("bluetooth").dataset.on !== "true" }),
);

// Wi-Fi off cuts this very connection, and nothing on the phone can bring it
// back. Turning it off takes a second tap within three seconds.
/** @type {ReturnType<typeof setTimeout> | null} */
let wifiArmed = null;
$("wifi").addEventListener("click", () => {
  const on = $("wifi").dataset.on === "true";
  if (!on) {
    send({ type: "radio", device: "wifi", on: true });
    return;
  }
  if (wifiArmed) {
    clearTimeout(wifiArmed);
    wifiArmed = null;
    send({ type: "radio", device: "wifi", on: false });
    return;
  }
  toast("tap again to turn wi-fi off — you'll lose this remote");
  wifiArmed = setTimeout(() => (wifiArmed = null), 3000);
});

// Hold-to-confirm (lock): a stray tap in a pocket shouldn't lock the laptop.
/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-hold]")).forEach((button) => {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer = undefined;
  const cancel = () => {
    clearTimeout(timer);
    button.dataset.holding = "false";
  };
  button.addEventListener("pointerdown", () => {
    button.dataset.holding = "true";
    timer = setTimeout(() => {
      send(JSON.parse(/** @type {string} */ (button.dataset.hold)));
      navigator.vibrate?.([20, 40, 20]);
      cancel();
    }, 800);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((type) => button.addEventListener(type, cancel));
  button.addEventListener("contextmenu", (event) => event.preventDefault());
});

/* -------------------------------------------------------------------------- */
/* Bridge: clipboard, links, files, screen                                    */
/* -------------------------------------------------------------------------- */

$("clipboard-send").addEventListener("click", () => {
  const text = /** @type {HTMLTextAreaElement} */ ($("clipboard")).value;
  if (!text) return toast("nothing to send");
  send({ type: "clipboard-set", text });
});

$("clipboard-get").addEventListener("click", () => send({ type: "clipboard-get" }));

/** @param {string} text */
async function receiveClipboard(text) {
  /** @type {HTMLTextAreaElement} */ ($("clipboard")).value = text;
  if (!text) return toast("laptop clipboard is empty");
  // Writing to the phone's clipboard needs HTTPS; on plain HTTP the text is
  // still in the box, ready to copy by hand.
  try {
    await navigator.clipboard.writeText(text);
    toast("copied to phone");
  } catch {
    toast("got it — long-press the box to copy");
  }
}

$("link-open").addEventListener("click", () => {
  const url = /** @type {HTMLInputElement} */ ($("link")).value.trim();
  if (!url) return toast("paste a link first");
  send({ type: "open-link", url: /^https?:\/\//i.test(url) ? url : `https://${url}` });
});

$("file-pick").addEventListener("click", () => $("file").click());
/**
 * One file per request, as the raw body, so the laptop can stream it straight
 * to disk. XHR rather than fetch: it reports upload progress. Resolves to the
 * saved name, or null.
 * @param {File} file
 * @param {(loaded: number) => void} onProgress
 * @returns {Promise<string | null>}
 */
function uploadFile(file, onProgress) {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onloadend = () => resolve(request.status === 200 ? JSON.parse(request.responseText).saved : null);
    request.open("POST", "/upload");
    request.setRequestHeader("x-token", token ?? "");
    // Header values must be plain ASCII; the laptop decodes it.
    request.setRequestHeader("x-filename", encodeURIComponent(file.name));
    request.send(file);
  });
}

$("file").addEventListener("change", async () => {
  const input = /** @type {HTMLInputElement} */ ($("file"));
  const files = [.../** @type {FileList} */ (input.files)];
  if (!files.length) return;
  const bar = $("upload-progress");
  const fill = /** @type {HTMLElement} */ (bar.firstElementChild);
  bar.style.display = "block";
  const total = files.reduce((sum, file) => sum + file.size, 0) || 1;
  let done = 0;
  const saved = [];
  for (const file of files) {
    const name = await uploadFile(file, (loaded) => {
      fill.style.width = `${((done + loaded) / total) * 100}%`;
    });
    if (name) saved.push(name);
    done += file.size;
  }
  bar.style.display = "none";
  fill.style.width = "0";
  input.value = "";
  if (!saved.length) toast("upload failed");
  else if (saved.length < files.length) toast(`saved ${saved.length} of ${files.length} files`);
  else toast(saved.length === 1 ? `saved ${saved[0]}` : `saved ${saved.length} files`);
});

// Screen preview: polled only while the bridge tab is open and a monitor is
// picked, and each frame is requested only after the last one arrived.
/** @type {string | null} */
let previewMonitor = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let previewTimer = undefined;
// Frames are fetched with the token in a header, not the URL, and shown
// through object URLs; the previous one is revoked so frames don't pile up.
/** @type {string | null} */
let previewUrl = null;

/** @param {string | null} url */
function showFrame(url) {
  const old = previewUrl;
  previewUrl = url;
  if (url) /** @type {HTMLImageElement} */ ($("screen")).src = url;
  else $("screen").removeAttribute("src");
  if (old) URL.revokeObjectURL(old);
}

function renderMonitorPills() {
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#monitors button")).forEach((button) => {
    button.dataset.active = String(button.dataset.name === previewMonitor);
  });
}

function updateScreenPolling() {
  const visible = $("tab-bridge")?.dataset.active === "true" && document.visibilityState === "visible";
  clearTimeout(previewTimer);
  if (!previewMonitor || !visible) {
    $("screen-status").textContent = "paused";
    if (!previewMonitor) {
      $("screen").hidden = true;
      $("screen-empty").hidden = false;
      showFrame(null);
    }
    return;
  }
  $("screen-status").textContent = "live";
  fetch(`/screen?m=${encodeURIComponent(previewMonitor)}`, { headers: { "x-token": token ?? "" }, cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`screen: ${response.status}`);
      return response.blob();
    })
    .then((blob) => {
      // Decoded off-screen first, so the preview never flashes blank.
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        showFrame(url);
        $("screen").hidden = false;
        $("screen-empty").hidden = true;
        previewTimer = setTimeout(updateScreenPolling, 1200);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        previewTimer = setTimeout(updateScreenPolling, 3000);
      };
      image.src = url;
    })
    .catch(() => (previewTimer = setTimeout(updateScreenPolling, 3000)));
}
document.addEventListener("visibilitychange", updateScreenPolling);

/* -------------------------------------------------------------------------- */
/* Install (HTTPS + certificate)                                              */
/* -------------------------------------------------------------------------- */

// The worker only registers once the phone trusts the laptop's certificate
// (clicking through the warning isn't enough), and without it the browser
// won't offer to install.
const workerReady =
  "serviceWorker" in navigator && window.isSecureContext
    ? navigator.serviceWorker.register("/sw.js").then(() => true, () => false)
    : Promise.resolve(false);

async function renderInstall() {
  const text = $("install-text");
  const actions = $("install-actions");
  if (window.matchMedia("(display-mode: standalone)").matches) {
    $("install-card").hidden = true;
    return;
  }
  if (location.protocol === "https:" && (await workerReady)) {
    text.textContent =
      "open your browser menu and choose “add to home screen” / “install app”.";
    return;
  }
  const steps =
    "1. download the certificate below.<br>" +
    "2. android: settings → security → encryption &amp; credentials → install a certificate → ca certificate. " +
    "iphone: install the profile, then settings → general → about → certificate trust settings → turn it on.<br>";
  const download = document.createElement("a");
  download.href = "/ca.crt";
  download.innerHTML = "<button style='width:100%'>1. download certificate</button>";
  if (location.protocol === "https:") {
    text.innerHTML =
      "installing needs the phone to trust this laptop's certificate. do this once:<br>" +
      steps +
      "3. reload this page and install from the browser menu.";
    actions.replaceChildren(download);
    return;
  }
  const { httpsPort, address } = await config;
  text.innerHTML =
    "this is the plain http address. do this once:<br>" +
    steps +
    "3. open the secure version and install from the browser menu.";
  const secure = document.createElement("a");
  secure.href = `https://${address}:${httpsPort}/?t=${encodeURIComponent(token ?? "")}`;
  secure.innerHTML = "<button class='primary' style='width:100%'>3. open secure version</button>";
  actions.replaceChildren(download, secure);
}
renderInstall().catch(() => {});

/* -------------------------------------------------------------------------- */
/* Input: touchpad and keyboard                                               */
/* -------------------------------------------------------------------------- */

const pad = $("pad");
/** @type {Map<number, { x: number; y: number }>} */
const touches = new Map();
/** @type {{ fingers: number; startTime: number; moved: number; scrollCarry: number } | null} */
let gesture = null;
let move = { dx: 0, dy: 0 };
/** @type {number | null} */
let moveFrame = null;

/**
 * Moves are batched to one message per animation frame.
 * @param {number} dx
 * @param {number} dy
 */
function queueMove(dx, dy) {
  move.dx += dx;
  move.dy += dy;
  if (moveFrame) return;
  moveFrame = requestAnimationFrame(() => {
    moveFrame = null;
    if (move.dx || move.dy) send({ type: "pointer-move", dx: move.dx, dy: move.dy }, { buzz: false });
    move = { dx: 0, dy: 0 };
  });
}

// Pointer acceleration: slow drags are precise, fast flicks cross the desk.
const accelerate = (/** @type {number} */ delta) => delta * (1.4 + Math.min(Math.abs(delta) * 0.12, 2.6));

pad.addEventListener("pointerdown", (event) => {
  pad.setPointerCapture(event.pointerId);
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (!gesture) gesture = { fingers: 0, startTime: Date.now(), moved: 0, scrollCarry: 0 };
  gesture.fingers = Math.max(gesture.fingers, touches.size);
});

pad.addEventListener("pointermove", (event) => {
  const last = touches.get(event.pointerId);
  if (!last || !gesture) return;
  const dx = event.clientX - last.x;
  const dy = event.clientY - last.y;
  touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  gesture.moved += Math.abs(dx) + Math.abs(dy);

  if (touches.size >= 2) {
    // Two fingers scroll. Only the first finger's movement counts, or both
    // fingers would each scroll the page.
    if (event.pointerId !== [...touches.keys()][0]) return;
    gesture.scrollCarry += dy;
    const notches = Math.trunc(gesture.scrollCarry / 28);
    if (notches) {
      gesture.scrollCarry -= notches * 28;
      if (state?.input.clicks) send({ type: "pointer-scroll", dy: -notches }, { buzz: false });
    }
  } else {
    queueMove(accelerate(dx), accelerate(dy));
  }
});

/** @param {PointerEvent} event */
function endTouch(event) {
  touches.delete(event.pointerId);
  if (touches.size > 0 || !gesture) return;
  // A short touch that barely moved is a tap: one finger clicks, two
  // right-click.
  const tap = Date.now() - gesture.startTime < 250 && gesture.moved < 12;
  if (tap && state?.input.clicks) {
    send({ type: "pointer-click", button: gesture.fingers >= 2 ? "right" : "left" });
  }
  gesture = null;
}
pad.addEventListener("pointerup", endTouch);
pad.addEventListener("pointercancel", endTouch);

// Live typing: the field stays empty and each edit is forwarded as it
// happens. beforeinput tells us what the phone keyboard meant (text,
// backspace, enter) even when autocorrect rewrites words.
const typing = /** @type {HTMLInputElement} */ ($("typing"));
typing.addEventListener("beforeinput", (event) => {
  event.preventDefault();
  switch (event.inputType) {
    case "insertText":
    case "insertReplacementText":
    case "insertFromPaste":
      if (event.data) send({ type: "type", text: event.data }, { buzz: false });
      break;
    case "insertLineBreak":
    case "insertParagraph":
      send({ type: "key", key: "enter" }, { buzz: false });
      break;
    case "deleteContentBackward":
    case "deleteWordBackward":
      send({ type: "key", key: "backspace" }, { buzz: false });
      break;
  }
});
// Some Android keyboards skip beforeinput for composed text; catch it here.
typing.addEventListener("input", () => {
  if (typing.value) {
    send({ type: "type", text: typing.value }, { buzz: false });
    typing.value = "";
  }
});
typing.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    send({ type: "key", key: "enter" }, { buzz: false });
  }
});

if (config) {
  config.then((c) => (c.httpAllowed ? connect() : guideToSecure(c))).catch(connect);
} else {
  connect();
}
