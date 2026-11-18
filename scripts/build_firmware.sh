#!/usr/bin/env bash
# Rebuilds the four GRBL 1.1h firmware variants in firmware/variants from upstream source.
# Needs: git, arduino-cli with the arduino:avr core  (arduino-cli core install arduino:avr)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT=40eb439bf2afc4c6f3003836c396e183ba72c45b
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
git clone --quiet https://github.com/gnea/grbl.git "$WORK/src"
git -C "$WORK/src" checkout --quiet "$COMMIT"

build() {  # name  corexy(0|1)  torch-inverted(0|1)
  local d="$WORK/$1"; mkdir -p "$d/libs" "$d/out"
  cp -R "$WORK/src/grbl" "$d/libs/grbl"
  local c="$d/libs/grbl/config.h"
  # the same homing change as firmware/grbl-corexy.patch, then the two switches
  perl -pi -e 's|^#define HOMING_CYCLE_0 \(1<<Z_AXIS\)|// #define HOMING_CYCLE_0 (1<<Z_AXIS)|; s|^#define HOMING_CYCLE_1 \(\(1<<X_AXIS\)\|\(1<<Y_AXIS\)\)|// #define HOMING_CYCLE_1 ((1<<X_AXIS)\|(1<<Y_AXIS))|; s|^// #define HOMING_CYCLE_0 \(1<<X_AXIS\)  // COREXY|#define HOMING_CYCLE_0 (1<<X_AXIS)  // COREXY|; s|^// #define HOMING_CYCLE_1 \(1<<Y_AXIS\)  // COREXY|#define HOMING_CYCLE_1 (1<<Y_AXIS)  // COREXY|' "$c"
  [ "$2" = 1 ] && perl -pi -e 's|^// #define COREXY |#define COREXY |' "$c"
  [ "$3" = 1 ] && perl -pi -e 's|^// #define INVERT_COOLANT_FLOOD_PIN|#define INVERT_COOLANT_FLOOD_PIN|' "$c"
  cp -R "$d/libs/grbl/examples/grblUpload" "$d/grblUpload"
  arduino-cli compile --fqbn arduino:avr:uno --libraries "$d/libs" --output-dir "$d/out" "$d/grblUpload" >/dev/null
  cp "$d/out/grblUpload.ino.hex" "$ROOT/firmware/variants/$1.hex"
  echo "built $1"
}
build grbl-1.1h-corexy 1 0
build grbl-1.1h-corexy-torch-inverted 1 1
build grbl-1.1h-standard-xy 0 0
build grbl-1.1h-standard-xy-torch-inverted 0 1
