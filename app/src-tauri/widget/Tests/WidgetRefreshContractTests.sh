#!/usr/bin/env bash

set -euo pipefail

WIDGET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTENT="$WIDGET_DIR/Sources/RefreshWidgetIntent.swift"
VIEW="$WIDGET_DIR/Sources/UsageWidget.swift"
ENTITLEMENTS="$WIDGET_DIR/Resources/AIStatsWidget.entitlements"

grep -Fq 'WidgetRefreshRequest' "$INTENT"
grep -Fq 'invalidatableContent()' "$VIEW"
if grep -Eq 'com.apple.security.network.client|files.absolute-path' "$ENTITLEMENTS"; then
  printf 'widget must not gain network or CLI access\n' >&2
  exit 1
fi
