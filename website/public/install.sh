#!/bin/sh
set -eu

releases_base_url="https://agentgauge.soumitrasaha.com/downloads"
system="$(uname -s)"
architecture="$(uname -m)"

case "$system:$architecture" in
  Darwin:arm64|Darwin:x86_64)
    ;;
  Darwin:*)
    printf '%s\n' "AgentGauge requires a supported Mac architecture (Apple Silicon or Intel)." >&2
    exit 1
    ;;
  *)
    printf '%s\n' "AgentGauge's installer currently supports macOS only." >&2
    exit 1
    ;;
esac

for utility in curl plutil shasum hdiutil codesign ditto; do
  if ! command -v "$utility" >/dev/null 2>&1; then
    printf 'Required macOS utility not found: %s\n' "$utility" >&2
    exit 1
  fi
done

manifest_url="$releases_base_url/latest-macos.json"
temporary_directory="$(mktemp -d)"
mount_point="$temporary_directory/mount"

cleanup() {
  hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}

trap cleanup 0

manifest_path="$temporary_directory/latest-macos.json"
curl --fail --location --proto '=https' --proto-redir '=https' --silent --show-error "$manifest_url" --output "$manifest_path"

version="$(plutil -extract version raw -o - "$manifest_path")"
download_url="$(plutil -extract url raw -o - "$manifest_path")"
expected_sha256="$(plutil -extract sha256 raw -o - "$manifest_path")"

if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  printf '%s\n' 'The release manifest contains an invalid version.' >&2
  exit 1
fi

expected_url="$releases_base_url/v$version/AgentGauge-$version-universal.dmg"
if [ "$download_url" != "$expected_url" ]; then
  printf '%s\n' 'The release manifest contains an unexpected download URL.' >&2
  exit 1
fi

if ! printf '%s\n' "$expected_sha256" | grep -Eq '^[a-fA-F0-9]{64}$'; then
  printf '%s\n' 'The release manifest contains an invalid SHA-256 digest.' >&2
  exit 1
fi

dmg_path="$temporary_directory/AgentGauge-$version-universal.dmg"
curl --fail --location --proto '=https' --proto-redir '=https' --silent --show-error "$download_url" --output "$dmg_path"
actual_sha256="$(shasum -a 256 "$dmg_path" | awk '{print $1}')"
if [ "$actual_sha256" != "$expected_sha256" ]; then
  printf '%s\n' 'The downloaded DMG failed its SHA-256 check.' >&2
  exit 1
fi

mkdir -p "$mount_point"
hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_point" >/dev/null
app_bundle="$mount_point/AgentGauge.app"
if [ ! -d "$app_bundle" ]; then
  printf '%s\n' 'The downloaded DMG does not contain AgentGauge.app.' >&2
  exit 1
fi

codesign --verify --deep --strict "$app_bundle"

install_directory="${AGENTGAUGE_INSTALL_DIR:-$HOME/Applications}"
case "$install_directory" in
  /*)
    ;;
  *)
    printf '%s\n' 'AGENTGAUGE_INSTALL_DIR must be an absolute path.' >&2
    exit 1
    ;;
esac

destination="$install_directory/AgentGauge.app"
backup="$temporary_directory/AgentGauge.previous.app"
if [ -e "$destination" ]; then
  if [ ! -r /dev/tty ]; then
    printf 'AgentGauge already exists at %s; rerun from an interactive terminal to replace it.\n' "$destination" >&2
    exit 1
  fi
  printf 'Replace %s? [y/N] ' "$destination" >/dev/tty
  IFS= read -r answer </dev/tty || answer=''
  case "$answer" in
    y|Y|yes|YES)
      mv "$destination" "$backup"
      ;;
    *)
      printf '%s\n' 'Installation cancelled.'
      exit 0
      ;;
  esac
fi

mkdir -p "$install_directory"
if ! ditto "$app_bundle" "$destination"; then
  if [ -e "$backup" ]; then
    mv "$backup" "$destination"
  fi
  exit 1
fi

printf 'Installed AgentGauge %s at %s\n' "$version" "$destination"
printf '%s\n' 'This release is ad-hoc signed and not notarized. If macOS blocks the first launch, Control-click AgentGauge.app, choose Open, and confirm, or allow it in System Settings > Privacy & Security. macOS may require approval again after an update.'
