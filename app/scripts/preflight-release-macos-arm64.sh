#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
if [[ "$mode" != "" && "$mode" != "--build-only" ]] || [[ $# -gt 1 ]]; then
  printf 'Usage: %s [--build-only]\n' "${BASH_SOURCE[0]}" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' 'This preflight requires macOS.' >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  printf '%s\n' 'This preflight only supports a native Apple Silicon Mac.' >&2
  exit 1
fi

for command in bun cargo codesign ditto hdiutil lipo rustup shasum xcodebuild xcrun; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 1
  fi
done

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app_directory="$repository_root/app"
target="aarch64-apple-darwin"

if ! git -C "$repository_root" diff --quiet HEAD -- app .github/workflows/release-macos.yml; then
  printf '%s\n' 'Commit app and release-workflow changes before running the release preflight.' >&2
  exit 1
fi

untracked_release_files="$(git -C "$repository_root" ls-files --others --exclude-standard -- app .github/workflows/release-macos.yml)"
if [[ -n "$untracked_release_files" ]]; then
  printf 'Untracked release source files must be committed first:\n%s\n' "$untracked_release_files" >&2
  exit 1
fi

release_commit="$(git -C "$repository_root" rev-parse HEAD)"
printf 'Preflighting committed source %s\n' "$release_commit"

cd "$app_directory"

package_version="$(bun -e 'console.log(require("./package.json").version)')"
tauri_version="$(bun -e 'console.log(require("./src-tauri/tauri.conf.json").version)')"
cargo_version="$(awk '/^\[package\]$/ { in_package=1; next } /^\[/ { in_package=0 } in_package && /^version[[:space:]]*=/ { gsub(/"/, "", $3); print $3; exit }' src-tauri/Cargo.toml)"

if [[ "$package_version" != "$tauri_version" || "$tauri_version" != "$cargo_version" ]]; then
  printf 'Version mismatch: package.json=%s tauri.conf.json=%s Cargo.toml=%s\n' \
    "$package_version" "$tauri_version" "$cargo_version" >&2
  exit 1
fi

mkdir -p "$repository_root/.temp"
output_directory="$(mktemp -d "$repository_root/.temp/local-release-preflight-arm64.XXXXXX")"
cargo_target_directory="$output_directory/cargo"
widget_build_root="$output_directory/widget"
frontend_directory="$output_directory/frontend"
artifact_directory="$output_directory/artifacts"
staging_directory="$output_directory/staging"
tauri_config="$output_directory/tauri.local.json"
temporary_directory="$output_directory/tmp"

mkdir -p "$artifact_directory" "$staging_directory" "$cargo_target_directory" "$temporary_directory"
export CARGO_TARGET_DIR="$cargo_target_directory"
export TMPDIR="$temporary_directory"

if [[ "$mode" == "--build-only" ]]; then
  printf '%s\n' 'Build-only mode: unit tests are skipped; this is not production release approval.'
else
  bun run test
  cargo test --locked --features testkit --lib --manifest-path "$app_directory/src-tauri/Cargo.toml"
fi

TAURI_CONFIG_PATH="$tauri_config" AGENTGAUGE_FRONTEND_DIST="$frontend_directory" bun -e \
  'await Bun.write(process.env.TAURI_CONFIG_PATH, JSON.stringify({ build: { frontendDist: process.env.AGENTGAUGE_FRONTEND_DIST } }))'
AGENTGAUGE_FRONTEND_DIST="$frontend_directory" APPLE_SIGNING_IDENTITY="-" \
  bun run tauri build --target "$target" --bundles app --config "$tauri_config"

app_bundle="$CARGO_TARGET_DIR/$target/release/bundle/macos/AgentGauge.app"
if [[ ! -d "$app_bundle" ]]; then
  printf 'Tauri build did not produce the expected app bundle: %s\n' "$app_bundle" >&2
  exit 1
fi

AGENTGAUGE_WIDGET_ARCH=arm64 \
AGENTGAUGE_WIDGET_BUILD_ROOT="$widget_build_root" \
AGENTGAUGE_SIGN_IDENTITY=- \
  ./src-tauri/widget/build-widget.sh all "$app_bundle"

assert_arm64_binary() {
  local binary="$1"
  local architectures
  architectures="$(lipo -archs "$binary")"
  if [[ "$architectures" != "arm64" ]]; then
    printf 'Expected an arm64-only binary at %s; found: %s\n' "$binary" "$architectures" >&2
    exit 1
  fi
}

assert_arm64_binary "$app_bundle/Contents/MacOS/agentgauge"
assert_arm64_binary "$app_bundle/Contents/PlugIns/AIStatsWidget.appex/Contents/MacOS/AIStatsWidget"
assert_arm64_binary "$app_bundle/Contents/Frameworks/libWidgetBridge.dylib"
codesign --verify --deep --strict "$app_bundle"

bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_bundle/Contents/Info.plist")"
if [[ "$bundle_version" != "$package_version" ]]; then
  printf 'Bundle version mismatch: expected %s, found %s\n' "$package_version" "$bundle_version" >&2
  exit 1
fi

dmg_name="AgentGauge-${package_version}-Apple-Silicon-arm64.dmg"
dmg_path="$artifact_directory/$dmg_name"
ditto "$app_bundle" "$staging_directory/AgentGauge.app"
ln -s /Applications "$staging_directory/Applications"
hdiutil create -volname AgentGauge -srcfolder "$staging_directory" -ov -format UDZO "$dmg_path"
hdiutil verify "$dmg_path"

(
  cd "$artifact_directory"
  shasum -a 256 "$dmg_name" > "$dmg_name.sha256"
  shasum -a 256 -c "$dmg_name.sha256"
)

if [[ "$mode" == "--build-only" ]]; then
  printf '\nLocal arm64 build verification passed; unit tests were skipped.\nDMG: %s\nChecksum: %s\n' \
    "$dmg_path" "$dmg_path.sha256"
else
  printf '\nLocal Apple Silicon release preflight passed.\nDMG: %s\nChecksum: %s\n' \
    "$dmg_path" "$dmg_path.sha256"
fi
