#!/usr/bin/env bash
#
# Builds the macOS WidgetKit extension and embeds it in a Tauri .app bundle.
#
# Why this is a script and not part of `tauri build`:
#
#   1. A WidgetKit widget MUST be built from a real Xcode app-extension target
#      (`com.apple.product-type.app-extension`). Hand-wrapping a plain Swift
#      executable into a `.appex` — which is what SwiftPM gives you — produces
#      an extension that registers but then immediately exits, because
#      `WidgetBundle.main()` returns instead of blocking and there is no XPC
#      runloop. Verified against steipete/CodexBar#1095, where this was traced
#      with lldb to a three-frame `exit()` in dyld's post-main epilogue on
#      macOS 26. Do not "simplify" this back to a SwiftPM target.
#
#   2. Tauri has no concept of an embedded app extension, so the `.appex` is
#      copied into `Contents/PlugIns/` and the host bundle is re-signed
#      afterwards.
#
# Signing:
#
#   Ad-hoc by default, which is enough for a locally built app to be offered in
#   the widget gallery. A real Apple signing identity is used when
#   AGENTGAUGE_SIGN_IDENTITY is set.
#
#   Note on team IDs: the parenthetical in an Apple Development certificate's CN
#   is the Apple ID, NOT the Team ID. On this machine CN says `(DW5S8RN36T)` while
#   the Team ID is the OU field, `N4W9KXP57T`. Reading the CN suffix produces an
#   entitlements/profile mismatch that macOS rejects — the same trap documented in
#   CodexBar#1095.
#
# Usage:
#   build-widget.sh build                    # build the .appex only
#   build-widget.sh embed /path/to/App.app    # embed into an existing bundle
#   build-widget.sh all                      # build, then embed into the newest bundle

set -euo pipefail

WIDGET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$WIDGET_DIR/AIStatsWidget.xcodeproj"
SCHEME="AIStatsWidget"
CONFIGURATION="${AGENTGAUGE_WIDGET_CONFIGURATION:-Release}"
WIDGET_ARCH="${AGENTGAUGE_WIDGET_ARCH:-$(uname -m)}"
DERIVED="$WIDGET_DIR/build/$CONFIGURATION"
BRIDGE_NAME="libWidgetBridge.dylib"
source "$WIDGET_DIR/signing-options.sh"

# Empty means ad-hoc.
SIGN_IDENTITY="${AGENTGAUGE_SIGN_IDENTITY:--}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

build_appex() {
  log "Building $SCHEME ($CONFIGURATION)"
  # The widget ships only on macOS. On any other platform this script is not
  # invoked at all, so a hard failure here is the correct behaviour rather than
  # a silent skip.
  command -v xcodebuild >/dev/null || die "xcodebuild not found. Install Xcode; the macOS widget cannot be built without it."

  mkdir -p "$DERIVED"
  xcrun swiftc \
    -parse-as-library \
    "$WIDGET_DIR/Sources/ProviderCycler.swift" \
    "$WIDGET_DIR/Tests/ProviderCyclerTests.swift" \
    -o "$DERIVED/ProviderCyclerTests"
  "$DERIVED/ProviderCyclerTests"
  bash "$WIDGET_DIR/Tests/WidgetStoragePathTests.sh"
  bash "$WIDGET_DIR/Tests/WidgetBridgeTests.sh"
  bash "$WIDGET_DIR/Tests/PlacementReceiptTests.sh"
  bash "$WIDGET_DIR/Tests/WidgetSigningOptionsTests.sh"

  local -a architecture_args
  if [ "$WIDGET_ARCH" = "universal" ]; then
    architecture_args=(ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO)
  else
    architecture_args=(ARCHS="$WIDGET_ARCH" ONLY_ACTIVE_ARCH=NO)
  fi

  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -sdk macosx \
    -derivedDataPath "$DERIVED" \
    "${architecture_args[@]}" \
    build \
    -quiet

  local appex
  appex="$(find "$DERIVED/Build/Products" -maxdepth 2 -name "$SCHEME.appex" | head -1)"
  [ -n "$appex" ] || die "build reported success but no .appex was produced"
  bash "$WIDGET_DIR/Tests/WidgetEntitlementTests.sh" "$appex"

  log "Building $BRIDGE_NAME"
  if [ "$WIDGET_ARCH" = "universal" ]; then
    xcrun swiftc \
      -emit-library \
      -O \
      -target "arm64-apple-macosx14.0" \
      "$WIDGET_DIR/Sources/WidgetBridge.swift" \
      -framework WidgetKit \
      -o "$DERIVED/$BRIDGE_NAME.arm64"
    xcrun swiftc \
      -emit-library \
      -O \
      -target "x86_64-apple-macosx14.0" \
      "$WIDGET_DIR/Sources/WidgetBridge.swift" \
      -framework WidgetKit \
      -o "$DERIVED/$BRIDGE_NAME.x86_64"
    lipo -create \
      "$DERIVED/$BRIDGE_NAME.arm64" \
      "$DERIVED/$BRIDGE_NAME.x86_64" \
      -output "$DERIVED/$BRIDGE_NAME"
  else
    xcrun swiftc \
      -emit-library \
      -O \
      -target "$WIDGET_ARCH-apple-macosx14.0" \
      "$WIDGET_DIR/Sources/WidgetBridge.swift" \
      -framework WidgetKit \
      -o "$DERIVED/$BRIDGE_NAME"
  fi

  # The two properties CodexBar#1095 identified as the difference between a
  # working extension and one that silently exits. Checked here so a future edit
  # cannot quietly reintroduce the failure.
  local pkg_type point
  pkg_type="$(/usr/libexec/PlistBuddy -c 'Print :CFBundlePackageType' "$appex/Contents/Info.plist" 2>/dev/null || echo '')"
  point="$(/usr/libexec/PlistBuddy -c 'Print :NSExtension:NSExtensionPointIdentifier' "$appex/Contents/Info.plist" 2>/dev/null || echo '')"
  [ "$pkg_type" = "XPC!" ] || die "CFBundlePackageType is '$pkg_type', expected 'XPC!'"
  [ "$point" = "com.apple.widgetkit-extension" ] || die "extension point is '$point', expected 'com.apple.widgetkit-extension'"
  if /usr/libexec/PlistBuddy -c 'Print :NSExtension:NSExtensionPrincipalClass' "$appex/Contents/Info.plist" >/dev/null 2>&1; then
    die "NSExtensionPrincipalClass must not be set; it crashes _EXRunningExtension with 'Unrecognized extension type'"
  fi

  printf '%s\n' "$appex"
}

