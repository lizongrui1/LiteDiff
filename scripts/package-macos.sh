#!/usr/bin/env bash
#
# Package LiteDiff as a macOS .app bundle.
#
# Why a script instead of `tauri build`: this project builds the frontend and the
# Rust binary separately, and the bundle only needs a correct Info.plist plus an
# .icns. Avoiding the Tauri CLI here keeps the build reproducible without adding a
# global npm/cargo dependency.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="LiteDiff"
BUNDLE_ID="app.litediff.desktop"
# Version stamped into the bundle and the DMG name. CI passes this from the tag so
# the artifact is named after the release; a local run falls back to the value in
# `tauri.conf.json` so the two never disagree by accident.
VERSION="${VERSION:-$(python3 -c "import json;print(json.load(open('$ROOT/crates/litediff-app/tauri.conf.json'))['version'])" 2>/dev/null || echo 0.1.1)}"
OUT_DIR="$ROOT/dist-macos"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: invalid semantic version: $VERSION" >&2
  exit 1
fi

# Architecture of the binary being packaged, for the artifact name. Release
# downloads must say which CPU they are for: an Intel user cannot run an arm64
# binary and the filename is the only place that can warn them.
# Read from tauri.conf.json so the plist and the Tauri bundle config cannot disagree.
MIN_MACOS="$(python3 -c "import json;print(json.load(open('$ROOT/crates/litediff-app/tauri.conf.json'))['bundle']['macOS']['minimumSystemVersion'])" 2>/dev/null || echo 11.0)"

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) ARCH="$(uname -m)" ;;
esac
APP="$OUT_DIR/$APP_NAME.app"

echo "==> Building frontend"
cd "$ROOT/app"
if [ ! -d node_modules ]; then
  npm install
fi
npm run build

echo "==> Building Rust release binary"
cd "$ROOT"
# Tauri compiles the frontend into the binary, so the frontend must be built FIRST
# and the binary must be rebuilt whenever the bundle changes. `build.rs` watches
# app/dist to force that; without it cargo reuses a stale binary and the packaged
# app boots to a blank window.
cargo build --release -p litediff-app

# Safety net: a binary older than the frontend means the bundle was not embedded.
DIST_MTIME=$(find "$ROOT/app/dist" -type f -newer "$ROOT/target/release/litediff-app" | head -1)
if [ -n "$DIST_MTIME" ]; then
  echo "ERROR: frontend is newer than the binary ($DIST_MTIME)." >&2
  echo "       The packaged app would show a blank window. Re-run: cargo build --release -p litediff-app" >&2
  exit 1
fi

echo "==> Assembling $APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$ROOT/target/release/litediff-app" "$APP/Contents/MacOS/$APP_NAME"
chmod +x "$APP/Contents/MacOS/$APP_NAME"

# Icon: derive a full .iconset from the 512px source, then compile to .icns.
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
SRC_ICON="$ROOT/crates/litediff-app/icons/icon.png"
if [ -f "$SRC_ICON" ]; then
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$SRC_ICON" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    doubled=$((size * 2))
    sips -z "$doubled" "$doubled" "$SRC_ICON" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  if ! iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"; then
    # Some macOS/iconutil combinations reject otherwise valid iconsets. Pillow
    # emits the same ICNS container and is already required by the project's
    # Python tooling, so use it as a deterministic fallback.
    echo "    (iconutil rejected the iconset; trying Pillow)"
    python3 - "$SRC_ICON" "$APP/Contents/Resources/AppIcon.icns" <<'PY'
import sys
from PIL import Image

Image.open(sys.argv[1]).convert("RGBA").save(sys.argv[2], format="ICNS")
PY
  fi
else
  echo "    (no source icon found; bundling without one)"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
    <key>CFBundleExecutable</key><string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
    <key>CFBundleVersion</key><string>${VERSION}</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleSignature</key><string>????</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>LSMinimumSystemVersion</key><string>${MIN_MACOS}</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSRequiresAquaSystemAppearance</key><false/>
    <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
</dict>
</plist>
PLIST

# Ad-hoc signature. Unsigned bundles still launch locally, but signing avoids
# repeated "cannot be verified" prompts on some macOS versions.
echo "==> Signing (ad-hoc)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "    (codesign skipped)"

# --- DMG --------------------------------------------------------------------
#
# A drag-to-Applications image, which is the macOS convention for distributing an
# app outside the App Store. Built with `hdiutil` rather than a third-party tool so
# the script needs nothing beyond a stock macOS install.
#
# The layout matters: without the /Applications symlink next to the app, the user
# has an .app sitting in a disk image and no indication of where it belongs.
#
# Skip with SKIP_DMG=1 when only the .app is wanted (faster local iteration).
if [ "${SKIP_DMG:-0}" != "1" ]; then
  echo "==> Building DMG"
  DMG="$OUT_DIR/$APP_NAME-$VERSION-macos-$ARCH.dmg"
  STAGE="$(mktemp -d)"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"

  rm -f "$DMG"
  hdiutil create \
    -volname "$APP_NAME" \
    -srcfolder "$STAGE" \
    -ov -format UDZO \
    -quiet \
    "$DMG"
  rm -rf "$STAGE"

  echo "DMG:  $DMG"
  du -sh "$DMG" | awk '{print "Size: "$1}'
fi

echo
echo "Done: $APP"
du -sh "$APP" | awk '{print "Size: "$1}'
echo "Launch with: open \"$APP\""
