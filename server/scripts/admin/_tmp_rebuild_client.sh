#!/bin/bash
set -euo pipefail
APP_ROOT=/opt/erm
cd "$APP_ROOT/client"
JS_ARCHIVE="$APP_ROOT/client/.js-bundle-archive"
mkdir -p "$JS_ARCHIVE"
if [ -d "$APP_ROOT/client/build/static/js" ]; then
  cp -f "$APP_ROOT/client/build/static/js"/main.*.js "$JS_ARCHIVE/" 2>/dev/null || true
fi
BUILD_DIR="$APP_ROOT/client/build"
BUILD_NEW="$APP_ROOT/client/build.new"
BUILD_OLD="$APP_ROOT/client/build.old"
rm -rf "$BUILD_NEW"
export BUILD_PATH=build.new
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=3072}"
sync
echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
free -h
npm run build
if [ ! -f "$BUILD_NEW/architectui/assets/styles/main.css" ]; then
  echo "ERROR: no architectui css"
  exit 1
fi
if ! ls "$BUILD_NEW/static/js"/main.*.js >/dev/null 2>&1; then
  echo "ERROR: no main js"
  exit 1
fi
if [ ! -f "$BUILD_NEW/index.html" ]; then
  echo "ERROR: no index.html"
  exit 1
fi
mkdir -p "$BUILD_NEW/static/js"
cp -f "$JS_ARCHIVE/"main.*.js "$BUILD_NEW/static/js/" 2>/dev/null || true
chmod -R a+rX "$BUILD_NEW"
rm -rf "$BUILD_OLD"
if [ -d "$BUILD_DIR" ]; then mv "$BUILD_DIR" "$BUILD_OLD"; fi
mv "$BUILD_NEW" "$BUILD_DIR"
rm -rf "$BUILD_OLD"
echo CLIENT_BUILD_OK
