#!/usr/bin/env bash

set -euo pipefail

WIDGET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTITLEMENTS="$WIDGET_DIR/Resources/AIStatsWidget.entitlements"
PROJECT="$WIDGET_DIR/AIStatsWidget.xcodeproj/project.pbxproj"

assert_value() {
  local file="$1"
  local key="$2"
  local expected="$3"
  local actual
  if ! actual="$(/usr/libexec/PlistBuddy -c "Print :$key" "$file" 2>/dev/null)"; then
    actual=missing
  fi
  [ "$actual" = "$expected" ] || {
    printf 'Expected %s to be %s, got %s\n' "$key" "$expected" "${actual:-missing}" >&2
    exit 1
  }
}

assert_value "$ENTITLEMENTS" com.apple.security.app-sandbox true
assert_value "$ENTITLEMENTS" com.apple.security.temporary-exception.files.home-relative-path.read-write:0 '/Library/Application Support/AgentGauge/'
assert_value "$ENTITLEMENTS" com.apple.security.temporary-exception.files.home-relative-path.read-only:0 '/Library/Application Support/AI Sub Stats/'
[ "$(grep -c 'ENABLE_APP_SANDBOX = YES;' "$PROJECT")" -eq 2 ]

if [ "$#" -gt 0 ]; then
  signed_entitlements="$(mktemp)"
  trap 'rm -f "$signed_entitlements"' EXIT
  codesign -d --entitlements :- "$1" > "$signed_entitlements" 2>/dev/null
  assert_value "$signed_entitlements" com.apple.security.app-sandbox true
  assert_value "$signed_entitlements" com.apple.security.temporary-exception.files.home-relative-path.read-write:0 '/Library/Application Support/AgentGauge/'
  assert_value "$signed_entitlements" com.apple.security.temporary-exception.files.home-relative-path.read-only:0 '/Library/Application Support/AI Sub Stats/'
fi
