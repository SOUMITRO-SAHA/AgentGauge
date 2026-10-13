declare -a WIDGET_SIGNING_OPTIONS

widget_signing_options() {
  if [ "$1" = "-" ]; then
    WIDGET_SIGNING_OPTIONS=(--timestamp=none)
  else
    WIDGET_SIGNING_OPTIONS=(--options runtime --timestamp)
  fi
}
