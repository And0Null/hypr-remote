#!/usr/bin/env bash
# One-time setup for typing (wtype), clicks and scrolling (ydotool) from the
# phone. Run from a normal terminal: it asks for your sudo password.
set -euo pipefail

if command -v dnf >/dev/null; then
  sudo dnf install -y wtype ydotool
elif command -v pacman >/dev/null; then
  sudo pacman -S --needed --noconfirm wtype ydotool
elif command -v apt-get >/dev/null; then
  sudo apt-get install -y wtype ydotool
elif command -v zypper >/dev/null; then
  sudo zypper --non-interactive install wtype ydotool
elif ! command -v wtype >/dev/null || ! command -v ydotool >/dev/null; then
  echo "No dnf, pacman, apt or zypper here: install wtype and ydotool with your" >&2
  echo "package manager, then run this again." >&2
  exit 1
fi

# Let the input group (you) create virtual input devices for ydotoold.
echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
  | sudo tee /etc/udev/rules.d/80-uinput.rules >/dev/null
sudo udevadm control --reload
sudo udevadm trigger --sysname-match=uinput

# Bun's own installer puts it in ~/.bun/bin, which may not be on PATH yet.
bun=$(command -v bun || echo ~/.bun/bin/bun)
if [[ ! -x $bun ]]; then
  echo "bun not found: install it from https://bun.sh, then run this again." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
"$bun" run install-service
echo "done: typing, clicks and scrolling are on."
