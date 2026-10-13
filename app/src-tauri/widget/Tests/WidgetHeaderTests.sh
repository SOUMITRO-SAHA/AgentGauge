#!/usr/bin/env bash

set -euo pipefail

WIDGET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$WIDGET_DIR/Sources/UsageWidget.swift"
INTENT="$WIDGET_DIR/Sources/RefreshWidgetIntent.swift"

assert_contains() {
  if ! grep -Fq "$2" "$1"; then
    printf 'missing widget header contract: %s\n' "$2" >&2
    exit 1
  fi
}

assert_contains "$SOURCE" 'WidgetBrandMark(size: 16)'
assert_contains "$SOURCE" 'markSize: 17'
assert_contains "$SOURCE" 'markSize: 18'
assert_contains "$SOURCE" 'HStack(spacing: 10)'
assert_contains "$SOURCE" 'HStack(spacing: 6)'
assert_contains "$SOURCE" 'RefreshWidgetIntent()'
assert_contains "$SOURCE" 'accessibilityLabel("Refresh widget")'
assert_contains "$SOURCE" '.containerBackground(.regularMaterial, for: .widget)'
assert_contains "$SOURCE" '.fill(.ultraThinMaterial)'
assert_contains "$INTENT" 'WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)'
