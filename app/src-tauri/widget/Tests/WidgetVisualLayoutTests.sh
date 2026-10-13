#!/usr/bin/env bash

set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/Sources/UsageWidget.swift"

assert_contains() {
  if ! grep -Fq "$1" "$SOURCE"; then
    printf 'missing widget visual contract: %s\n' "$1" >&2
    exit 1
  fi
}

assert_contains 'private var smallLayout: some View'
assert_contains 'Text(entry.provider?.displayName ?? "")'
assert_contains 'private var mediumLayout: some View'
assert_contains 'private var largeLayout: some View'
assert_contains 'largeReadingDetails'
assert_contains '.frame(maxHeight: .infinity)'
assert_contains 'READING STATUS'
assert_contains 'LAST READ'
assert_contains 'Plan not reported'
assert_contains 'Resets in'
assert_contains '.dateTime.month(.abbreviated).day().hour().minute()'
assert_contains 'left'
assert_contains 'quotaSurface'
assert_contains 'accessibilityElement(children: .combine)'
assert_contains '#Preview("Small · unavailable"'
assert_contains '#Preview("Medium · cached"'
assert_contains '#Preview("Large · live"'
assert_contains '.containerBackground(.ultraThinMaterial, for: .widget)'
assert_contains 'usedPercent'
assert_contains 'READ AT'
assert_contains 'PLAN'
assert_contains 'RESET DATE'
if grep -Fq '.overlay(alignment: .top)' "$SOURCE" || grep -Fq 'private var widgetSurface' "$SOURCE"; then
  printf 'widget header line or opaque overlay returned\n' >&2
  exit 1
fi
if grep -Fq 'LinearGradient(' "$SOURCE" || grep -Fq '.black.opacity(' "$SOURCE"; then
  printf 'opaque overlay returned to widget material\n' >&2
  exit 1
fi
