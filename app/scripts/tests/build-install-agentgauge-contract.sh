#!/bin/bash
set -euo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/build-install-agentgauge.sh"

grep -Fq 'bun install' "${script}"
grep -Fq 'bun run build:mac' "${script}"
grep -Fq 'uninstall-agentgauge.sh' "${script}"
grep -Fq 'ditto "${built_bundle}" "${installed_bundle}"' "${script}"
grep -Fq 'codesign --verify --deep --strict "${installed_bundle}"' "${script}"
grep -Fq 'open "${installed_bundle}"' "${script}"

line() {
  grep -nF "$1" "${script}" | head -1 | cut -d: -f1
}

build="$(line 'bun run build:mac')"
bundle_guard="$(line '[ -d "${built_bundle}" ]')"
uninstall="$(line 'uninstall-agentgauge.sh')"
install="$(line 'ditto "${built_bundle}" "${installed_bundle}"')"
verify="$(line 'codesign --verify --deep --strict "${installed_bundle}"')"
launch="$(line 'open "${installed_bundle}"')"

[ "${build}" -lt "${bundle_guard}" ] || { echo 'build must precede the bundle guard' >&2; exit 1; }
[ "${bundle_guard}" -lt "${uninstall}" ] || { echo 'a failed build must abort before uninstalling' >&2; exit 1; }
[ "${uninstall}" -lt "${install}" ] || { echo 'uninstall must precede install' >&2; exit 1; }
[ "${install}" -lt "${verify}" ] || { echo 'install must precede the code-seal verification' >&2; exit 1; }
[ "${verify}" -lt "${launch}" ] || { echo 'verification must precede launch' >&2; exit 1; }

if grep -Eq 'brew (install|reinstall)|--zap|rm -rf /' "${script}"; then
  echo 'script must never install via brew, zap, or rm outside the bundle target' >&2
  exit 1
fi
