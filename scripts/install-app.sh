#!/bin/bash
# Installe « Assistant Rédacteur » dans /Applications et l'ajoute au Dock.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="Assistant Redacteur"
SRC="build/${APP_NAME}-darwin-arm64/${APP_NAME}.app"

# Toujours reconstruire : réutiliser un build précédent installe silencieusement
# une version périmée de l'app.
bash scripts/build-app.sh

if [ -w /Applications ]; then
  DEST_DIR="/Applications"
else
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR"
fi
DEST="$DEST_DIR/${APP_NAME}.app"

# On ne quitte que notre propre application.
pkill -f "${APP_NAME}.app/Contents/MacOS/${APP_NAME}" 2>/dev/null || true
sleep 1

rm -rf "$DEST"
ditto "$SRC" "$DEST"
echo "installée : $DEST"

# Le Dock met en cache les icônes : on force son rafraîchissement.
touch "$DEST"

# Le Dock stocke des URL percent-encodées : on compare sur cette forme, sinon
# l'app voisine « Assistant MailZen » passerait pour la nôtre.
DOCK_NEEDLE="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "${APP_NAME}.app")"
if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "$DOCK_NEEDLE"; then
  echo "déjà présente dans le Dock"
else
  defaults write com.apple.dock persistent-apps -array-add \
    "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${DEST}/</string><key>_CFURLStringType</key><integer>0</integer></dict></dict><key>tile-type</key><string>file-tile</string></dict>"
  killall Dock
  echo "ajoutée au Dock"
fi
