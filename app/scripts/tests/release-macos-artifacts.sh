#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
workflow="$repository_root/.github/workflows/release-macos.yml"

require_workflow_text() {
  if ! grep -Fq -- "$1" "$workflow"; then
    printf 'Missing release workflow contract: %s\n' "$1" >&2
    exit 1
  fi
}

require_workflow_text 'aarch64-apple-darwin'
require_workflow_text 'x86_64-apple-darwin'
require_workflow_text 'for target in aarch64-apple-darwin x86_64-apple-darwin'
require_workflow_text 'widget_arch=arm64'
require_workflow_text 'widget_arch=x86_64'
require_workflow_text 'dmg_label=Apple-Silicon-arm64'
require_workflow_text 'dmg_label=Intel-x86_64'
require_workflow_text 'AgentGauge-${version}-${dmg_label}.dmg'
require_workflow_text 'AgentGauge-$version-universal.dmg'
require_workflow_text 'AgentGauge-${version}-Apple-Silicon-arm64.dmg'
require_workflow_text 'AgentGauge-${version}-Intel-x86_64.dmg'
require_workflow_text 'AgentGauge-${version}-Apple-Silicon-arm64.dmg.sha256'
require_workflow_text 'AgentGauge-${version}-Intel-x86_64.dmg.sha256'
require_workflow_text '"$app_bundle/Contents/MacOS/agentgauge"'
require_workflow_text '"$app_bundle/Contents/PlugIns/AIStatsWidget.appex/Contents/MacOS/AIStatsWidget"'
require_workflow_text 'actual_archs="$(lipo -archs "$binary")"'
require_workflow_text 'shasum -a 256'
