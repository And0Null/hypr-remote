#!/usr/bin/env bash
# One-time setup for typing (wtype), clicks and scrolling (ydotool) from the
# phone, and brightness on external monitors (ddcutil). Run from a normal
# terminal: it asks for your sudo password.
set -euo pipefail

if command -v dnf >/dev/null; then
  sudo dnf install -y wtype ydotool ddcutil
elif command -v pacman >/dev/null; then
  sudo pacman -S --needed --noconfirm wtype ydotool ddcutil
elif command -v apt-get >/dev/null; then
  sudo apt-get install -y wtype ydotool ddcutil
elif command -v zypper >/dev/null; then
  sudo zypper --non-interactive install wtype ydotool ddcutil
elif ! command -v wtype >/dev/null || ! command -v ydotool >/dev/null; then
  echo "No dnf, pacman, apt or zypper here: install wtype, ydotool and ddcutil" >&2
  echo "with your package manager, then run this again." >&2
  exit 1
fi

# Let the input group (you) create virtual input devices for ydotoold.
groups | grep -qw input || sudo usermod -aG input "$USER"
echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
  | sudo tee /etc/udev/rules.d/80-uinput.rules >/dev/null
sudo udevadm control --reload
sudo udevadm trigger --sysname-match=uinput

# ddcutil talks to monitors over I2C: load i2c-dev now and at every boot, and
# let the i2c group (you) open /dev/i2c-*.
echo i2c-dev | sudo tee /etc/modules-load.d/i2c-dev.conf >/dev/null
sudo modprobe i2c-dev
getent group i2c >/dev/null || sudo groupadd --system i2c
groups | grep -qw i2c || sudo usermod -aG i2c "$USER"
echo 'KERNEL=="i2c-[0-9]*", GROUP="i2c", MODE="0660"' \
  | sudo tee /etc/udev/rules.d/80-i2c.rules >/dev/null
sudo udevadm control --reload
sudo udevadm trigger --subsystem-match=i2c-dev

# Bun's own installer puts it in ~/.bun/bin, which may not be on PATH yet.
bun=$(command -v bun || echo ~/.bun/bin/bun)
if [[ ! -x $bun ]]; then
  echo "bun not found: install it from https://bun.sh, then run this again." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
"$bun" run install-service
echo "done. log out and back in once so the new input and i2c groups apply:"
echo "clicks and scrolling need input, external monitor brightness needs i2c."
