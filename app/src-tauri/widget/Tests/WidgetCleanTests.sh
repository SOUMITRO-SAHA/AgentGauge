#!/usr/bin/env bash

set -euo pipefail

WIDGET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf 'clean contract violated: %s\n' "$1" >&2
  exit 1
}

sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT

build_root="$sandbox/build"
mkdir -p "$build_root/Release/Build/Products" "$build_root/Debug/Build/Products" "$build_root/Logs/Build"
touch "$build_root/Release/AIStatsWidget.appex" \
  "$build_root/Release/libWidgetBridge.dylib" \
  "$build_root/Release/ProviderCyclerTests" \
  "$build_root/Debug/Build/Products/AIStatsWidget.appex" \
  "$build_root/Logs/Build/LogStoreManifest.plist"

source_canary="$sandbox/canary"
touch "$source_canary"

AGENTGAUGE_WIDGET_BUILD_ROOT="$build_root" "$WIDGET_DIR/build-widget.sh" clean

[ ! -e "$build_root" ] || fail "the build root survived clean"
[ -f "$source_canary" ] || fail "clean removed files outside the build root"

AGENTGAUGE_WIDGET_BUILD_ROOT="$build_root" "$WIDGET_DIR/build-widget.sh" clean

printf 'clean contract holds\n'
