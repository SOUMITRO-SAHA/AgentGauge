#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="$repository_root/app/scripts/preflight-release-macos-arm64.sh"
package="$repository_root/app/package.json"

require_script_text() {
  if ! grep -Fq -- "$1" "$script"; then
    printf 'Missing local preflight contract: %s\n' "$1" >&2
    exit 1
  fi
}

require_package_text() {
  if ! grep -Fq -- "$1" "$package"; then
    printf 'Missing package command contract: %s\n' "$1" >&2
    exit 1
  fi
}

require_script_text '[[ "$(uname -s)" != "Darwin" ]]'
require_script_text '[[ "$(uname -m)" != "arm64" ]]'
require_script_text 'target="aarch64-apple-darwin"'
require_script_text 'git -C "$repository_root" diff --quiet HEAD -- app .github/workflows/release-macos.yml'
require_script_text 'git -C "$repository_root" ls-files --others --exclude-standard -- app .github/workflows/release-macos.yml'
require_script_text 'git -C "$repository_root" rev-parse HEAD'
require_script_text 'bun install --frozen-lockfile'
require_script_text 'bun run test'
require_script_text 'cargo test --locked --features testkit --lib'
require_script_text 'bun run tauri build --target "$target" --bundles app'
require_script_text 'AGENTGAUGE_WIDGET_ARCH=arm64'
require_script_text 'lipo -archs'
require_script_text 'codesign --verify --deep --strict'
require_script_text 'hdiutil create'
require_script_text 'hdiutil verify'
require_script_text 'shasum -a 256'
require_script_text 'shasum -a 256 -c'
require_script_text 'local-preflight-arm64'
require_package_text '"preflight:release:macos-arm64"'

if grep -Eq 'x86_64|universal|gh[[:space:]]' "$script"; then
  printf '%s\n' 'The local preflight must remain arm64-only and must not call GitHub.' >&2
  exit 1
fi
