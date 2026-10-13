#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/../signing-options.sh"

widget_signing_options "-"
[[ "${WIDGET_SIGNING_OPTIONS[*]}" == "--timestamp=none" ]]

widget_signing_options "Developer ID Application"
[[ "${WIDGET_SIGNING_OPTIONS[*]}" == "--options runtime --timestamp" ]]
