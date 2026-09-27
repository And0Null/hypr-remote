#!/usr/bin/env bash
# Renders every icon PNG from the two SVG masters in public/icons. Run after
# editing either SVG. Needs resvg (dnf/pacman/apt: resvg).
set -euo pipefail
cd "$(dirname "$0")/.."

icons=public/icons
render() { resvg -w "$2" -h "$2" "$icons/$1.svg" "$3"; }

render icon 192 "$icons/icon-192.png"
render icon 512 "$icons/icon-512.png"
render icon 1024 "$icons/icon-1024.png"
render icon 180 "$icons/apple-touch-icon.png"
render maskable 512 "$icons/maskable-512.png"
render maskable 1024 "$icons/maskable-1024.png"
render icon 2048 docs/logo.png
