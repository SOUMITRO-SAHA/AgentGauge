#!/usr/bin/env bash

set -euo pipefail

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
target_root="$app_directory/src-tauri/target/local-preflight-arm64"
cargo_target_directory="$target_root/cargo"
widget_build_root="$target_root/widget"
target="aarch64-apple-darwin"

cd "$app_directory"

package_version="$(bun -e 'console.log(require("./package.json").version)')"
tauri_version="$(bun -e 'console.log(require("./src-tauri/tauri.conf.json").version)')"
cargo_version="$(awk '/^\[package\]$/ { in_package=1; next } /^\[/ { in_package=0 } in_package && /^version[[:space:]]*=/ { gsub(/"/, "", $3); print $3; exit }' src-tauri/Cargo.toml)"

if [[ "$package_version" != "$tauri_version" || "$tauri_version" != "$cargo_version" ]]; then
  printf 'Version mismatch: package.json=%s tauri.conf.json=%s Cargo.toml=%s\n' \
    "$package_version" "$tauri_version" "$cargo_version" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
artifact_directory="$target_root/artifacts/$package_version/$timestamp"
staging_directory="$target_root/staging/$timestamp"
if [[ -e "$artifact_directory" || -e "$staging_directory" ]]; then
  printf 'Preflight output already exists for this timestamp: %s\n' "$timestamp" >&2
  exit 1
fi

mkdir -p "$artifact_directory" "$staging_directory" "$cargo_target_directory"
export CARGO_TARGET_DIR="$cargo_target_directory"

bun install --frozen-lockfile
bun run test
cargo test --locked --features testkit --lib --manifest-path "$app_directory/src-tauri/Cargo.toml"
APPLE_SIGNING_IDENTITY="-" bun run tauri build --target "$target" --bundles app

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

printf '\nLocal Apple Silicon release preflight passed.\nDMG: %s\nChecksum: %s\n' \
  "$dmg_path" "$dmg_path.sha256"
