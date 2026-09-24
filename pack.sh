#!/usr/bin/env bash
set -euo pipefail

typewriterMinify=false
if [[ "${1:-}" == "--minify" ]]; then
  typewriterMinify=true
  shift
fi
if [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--minify]" >&2
  exit 2
fi

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
VITE_BIN="$PROJECT_ROOT/node_modules/.bin/vite"

if [[ ! -x "$VITE_BIN" ]]; then
  echo "Missing local build dependencies. Run npm ci first." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Missing python3 command. Install Python 3 before packaging." >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "Missing zip command. Install zip before packaging." >&2
  exit 1
fi

cd "$PROJECT_ROOT"
TYPEWRITER_BUILD_MINIFY="$typewriterMinify" npm run build

# These public files are useful during development but are not product package
# entrypoints. The logo is retained because the Settings page references it.
rm -f "$DIST_DIR/favicon.ico" "$DIST_DIR/icon.png"
find "$DIST_DIR" -name '.DS_Store' -type f -delete

cp "$PROJECT_ROOT/Apache-2.0.txt" "$DIST_DIR/Apache-2.0.txt"
cp "$PROJECT_ROOT/DATA-LICENSE.md" "$DIST_DIR/DATA-LICENSE.md"
cp "$PROJECT_ROOT/BRAND.md" "$DIST_DIR/BRAND.md"
cp "$PROJECT_ROOT/THIRD-PARTY-NOTICES.txt" "$DIST_DIR/THIRD-PARTY-NOTICES.txt"
find "$DIST_DIR" -type f -exec chmod 0644 {} +

ZIP_NAME="$(python3 "$PROJECT_ROOT/pack.py")"
ZIP_DIR="${TYPEWRITER_ZIP_DIR:-${HOME:-$PROJECT_ROOT}/Downloads}"
mkdir -p "$ZIP_DIR"
ZIP_DIR="$(cd -- "$ZIP_DIR" && pwd)"
ZIP_PATH="$ZIP_DIR/$ZIP_NAME"
TEMP_ZIP="$ZIP_PATH.tmp.$$"
trap 'rm -f "$TEMP_ZIP"' EXIT

(
  cd "$DIST_DIR"
  zip -qr "$TEMP_ZIP" . -x '*.DS_Store'
)

mv -f "$TEMP_ZIP" "$ZIP_PATH"

node "$PROJECT_ROOT/scripts/validate-package.mjs" \
  --project-root "$PROJECT_ROOT" \
  --dir "$DIST_DIR" \
  --zip "$ZIP_PATH"

printf 'Created %s\n' "$ZIP_PATH"
