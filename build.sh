#!/usr/bin/env bash
# Build a distributable GNOME Shell extension zip into ./dist/
#
# Produces dist/claude-usage.shell-extension.zip, installable with:
#   gnome-extensions install --force dist/claude-usage.shell-extension.zip
# Only needs `glib-compile-schemas` (libglib2.0-bin) and `zip` — no gnome-shell.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UUID="claude-usage@aidan.local"
SRC="$HERE/$UUID"
OUT="$HERE/dist"
ASSET="claude-usage.shell-extension.zip"

mkdir -p "$OUT"
rm -f "$OUT/$ASSET"

echo "Compiling GSettings schema..."
glib-compile-schemas "$SRC/schemas"

echo "Packing $ASSET..."
# Files must sit at the archive root for `gnome-extensions install`.
( cd "$SRC" && zip -r -X "$OUT/$ASSET" \
    metadata.json \
    extension.js prefs.js dataService.js indicator.js blocks.js \
    pings.js pingService.js pingIndicator.js \
    stylesheet.css \
    schemas icons \
    -x '*.DS_Store' >/dev/null )

echo "Built: $OUT/$ASSET"
unzip -l "$OUT/$ASSET" | sed 's/^/  /'
