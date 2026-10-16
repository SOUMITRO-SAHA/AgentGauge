#!/bin/bash
set -euo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/uninstall-agentgauge.sh"

grep -Fq 'brew uninstall --cask "${cask}"' "${script}"
grep -Fq 'osascript -e '\''tell application id "com.soumitrasaha.agentgauge" to quit' "${script}"
grep -Fq 'app_dirs=("${HOME}/Applications" "/Applications")' "${script}"
grep -Fq 'com.soumitrasaha.agentgauge*.plist' "${script}"
grep -Fq 'User data and build outputs were preserved.' "${script}"

if grep -Eq 'brew (install|reinstall)|--zap' "${script}"; then
  exit 1
fi
