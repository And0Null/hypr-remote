# hypr-remote

Control a Hyprland desktop from your phone over home Wi-Fi. The phone gets a
web page, installable as an app, with four tabs:

- **desk**: workspaces, the window list (tap to focus, swipe left to close,
  move to another workspace) and media.
- **control**: scenes, volume and sound output, brightness, do not disturb and
  clearing notifications, Wi-Fi and Bluetooth, and hold-to-lock.
- **bridge**: shared clipboard in both directions, opening links, sending
  files to `~/Downloads`, a live preview of any monitor, and system stats.
- **input**: touchpad, live typing and a presentation clicker.

![The four tabs: desk, control, bridge and input](docs/tabs.webp)

## Run

```bash
bun install
bun run install-service   # start now and at every login (systemd user service)
# or, in the foreground:
bun start
```

Scan the QR code from the terminal (`journalctl --user -u hypr-remote`). It
opens the secure `https://` address, so the pairing token never crosses the
Wi-Fi in the clear. The first time, the browser warns about the certificate:
continue anyway, or install the certificate (see below) so it never asks. To
show the code in your own bar or widget, it is always at
`~/.cache/hypr-remote/pair.png` (and the link at `pair-url`). The phone stays
paired across restarts. Delete `~/.config/hypr-remote/token` to unpair every
phone.

![Pairing: a phone remote tile with a QR code in a Quickshell control center, next to the phone's desk tab](docs/pairing.webp)

Stop autostart: `systemctl --user disable --now hypr-remote ydotoold`.

### Keyboard, clicks and scrolling

Moving the pointer works out of the box, through Hyprland. Typing needs
`wtype`; clicks and scrolling need `ydotool`, which writes to `/dev/uinput`.
`scripts/setup-input.sh` does all of this with dnf, pacman, apt or zypper.
By hand:

```bash
sudo pacman -S wtype ydotool          # Arch, CachyOS (Fedora: sudo dnf install wtype ydotool)
groups | grep -q input || sudo usermod -aG input "$USER"   # then log out and back in
echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
  | sudo tee /etc/udev/rules.d/80-uinput.rules
sudo udevadm control --reload && sudo udevadm trigger
bun run install-service   # adds a ydotoold user service
```

The udev rule lets every member of the `input` group create virtual input
devices, which means any program running as your user can inject keystrokes.

![The bridge tab with a live screen preview and system stats, and the input tab with the touchpad and keyboard](docs/bridge-input.webp)

### Install as an app (HTTPS)

The server makes its own certificate authority in `~/.config/hypr-remote/tls`
and serves HTTPS on 4443. Browsers only install apps once they trust it, so
the bridge tab walks you through it: download the certificate, install it as
a CA certificate on the phone, reload, then install from the browser menu.

Plain HTTP on 4000 only serves the page and the certificate. The remote
itself refuses it, because anyone on the Wi-Fi could read the token and type
on your laptop. If HTTPS can't start (say, no `openssl`), everything falls
back to HTTP with a warning. `HYPR_REMOTE_ALLOW_HTTP=1` allows plain HTTP
anyway.

### Scenes

`~/.config/hypr-remote/scenes.json` is created on first run with movie,
focus, night and day. Each scene can set `volume`, `brightness`, `dnd` and
`media` (`"play"` or `"pause"`). Restart the service after editing it.

## Works on

Any Linux distro running Hyprland: Fedora, Arch, CachyOS and the rest. It
needs [Bun](https://bun.sh) and a recent Hyprland. It does not start under
GNOME, KDE, Sway or other compositors.

These work anywhere Hyprland runs: workspaces, windows, the pointer, media,
volume, brightness, clipboard, screen preview, links and files, stats,
pairing and HTTPS. They use `hyprctl`, `playerctl`, `wpctl` and `pactl`
(PipeWire), `brightnessctl`, `wl-clipboard`, `grim`, `notify-send` and
`openssl`.

The rest depends on your setup. A missing tool turns off its feature and
leaves everything else working.

| Feature                    | Needs                         | Common alternatives that won't work |
| -------------------------- | ----------------------------- | ----------------------------------- |
| Do not disturb, clearing   | swaync                        | mako, dunst                         |
| Wi-Fi toggle               | NetworkManager (`nmcli`)      | iwd, systemd-networkd               |
| Bluetooth toggle           | BlueZ (`bluetoothctl`)        |                                     |
| Lock                       | hyprlock                      | swaylock (the button does nothing)  |
| Typing                     | wtype                         |                                     |
| Clicks and scrolling       | ydotool, `/dev/uinput` access |                                     |

### Firewall

The phone connects on ports 4000 and 4443. Fedora Workstation allows them
already, and plain Arch has no firewall. With ufw (CachyOS may enable it):

```bash
sudo ufw allow 4000,4443/tcp
```

With firewalld on other setups:

```bash
sudo firewall-cmd --permanent --add-port=4000/tcp --add-port=4443/tcp && sudo firewall-cmd --reload
```

`PORT` and `HTTPS_PORT` override 4000 and 4443.

## How it works

- `src/server.ts` serves the page, a WebSocket, `/screen`, `/upload` and
  `/ca.crt`. Everything except the page, its assets and the certificate needs
  the pairing token, over HTTPS. It listens on the LAN address only.
- `src/actions.ts` is the whole list of things the phone can do, validated
  with zod. Commands run with a fixed argv and no shell. Window addresses,
  sound outputs and monitor names are checked against live lists.
- `src/state.ts` reads the desktop. Window and workspace changes arrive live
  from Hyprland's event socket, and volume, sound output and media from
  `pactl subscribe` and `playerctl --follow` (`src/watch.ts`); the rest is
  polled only while a phone is connected.
- `public/` is the phone page: plain HTML and JS, no build step. Its font,
  Geist (SIL OFL), is served from `public/fonts`.
