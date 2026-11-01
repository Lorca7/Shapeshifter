#!/usr/bin/env bash
#
# Build Shapeshifter.app for macOS.
#
#   ./macos/build.sh              build into build/Shapeshifter.app
#   ./macos/build.sh --install    build, then copy into /Applications
#   ./macos/build.sh --run        build, then launch it
#
# Needs the Xcode Command Line Tools (for swiftc). If you do not have them:
#   xcode-select --install
# Full Xcode is not required.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
APP_NAME="Shapeshifter"
BUILD="$ROOT/build"
APP="$BUILD/$APP_NAME.app"

note()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[33mnote:\033[0m %s\n' "$*"; }
die()   { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

[ "$(uname -s)" = "Darwin" ] || die "This builds a macOS app, so it has to run on macOS (this is $(uname -s))."

if ! command -v swiftc >/dev/null 2>&1; then
  die "swiftc was not found.
  Install the Xcode Command Line Tools and try again:

      xcode-select --install

  Full Xcode is not required. If Xcode is installed but swiftc is still
  missing, run:  sudo xcode-select --reset"
fi

MACOS_VERSION="$(sw_vers -productVersion)"
case "$MACOS_VERSION" in
  1[0-2].*|[1-9].*) die "Shapeshifter needs macOS 13 or newer; this is $MACOS_VERSION." ;;
esac

note "macOS $MACOS_VERSION, $(swiftc --version 2>/dev/null | head -1)"

# ------------------------------------------------------------ bundle layout

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"

# ------------------------------------------------------------------ compile

# Target macOS 13 rather than whatever this machine runs, so the built app
# matches LSMinimumSystemVersion in Info.plist and the availability checks in
# the source mean what they say.
TARGET="$(uname -m)-apple-macos13.0"
note "Compiling $APP_NAME for $TARGET…"

swiftc \
  -O \
  -swift-version 5 \
  -target "$TARGET" \
  -framework AppKit \
  -framework WebKit \
  -framework UniformTypeIdentifiers \
  -o "$APP/Contents/MacOS/$APP_NAME" \
  "$ROOT/macos/Sources/main.swift"

# --------------------------------------------------------- editor + metadata

note "Copying the editor…"
cp "$ROOT/index.html" "$APP/Contents/Resources/web/"
cp -R "$ROOT/css" "$APP/Contents/Resources/web/"
cp -R "$ROOT/js"  "$APP/Contents/Resources/web/"

cp "$ROOT/macos/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

if command -v iconutil >/dev/null 2>&1 && [ -d "$ROOT/macos/AppIcon.iconset" ]; then
  note "Building the icon…"
  iconutil -c icns "$ROOT/macos/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns" \
    || warn "iconutil failed; the app will use the default icon."
else
  warn "iconutil not available; the app will use the default icon."
fi

# ------------------------------------------------------------------- signing

# An ad-hoc signature is enough for an app you built yourself. It is not
# notarized, which only matters for apps downloaded from the internet.
if command -v codesign >/dev/null 2>&1; then
  note "Signing (ad-hoc)…"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 \
    || warn "Ad-hoc signing failed; the app will still run."
fi

# Clear the quarantine flag in case the sources arrived via a download.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

SIZE="$(du -sh "$APP" | cut -f1)"
note "Built $APP ($SIZE)"

# ------------------------------------------------------------------ extras

for arg in "$@"; do
  case "$arg" in
    --install)
      note "Installing to /Applications…"
      rm -rf "/Applications/$APP_NAME.app"
      cp -R "$APP" /Applications/
      note "Installed. It is in Launchpad and /Applications."
      ;;
    --run)
      note "Launching…"
      open "$APP"
      ;;
    *)
      die "Unknown option: $arg (expected --install or --run)"
      ;;
  esac
done

cat <<EOF

  Open it with:        open "$APP"
  Or install it with:  ./macos/build.sh --install

EOF
