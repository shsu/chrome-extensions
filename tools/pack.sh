#!/usr/bin/env bash
# Shared packager — run from an extension directory:  npm run pack
# Builds, into that extension's dist/, artifacts named by git hash:
#   dist/<extension>-<git-hash>.zip   wraps a <extension>-<git-hash>/ dir (clean to extract)
#   dist/<extension>-<git-hash>.crx   signed; key.pem generated once and reused (gitignored)
# Source is taken from ./src. Override the browser with CHROME=/path/to/chrome.
set -euo pipefail

[ -f src/manifest.json ] || { echo "Run from an extension directory (e.g. cd tab-refresher && npm run pack)."; exit 1; }

# Find node even when invoked outside an nvm-loaded shell (lazy nvm, GUI git, bare /bin/sh).
command -v node >/dev/null 2>&1 || { [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"; }
command -v node >/dev/null 2>&1 || { echo "node not found — install Node or run 'nvm use' before packing."; exit 1; }

TOOLS=$(cd "$(dirname "$0")" && pwd)

EXTENSION=$(basename "$PWD")
HASH=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
{ git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; } || HASH="${HASH}-dirty"
NAME="${EXTENSION}-${HASH}"
KEY="$PWD/key.pem"
STAGE="dist/${NAME}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

# Validate before packing (shared validator, acts on this extension).
node "$TOOLS/test.mjs"

# Stage the loadable source (everything in src/) inside a wrapper dir named after the build.
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R src/. "$STAGE"/

# 1) ZIP — archive contains the wrapper directory.
( cd dist && rm -f "${NAME}.zip" && zip -r -X "${NAME}.zip" "${NAME}" >/dev/null )
echo "Built dist/${NAME}.zip"

# 2) CRX — Chrome writes <stage>.crx (+ <stage>.pem on first run) next to STAGE.
if [ -x "$CHROME" ]; then
  rm -f "dist/${NAME}.crx"
  if [ -f "$KEY" ]; then
    "$CHROME" --user-data-dir="$(mktemp -d)" --no-message-box \
      --pack-extension="$PWD/$STAGE" --pack-extension-key="$KEY" >/dev/null 2>&1 || true
  else
    "$CHROME" --user-data-dir="$(mktemp -d)" --no-message-box \
      --pack-extension="$PWD/$STAGE" >/dev/null 2>&1 || true
    [ -f "$PWD/${STAGE}.pem" ] && mv "$PWD/${STAGE}.pem" "$KEY" && \
      echo "Generated key.pem (gitignored) — keep it safe; it fixes your extension ID."
  fi
  [ -f "$PWD/${STAGE}.crx" ] && echo "Built dist/${NAME}.crx" || echo "WARN: CRX not produced. Zip is ready."
else
  echo "WARN: Chrome not found at: $CHROME — skipped CRX (set CHROME=...). Zip is ready."
fi

rm -rf "$STAGE"
ls -lh dist/"${NAME}".* 2>/dev/null || true
