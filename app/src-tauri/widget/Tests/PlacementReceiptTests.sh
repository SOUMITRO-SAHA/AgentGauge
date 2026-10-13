#!/usr/bin/env bash

set -euo pipefail

WIDGET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentgauge-widget-placement.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

xcrun swiftc -parse-as-library \
  "$WIDGET_DIR/Sources/ProviderCycler.swift" \
  "$WIDGET_DIR/Sources/Snapshot.swift" \
  "$WIDGET_DIR/Sources/SnapshotStore.swift" \
  "$WIDGET_DIR/Tests/PlacementReceiptTests.swift" \
  -o "$TEST_DIR/PlacementReceiptTests"

"$TEST_DIR/PlacementReceiptTests"