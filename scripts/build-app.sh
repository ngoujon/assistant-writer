#!/bin/bash
# Construit « Assistant Rédacteur » dans build/.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f assets/icon.icns ] || bash scripts/make-icon.sh

rm -rf build
npx @electron/packager . "Assistant Redacteur" \
  --platform=darwin \
  --no-asar \
  --arch=arm64 \
  --icon=assets/icon.icns \
  --app-bundle-id=com.nicolasgoujon.assistant-redacteur \
  --app-category-type=public.app-category.productivity \
  --app-version="$(node -p "require('./package.json').version")" \
  --extend-info=assets/Info.extra.plist \
  --prune=true \
  --ignore="^/(scripts|build|assets/icon-1024\.png|assets/AppIcon\.iconset|assets/Info\.extra\.plist)" \
  --out=build \
  --overwrite

APP="build/Assistant Redacteur-darwin-arm64/Assistant Redacteur.app"

# @electron/packager ne pose plus l'icône .icns : on l'installe nous-mêmes.
cp assets/icon.icns "$APP/Contents/Resources/icon.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon" "$APP/Contents/Info.plist"

# Le bundle porte un nom ASCII — un accent dans le chemin de l'exécutable ou d'un
# helper fait planter Electron au lancement. Le nom accentué revient ici, pour le
# Finder, le Dock et la barre des menus. Le packager écrase la clé : on repasse après.
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Assistant Rédacteur" "$APP/Contents/Info.plist"
rm -f "$APP/Contents/Resources/electron.icns"

# Signature obligatoire sur Apple Silicon après modification du bundle. On signe
# avec une identité locale stable : le trousseau (où Claude Code garde ses
# identifiants) autorise d'après la signature, et une signature ad hoc change à
# chaque construction — donc une autorisation à redonner à chaque fois.
IDENTITE="$(bash scripts/signature.sh)"
codesign --force --deep --sign "$IDENTITE" "$APP"
codesign --verify --deep "$APP"
if [ "$IDENTITE" = "-" ]; then
  echo "signature ad hoc OK (identité locale indisponible : macOS redemandera l'accès au trousseau)"
else
  echo "signature OK — identité stable « $IDENTITE »"
fi

echo "→ $APP"
