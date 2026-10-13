#!/usr/bin/env bash

set -euo pipefail

WIDGET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentgauge-widget-bridge.XXXXXX")"
APP="$TEST_DIR/WidgetBridgeTests.app"
mkdir -p "$APP/Contents/MacOS"
trap 'rm -rf "$TEST_DIR"' EXIT

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.soumitrasaha.agentgauge.widget-bridge-test</string>
  <key>CFBundleExecutable</key><string>WidgetBridgeTests</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST

xcrun swiftc -parse-as-library \
  "$WIDGET_DIR/Sources/WidgetBridge.swift" \
  "$WIDGET_DIR/Tests/WidgetBridgeTests.swift" \
  -framework WidgetKit \
  -o "$APP/Contents/MacOS/WidgetBridgeTests"
codesign --force --sign - "$APP"
"$APP/Contents/MacOS/WidgetBridgeTests"
