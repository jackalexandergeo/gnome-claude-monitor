#!/usr/bin/env bash
# Install (or update) the Claude Usage GNOME Shell extension.
#
# This COPIES the extension into place and enables it. On X11 you then reload the
# shell in place (Alt+F2 -> r -> Enter). On Wayland you must log out and back in.
set -euo pipefail

UUID="claude-usage@aidan.local"   # keep this for the lore
SRC="$(cd "$(dirname "$0")" && pwd)/${UUID}"
DEST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

if [[ ! -d "$SRC" ]]; then
    echo "error: source not found: $SRC" >&2
    exit 1
fi

echo "Installing ${UUID}"
echo "  from: $SRC"
echo "  to:   $DEST"

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$SRC" "$DEST"

# Compile the GSettings schema (needed for the preferences page / placement).
if [[ -d "$DEST/schemas" ]]; then
    echo "Compiling schemas..."
    glib-compile-schemas "$DEST/schemas"
fi

echo "Enabling extension..."
gnome-extensions enable "$UUID" || {
    echo "note: enable failed now — it often works after a shell reload." >&2
}

cat <<EOF

Done. Next step depends on your session:
  X11 (you are on X11):  Alt+F2, type 'r', Enter   (reloads the shell in place)
  Wayland:               log out and back in

Then verify it is active:
  gnome-extensions info ${UUID}

Watch for errors while testing:
  journalctl -f -o cat /usr/bin/gnome-shell
EOF
