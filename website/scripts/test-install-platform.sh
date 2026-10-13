#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
bin_directory="$temporary_directory/bin"
mkdir -p "$bin_directory"

cat > "$bin_directory/uname" <<'EOF'
#!/bin/sh
case "$1" in
  -s) printf '%s\n' "$AGENTGAUGE_TEST_SYSTEM" ;;
  -m) printf '%s\n' "$AGENTGAUGE_TEST_ARCH" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$bin_directory/uname"

cat > "$bin_directory/curl" <<'EOF'
#!/bin/sh
set -eu
url=''
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
printf '%s\n' "$url" >> "$AGENTGAUGE_TEST_CURL_LOG"
if [ "$url" = "$AGENTGAUGE_TEST_MANIFEST_URL" ]; then
  printf '%s\n' '{}' > "$output"
  exit 0
fi
if [ "$url" = "$AGENTGAUGE_TEST_EXPECTED_URL" ]; then
  printf '%s\n' 'test dmg' > "$output"
  exit 0
fi
printf 'unexpected requested URL: %s\n' "$url" >&2
exit 31
EOF
chmod +x "$bin_directory/curl"

cat > "$bin_directory/plutil" <<'EOF'
#!/bin/sh
case "$2" in
  version) printf '%s\n' "$AGENTGAUGE_TEST_VERSION" ;;
  url) printf '%s\n' "$AGENTGAUGE_TEST_MANIFEST_URL_VALUE" ;;
  sha256) printf '%s\n' "$AGENTGAUGE_TEST_SHA256" ;;
  *) exit 2 ;;
esac
EOF
cat > "$bin_directory/shasum" <<'EOF'
#!/bin/sh
printf '%s  %s\n' "${AGENTGAUGE_TEST_ACTUAL_SHA256:-$AGENTGAUGE_TEST_SHA256}" "$2"
EOF
cat > "$bin_directory/hdiutil" <<'EOF'
#!/bin/sh
if [ "$1" = attach ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -mountpoint ]; then
      mkdir -p "$2/AgentGauge.app"
      exit 0
    fi
    shift
  done
fi
exit 0
EOF
cat > "$bin_directory/codesign" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$bin_directory/ditto" <<'EOF'
#!/bin/sh
mkdir -p "$2"
EOF
chmod +x "$bin_directory"/*

manifest_url='https://github.com/SOUMITRO-SAHA/AgentGauge/releases/latest/download/latest-macos.json'
version='1.2.3'
sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
expected_url="https://github.com/SOUMITRO-SAHA/AgentGauge/releases/download/v$version/AgentGauge-$version-universal.dmg"
curl_log="$temporary_directory/curl.log"
home_directory="$temporary_directory/home"
install_directory="$temporary_directory/Applications"
mkdir -p "$home_directory"

if PATH="$bin_directory:$PATH" AGENTGAUGE_TEST_SYSTEM=Linux AGENTGAUGE_TEST_ARCH=x86_64 sh "$root/public/install.sh" >"$temporary_directory/output" 2>&1; then
  exit 1
fi
grep -q 'macOS only' "$temporary_directory/output"

if PATH="$bin_directory:$PATH" AGENTGAUGE_TEST_SYSTEM=Darwin AGENTGAUGE_TEST_ARCH=aarch64 sh "$root/public/install.sh" >"$temporary_directory/output" 2>&1; then
  exit 1
fi
grep -q 'supported Mac architecture' "$temporary_directory/output"

if PATH="$bin_directory:$PATH" \
  HOME="$home_directory" \
  AGENTGAUGE_INSTALL_DIR="$install_directory" \
  AGENTGAUGE_TEST_SYSTEM=Darwin \
  AGENTGAUGE_TEST_ARCH=arm64 \
  AGENTGAUGE_TEST_CURL_LOG="$curl_log" \
  AGENTGAUGE_TEST_MANIFEST_URL="$manifest_url" \
  AGENTGAUGE_TEST_EXPECTED_URL="$expected_url" \
  AGENTGAUGE_TEST_MANIFEST_URL_VALUE=https://github.com/SOUMITRO-SAHA/AgentGauge/releases/download/v1.2.3/AgentGauge-1.2.3-universal.dmg \
  AGENTGAUGE_TEST_VERSION="$version" \
  AGENTGAUGE_TEST_SHA256="$sha256" \
  sh "$root/public/install.sh" >"$temporary_directory/output" 2>&1; then
  :
else
  exit 1
fi
grep -q "Installed AgentGauge $version" "$temporary_directory/output"
grep -q 'ad-hoc signed and not notarized' "$temporary_directory/output"
grep -qF "$expected_url" "$curl_log"

: > "$curl_log"
if PATH="$bin_directory:$PATH" \
  HOME="$home_directory" \
  AGENTGAUGE_INSTALL_DIR="$install_directory" \
  AGENTGAUGE_TEST_SYSTEM=Darwin \
  AGENTGAUGE_TEST_ARCH=arm64 \
  AGENTGAUGE_TEST_CURL_LOG="$curl_log" \
  AGENTGAUGE_TEST_MANIFEST_URL="$manifest_url" \
  AGENTGAUGE_TEST_EXPECTED_URL="$expected_url" \
  AGENTGAUGE_TEST_MANIFEST_URL_VALUE=https://evil.example/AgentGauge.dmg \
  AGENTGAUGE_TEST_VERSION="$version" \
  AGENTGAUGE_TEST_SHA256="$sha256" \
  sh "$root/public/install.sh" >"$temporary_directory/output" 2>&1; then
  exit 1
fi
grep -q 'unexpected download URL' "$temporary_directory/output"
grep -qF "$manifest_url" "$curl_log"
if grep -qF 'evil.example' "$curl_log"; then
  exit 1
fi

: > "$curl_log"
if PATH="$bin_directory:$PATH" \
  HOME="$home_directory" \
  AGENTGAUGE_INSTALL_DIR="$temporary_directory/BadChecksumApplications" \
  AGENTGAUGE_TEST_SYSTEM=Darwin \
  AGENTGAUGE_TEST_ARCH=x86_64 \
  AGENTGAUGE_TEST_CURL_LOG="$curl_log" \
  AGENTGAUGE_TEST_MANIFEST_URL="$manifest_url" \
  AGENTGAUGE_TEST_EXPECTED_URL="$expected_url" \
   AGENTGAUGE_TEST_MANIFEST_URL_VALUE=https://github.com/SOUMITRO-SAHA/AgentGauge/releases/download/v1.2.3/AgentGauge-1.2.3-universal.dmg \
  AGENTGAUGE_TEST_VERSION="$version" \
  AGENTGAUGE_TEST_SHA256="$sha256" \
  AGENTGAUGE_TEST_ACTUAL_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  sh "$root/public/install.sh" >"$temporary_directory/output" 2>&1; then
  exit 1
fi
grep -q 'failed its SHA-256 check' "$temporary_directory/output"
if [ -e "$temporary_directory/BadChecksumApplications/AgentGauge.app" ]; then
  exit 1
fi
