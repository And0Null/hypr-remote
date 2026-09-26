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

  const occupied = new Map(state.workspaces.map((w) => [w.id, w.windows]));
  const grid = $("workspaces");
  // Rebuilt only when a workspace past 10 comes or goes, or one is renamed.
  const ids = workspaceIds();
  const key = ids.map((id) => `${id}:${workspaceLabel(id)}`).join();
  if (grid.dataset.key !== key) {
    grid.dataset.key = key;
    grid.replaceChildren(
      ...ids.map((id) => {
        const button = document.createElement("button");
        button.className = "truncate";
        button.textContent = workspaceLabel(id);
        button.setAttribute("aria-label", `workspace ${workspaceName(id) ?? id}`);
        button.dataset.action = JSON.stringify({ type: "workspace", id });
        button.dataset.id = String(id);
        return button;
      }),
    );
  }
  grid.querySelectorAll("button").forEach((button) => {
    const id = Number(button.dataset.id);
    button.dataset.active = String(id === state.activeWorkspace);
    button.dataset.occupied = String((occupied.get(id) ?? 0) > 0);
  });

  renderWindows();

  const media = state.media;
  $("media-status").textContent = media?.status ? `${media.status} · ${media.player}` : "nothing playing";
  $("media-title").textContent = media?.title || "—";
  $("media-artist").textContent = media?.artist || " ";
  $("play-icon").innerHTML =
    media?.status === "Playing" ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z" />' : '<path d="M8 5v14l11-7z" />';
}

/** 1–10 always, as on the number keys, then any workspace past them that exists. */
function workspaceIds() {
  const beyond = state.workspaces.map((w) => w.id).filter((id) => id > 10);
  return [...Array.from({ length: 10 }, (_, index) => index + 1), ...beyond];
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
const workspaceLabel = (id) => workspaceName(id) ?? (id === 10 ? "0" : String(id));

// Rebuilt only when the set of windows changes, so a row mid-swipe isn't
// replaced under the finger by a routine state update.
let windowsKey = "";
/** @type {string | null} */
let movingAddress = null;

function renderWindows() {
  const windows = state.windows;
  $("window-count").textContent = String(windows.length);
  const key = JSON.stringify(windows.map((w) => [w.address, w.title, w.workspace, w.focused])) + movingAddress;
  if (key === windowsKey) return;
  windowsKey = key;

  const list = $("windows");
  list.replaceChildren(
    ...windows.map((win) => {
      const row = document.createElement("div");
      row.className = "window";
      row.dataset.focused = String(win.focused);
      row.innerHTML = `
        <span class="close-label">close</span>
        <div class="window-body">
          <span class="ws">${win.workspace}</span>
          <div style="min-width: 0">
            <p class="app truncate" style="margin: 0"></p>
            <p class="title truncate" style="margin: 0"></p>
          </div>
          <button class="move">move</button>
        </div>`;
      // textContent, not innerHTML: window titles are arbitrary text.
      /** @type {HTMLElement} */ (row.querySelector(".app")).textContent = win.app;
      /** @type {HTMLElement} */ (row.querySelector(".title")).textContent = win.title;
      /** @type {HTMLElement} */ (row.querySelector(".move")).addEventListener("click", (event) => {
        event.stopPropagation();
        movingAddress = movingAddress === win.address ? null : win.address;
        renderWindows();
      });

      if (movingAddress === win.address) {
        const picker = document.createElement("div");
        picker.className = "move-picker";
        for (const id of workspaceIds()) {
          const button = document.createElement("button");
          button.className = "truncate";
          button.textContent = workspaceLabel(id);
          button.disabled = id === win.workspace;
          button.addEventListener("click", () => {
            send({ type: "window-move", address: win.address, workspace: id });
            movingAddress = null;
          });
          picker.append(button);
        }
        row.append(picker);
      }

      attachSwipe(row, win);
      return row;
    }),
  );
}

/**
 * Swipe left past a third of the row to close it; a tap focuses it.
 * @param {HTMLElement} row
 * @param {State["windows"][number]} win
 */
function attachSwipe(row, win) {
  const body = /** @type {HTMLElement} */ (row.querySelector(".window-body"));
  /** @type {number | null} */
  let startX = null;
  let startY = 0;
  let dx = 0;
  let swiping = false;

  body.addEventListener("pointerdown", (event) => {
    if (/** @type {Element} */ (event.target).closest("button")) return;
    startX = event.clientX;
    startY = event.clientY;
    dx = 0;
    swiping = false;
    body.setPointerCapture(event.pointerId);
  });

  body.addEventListener("pointermove", (event) => {
    if (startX === null) return;
    dx = Math.min(0, event.clientX - startX);
    if (!swiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(event.clientY - startY)) swiping = true;
    if (swiping) {
      body.dataset.dragging = "true";
      body.style.transform = `translateX(${dx}px)`;
    }
  });

  const end = () => {
    if (startX === null) return;
    body.dataset.dragging = "false";
    if (swiping && -dx > row.clientWidth / 3) {
      body.style.transform = "translateX(-100%)";
      send({ type: "window", op: "close", address: win.address });
    } else {
      body.style.transform = "";
      if (!swiping) send({ type: "window", op: "focus", address: win.address });
    }
    startX = null;
  };
  body.addEventListener("pointerup", end);
  body.addEventListener("pointercancel", () => {
    body.dataset.dragging = "false";
    body.style.transform = "";
    startX = null;
  });
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
