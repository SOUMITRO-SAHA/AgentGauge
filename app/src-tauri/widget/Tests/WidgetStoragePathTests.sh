#!/usr/bin/env bash

set -euo pipefail

WIDGET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentgauge-widget-storage.XXXXXX")"
APP="$TEST_DIR/WidgetStoragePathTests.app"
mkdir -p "$APP/Contents/MacOS"
trap 'rm -rf "$TEST_DIR"' EXIT

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.soumitrasaha.agentgauge.widget-storage-test</string>
  <key>CFBundleExecutable</key><string>WidgetStoragePathTests</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST

xcrun swiftc -parse-as-library \
  "$WIDGET_DIR/Sources/ProviderCycler.swift" \
  "$WIDGET_DIR/Sources/Snapshot.swift" \
  "$WIDGET_DIR/Sources/SnapshotStore.swift" \
  "$WIDGET_DIR/Tests/WidgetStoragePathTests.swift" \
  -o "$APP/Contents/MacOS/WidgetStoragePathTests"
codesign --force --sign - --entitlements "$WIDGET_DIR/Resources/AIStatsWidget.entitlements" "$APP"
"$APP/Contents/MacOS/WidgetStoragePathTests"
