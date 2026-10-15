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
require_script_text 'mode="${1:-}"'
require_script_text '--build-only'
require_script_text 'unit tests are skipped'
require_script_text 'git -C "$repository_root" diff --quiet HEAD -- app .github/workflows/release-macos.yml'
require_script_text 'git -C "$repository_root" ls-files --others --exclude-standard -- app .github/workflows/release-macos.yml'
require_script_text 'git -C "$repository_root" rev-parse HEAD'
require_script_text 'output_directory="$(mktemp -d "$repository_root/.temp/local-release-preflight-arm64.XXXXXX")"'
require_script_text 'export TMPDIR="$temporary_directory"'
require_script_text 'cargo_target_directory="$output_directory/cargo"'
require_script_text 'widget_build_root="$output_directory/widget"'
require_script_text 'frontend_directory="$output_directory/frontend"'
require_script_text 'bun run test'
require_script_text 'cargo test --locked --features testkit --lib'
require_script_text 'TAURI_CONFIG_PATH="$tauri_config" AGENTGAUGE_FRONTEND_DIST="$frontend_directory" bun -e'
require_script_text 'bun run tauri build --target "$target" --bundles app --config "$tauri_config"'
require_script_text 'AGENTGAUGE_WIDGET_ARCH=arm64'
require_script_text 'lipo -archs'
require_script_text 'codesign --verify --deep --strict'
require_script_text 'hdiutil create'
require_script_text 'hdiutil verify'
require_script_text 'shasum -a 256'
require_script_text 'shasum -a 256 -c'
require_script_text 'local-release-preflight-arm64.XXXXXX'
require_package_text '"preflight:release:macos-arm64"'

if grep -Eq 'x86_64|universal|gh[[:space:]]|app/src-tauri/target' "$script"; then
  printf '%s\n' 'The local preflight must be arm64-only, local-only, and write build outputs under .temp.' >&2
  exit 1
fi

if ! grep -Fq 'outDir: process.env.AGENTGAUGE_FRONTEND_DIST ?? "dist"' "$repository_root/app/vite.config.ts"; then
  printf '%s\n' 'Vite must support redirecting frontend build output into the local .temp directory.' >&2
  exit 1
fi
