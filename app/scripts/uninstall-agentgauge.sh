#!/bin/bash
set -euo pipefail

cask="SOUMITRO-SAHA/agentgauge/agentgauge"
cask_name="agentgauge"
app_dirs=("${HOME}/Applications" "/Applications")
launch_agent_dir="${HOME}/Library/LaunchAgents"
launch_agent_domain="gui/$(id -u)"
system_launch_agent_dirs=("/Library/LaunchAgents" "/Library/LaunchDaemons")

shopt -s nullglob

for directory in "${system_launch_agent_dirs[@]}"; do
  for plist in "${directory}"/com.soumitrasaha.agentgauge*.plist; do
    printf 'Found a system-level AgentGauge service at %s; refusing to remove it without explicit administrator handling.\n' "${plist}" >&2
    exit 1
  done
done

for directory in "${app_dirs[@]}"; do
  for app in "${directory}"/AgentGauge*.app "${directory}"/.AgentGauge*.app; do
    if [[ -e "${app}" || -L "${app}" ]]; then
      printf 'Found AgentGauge app bundle: %s\n' "${app}"
    fi
  done
done

if pgrep -x agentgauge >/dev/null 2>&1 && { [[ -d "${HOME}/Applications/AgentGauge.app" ]] || [[ -d "/Applications/AgentGauge.app" ]]; }; then
  osascript -e 'tell application id "com.soumitrasaha.agentgauge" to quit' >/dev/null
fi

launch_agents=("${launch_agent_dir}"/com.soumitrasaha.agentgauge*.plist)
for plist in "${launch_agents[@]}"; do
  label="${plist##*/}"
  label="${label%.plist}"
  service="${launch_agent_domain}/${label}"
  if launchctl print "${service}" >/dev/null 2>&1; then
    launchctl bootout "${launch_agent_domain}" "${plist}"
  fi
  rm "${plist}"
  printf 'Removed AgentGauge LaunchAgent: %s\n' "${plist}"
done

if brew list --cask --versions "${cask_name}" >/dev/null 2>&1; then
  brew uninstall --cask "${cask}"
else
  printf 'Homebrew Cask is not installed: %s\n' "${cask}"
fi

for directory in "${app_dirs[@]}"; do
  for app in "${directory}"/AgentGauge*.app "${directory}"/.AgentGauge*.app; do
    if [[ -e "${app}" || -L "${app}" ]]; then
      rm -rf "${app}"
      printf 'Removed AgentGauge app bundle: %s\n' "${app}"
    fi
  done
done

for attempt in {1..30}; do
  if ! pgrep -x agentgauge >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if pgrep -x agentgauge >/dev/null 2>&1; then
  printf 'An AgentGauge process is still running after unloading its LaunchAgents.\n' >&2
  pgrep -fal agentgauge >&2 || true
  exit 1
fi

for directory in "${app_dirs[@]}"; do
  for app in "${directory}"/AgentGauge*.app "${directory}"/.AgentGauge*.app; do
    if [[ -e "${app}" || -L "${app}" ]]; then
      printf 'AgentGauge app bundle remains at %s.\n' "${app}" >&2
      exit 1
    fi
  done
done

if brew list --cask --versions "${cask_name}" >/dev/null 2>&1; then
  printf 'Homebrew Cask remains installed: %s\n' "${cask}" >&2
  exit 1
fi

launch_agents=("${launch_agent_dir}"/com.soumitrasaha.agentgauge*.plist)
if (( ${#launch_agents[@]} > 0 )); then
  printf 'AgentGauge LaunchAgent files remain in %s.\n' "${launch_agent_dir}" >&2
  exit 1
fi

printf 'AgentGauge app bundles, Homebrew Cask, and user LaunchAgents are removed. User data and build outputs were preserved.\n'
