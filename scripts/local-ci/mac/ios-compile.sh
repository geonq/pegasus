#!/bin/bash
# Compiles the iPhone app on the Mac, unsigned, for local CI. Usage: ios-compile.sh <tar> <sha>
# The tar holds apps/mobile of the exact commit. It builds in ~/Pi/local-ci/mobile, a private copy
# seeded once by APFS clone (cp -c, no extra disk) from the already prebuilt
# ~/Pi/pi-gui-attachments/apps/mobile, so another agent's working tree is never touched and
# `expo prebuild --clean` never runs (it hung for 20+ minutes in a fresh folder).
set -euo pipefail
TAR="$1"; SHA="$2"
SEED="$HOME/Pi/pi-gui-attachments/apps/mobile"
CIDIR="$HOME/Pi/local-ci"; APP="$CIDIR/mobile"; SRC="$CIDIR/src-$SHA"
NODE_BIN="$HOME/Pi/runtime/node/bin"
PNPM="$HOME/Pi/pi-gui-attachments/node_modules/pnpm/bin/pnpm.cjs"
export PATH="$NODE_BIN:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG=en_US.UTF-8 CI=1 EXPO_NO_TELEMETRY=1 EXPO_NO_GIT_STATUS=1
echo $$ > /tmp/pegasus-ci-ios.pid
cleanup() { rm -rf "$SRC" "$TAR"; rm -f /tmp/pegasus-ci-ios.pid; }
trap cleanup EXIT
# A timeout on the PC kills the ssh session; take the build down with it.
trap 'pkill -TERM -P $$ 2>/dev/null; exit 143' TERM HUP INT

mkdir -p "$CIDIR"
if [ ! -d "$APP/ios/Pods" ]; then
  echo "seed: cloning the prebuilt app from $SEED (first run)"
  rm -rf "$APP"; mkdir -p "$APP"
  cp -cR "$SEED/ios" "$SEED/node_modules" "$APP/"
fi
rm -rf "$SRC"; mkdir -p "$SRC"; tar -xf "$TAR" -C "$SRC"
# Sources of this commit; ios/ and node_modules/ are generated and stay.
rsync -a --delete --exclude ios --exclude node_modules "$SRC/apps/mobile/" "$APP/"
cd "$APP"

hash_of() { cat "$@" 2>/dev/null | shasum -a 256 | cut -d' ' -f1; }
LOCK_HASH=$(hash_of package.json pnpm-lock.yaml .npmrc deps/*)
NATIVE_HASH=$(hash_of package.json pnpm-lock.yaml app.config.ts)
# Hash stamps live outside $APP, where rsync --delete would remove them.
# The seed's node_modules and Pods match its own lockfile, so the first run compares against that.
if [ ! -f "$CIDIR/lock-hash" ]; then (cd "$SEED" && hash_of package.json pnpm-lock.yaml .npmrc deps/*) > "$CIDIR/lock-hash"; fi
if [ ! -f "$CIDIR/native-hash" ]; then (cd "$SEED" && hash_of package.json pnpm-lock.yaml app.config.ts) > "$CIDIR/native-hash"; fi
if [ "$(cat "$CIDIR/lock-hash")" != "$LOCK_HASH" ]; then
  echo "install: lockfile changed"
  node "$PNPM" install --frozen-lockfile --prefer-offline --ignore-workspace --reporter=append-only
  echo "$LOCK_HASH" > "$CIDIR/lock-hash"
fi
if [ "$(cat "$CIDIR/native-hash")" != "$NATIVE_HASH" ]; then
  # Incremental prebuild in the existing project (no --clean), then pods for new native modules.
  echo "prebuild: native config changed"
  npx expo prebuild --platform ios --no-install
  (cd ios && pod install)
  echo "$NATIVE_HASH" > "$CIDIR/native-hash"
fi
cd ios
echo "xcodebuild: Release iphoneos, unsigned, $SHA"
xcodebuild -workspace Pegasus.xcworkspace -scheme Pegasus -configuration Release -sdk iphoneos \
  -destination "generic/platform=iOS" -derivedDataPath build CODE_SIGNING_ALLOWED=NO \
  -quiet build &
wait $!
echo "ios-compile: OK $SHA"
