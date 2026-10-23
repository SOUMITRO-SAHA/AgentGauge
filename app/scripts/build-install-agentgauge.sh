#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
built_bundle="${app_dir}/src-tauri/target/release/bundle/macos/AgentGauge.app"
install_dir="${HOME}/Applications"
installed_bundle="${install_dir}/AgentGauge.app"

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'This installer supports macOS only.\n' >&2
  exit 1
fi

command -v bun >/dev/null 2>&1 || { printf 'bun is required but was not found.\n' >&2; exit 1; }
command -v ditto >/dev/null 2>&1 || { printf 'ditto is required but was not found.\n' >&2; exit 1; }

cd "${app_dir}"

printf '==> Installing JS dependencies\n'
bun install

printf '==> Building the macOS app and WidgetKit extension (release)\n'
bun run build:mac

if ! [ -d "${built_bundle}" ]; then
  printf 'The build did not produce %s; the previous install was left untouched.\n' "${built_bundle}" >&2
  exit 1
fi

printf '==> Removing every previous AgentGauge install\n'
bash "${script_dir}/uninstall-agentgauge.sh"

printf '==> Installing %s\n' "${installed_bundle}"
mkdir -p "${install_dir}"
rm -rf "${installed_bundle}"
ditto "${built_bundle}" "${installed_bundle}"

codesign --verify --deep --strict "${installed_bundle}"

printf '==> Launching %s\n' "${installed_bundle}"
open "${installed_bundle}"

printf 'Done. The app re-registers its background service on launch.\n'