embed_into() {
  local app="$1"
  [ -d "$app" ] || die "no such app bundle: $app"
  [ -d "$app/Contents" ] || die "$app does not look like a macOS bundle"
  widget_signing_options "$SIGN_IDENTITY"

  local appex="${1:-}"
  appex="$(find "$DERIVED/Build/Products" -maxdepth 2 -name "$SCHEME.appex" | head -1)"
  [ -n "$appex" ] || die "no built .appex found; run 'build' first"
  local bridge="$DERIVED/$BRIDGE_NAME"
  [ -f "$bridge" ] || die "no built $BRIDGE_NAME found; run 'build' first"

  log "Embedding into $(basename "$app")"
  mkdir -p "$app/Contents/PlugIns"
  mkdir -p "$app/Contents/Frameworks"
  rm -rf "$app/Contents/PlugIns/$SCHEME.appex"
  rm -f "$app/Contents/MacOS/AgentGaugeWidgetStatus"
  cp -R "$appex" "$app/Contents/PlugIns/$SCHEME.appex"
  cp "$bridge" "$app/Contents/Frameworks/$BRIDGE_NAME"

  # Order matters: nested code first, then the extension, then the host.
  # Signing the host last seals the nested signatures, and `--deep` is avoided
  # on the inner bundle so its own signature is not rewritten in a way that
  # breaks verification. The bridge runs inside the host process, so the host's
  # entitlements govern it and it needs none of its own.
  log "Signing $BRIDGE_NAME (${SIGN_IDENTITY})"
  codesign --force --sign "$SIGN_IDENTITY" "${WIDGET_SIGNING_OPTIONS[@]}" \
    "$app/Contents/Frameworks/$BRIDGE_NAME" 2>/dev/null \
    || die "failed to sign the widget bridge"
  log "Signing extension (${SIGN_IDENTITY})"
  codesign --force --sign "$SIGN_IDENTITY" "${WIDGET_SIGNING_OPTIONS[@]}" \
    --entitlements "$WIDGET_DIR/Resources/AIStatsWidget.entitlements" \
    "$app/Contents/PlugIns/$SCHEME.appex" 2>/dev/null \
    || die "failed to sign the widget extension"
  bash "$WIDGET_DIR/Tests/WidgetEntitlementTests.sh" "$app/Contents/PlugIns/$SCHEME.appex"

  log "Signing host bundle"
  codesign --force --sign "$SIGN_IDENTITY" "${WIDGET_SIGNING_OPTIONS[@]}" \
    "$app" 2>/dev/null \
    || die "failed to sign $app"

  if ! codesign --verify --deep --strict "$app" 2>/dev/null; then
    die "signature verification failed after embedding"
  fi

  # Nudge LaunchServices so the widget shows up without a rescan or a logout.
  local lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  [ -x "$lsregister" ] && "$lsregister" -f "$app" 2>/dev/null || true

  # Timeline refreshes are requested by the running app itself, in-process,
  # after each usage read. A request made from this script's context would be
  # rejected by chronod for the same reason the old helper executable was.

  log "Done: $app/Contents/PlugIns/$SCHEME.appex"
}

case "${1:-all}" in
  build)
    build_appex >/dev/null
    log "Built $SCHEME.appex"
    ;;
  embed)
    shift
    [ $# -ge 1 ] || die "usage: build-widget.sh embed /path/to/App.app"
    embed_into "$1"
    ;;
  all)
    build_appex >/dev/null
    shift || true
    if [ $# -ge 1 ]; then
      embed_into "$1"
    else
      # Pick the most recently built .app so `all` works with no arguments.
      app="$(find "$(dirname "$WIDGET_DIR")/target" -maxdepth 4 -name '*.app' -print0 2>/dev/null \
        | xargs -0 ls -dt 2>/dev/null | head -1)"
      [ -n "$app" ] || die "no .app bundle found to embed into; run 'bun run tauri build' first"
      embed_into "$app"
    fi
    ;;
  *)
    die "usage: build-widget.sh [build|embed <App.app>|all]"
    ;;
esac
