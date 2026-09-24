#!/usr/bin/env bash
# One-time setup for typing (wtype), clicks and scrolling (ydotool) from the
# phone. Run from a normal terminal: it asks for your sudo password.
set -euo pipefail

sudo dnf install -y wtype ydotool

# Let the input group (you) create virtual input devices for ydotoold.
echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
  | sudo tee /etc/udev/rules.d/80-uinput.rules >/dev/null
sudo udevadm control --reload
sudo udevadm trigger --sysname-match=uinput

cd "$(dirname "$0")/.."
~/.bun/bin/bun run install-service
echo "done: typing, clicks and scrolling are on."
