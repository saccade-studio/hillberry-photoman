#!/usr/bin/env bash
# Full regression suite. Needs: node >= 22, python3 with Pillow + numpy, libjpeg-turbo's cjpeg/djpeg (brew install jpeg-turbo),
# macOS ColorSync profiles (for the colour-space references), and optionally Google Chrome / Firefox for the browser tests.
#   tests/run-all.sh [work-dir]
set -euo pipefail
cd "$(dirname "$0")/.."
WORK="${1:-tests/.work}"
rm -rf "$WORK"; mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"   # absolute: the browser file picker needs full paths
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
quiet() { grep -v Deprecat || true; }

step "Build"; node build.mjs
step "Unit tests (portable)"; node tests/unit.mjs | tail -2
step "Fixtures"
python3 tests/prep_logo.py "$WORK" | quiet
python3 tests/gen_corpus.py "$WORK/corpus" 2>&1 | quiet | tail -1
python3 tests/gen_fixtures.py "$WORK/fx" 2>&1 | quiet | tail -1
python3 tests/gen_png.py "$WORK/png" | quiet
python3 tests/icc_ref.py "$WORK/icc_ref.json" 2>&1 | quiet | tail -1

step "Colour management (vs littleCMS)";      node tests/icc.test.mjs "$WORK" | tail -3
step "JPEG decoder (bit-exact vs djpeg)";       node tests/jpeg-decode.test.mjs "$WORK/corpus" | tail -2
step "JPEG encoder: tables + DCT";              node tests/jpeg-encode-unit.test.mjs "$WORK" | tail -3
step "JPEG encoder: quality vs libjpeg";        node tests/jpeg-encode.test.mjs "$WORK" | tail -3
step "PNG codec";                               node tests/png.test.mjs "$WORK" | tail -3
step "EXIF rebuild";                            node tests/exif.test.mjs "$WORK" | tail -2
step "Robustness (truncation, fuzz, CMYK)";     node tests/robustness.test.mjs "$WORK" | tail -4
step "Fallback routing";                        node tests/fallback.test.mjs | tail -2
step "Export pipeline (5 colour spaces, orientation 1-8, metadata, PNG, shadow, opacity)"
node tests/pipeline.test.mjs "$WORK" | tail -1
python3 tests/pipeline_verify.py "$WORK" 2>&1 | quiet | tail -3

if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  step "Chrome, opened from file://: browser check";  node tests/selftest-chrome.mjs | head -1
  step "Chrome: real mouse/keyboard/file-picker/download flows"
  node tests/ui-e2e.mjs "$WORK" | tail -4
  python3 tests/ui_verify.py "$WORK" 2>&1 | quiet
  step "Chrome: watermark upload, swap, free crop, persistence"; node tests/ui-e2e2.mjs "$WORK" | tail -2
  step "Chrome: hosted site under /hillberry-photoman/, offline-copy download, CSP blocks the network"
  node tests/ci-smoke.mjs | grep -E "^(ok|FAIL)|smoke test" | tail -12
  step "Chrome: the same real-input flows against a Pages-style URL"
  node tools/serve.mjs dist 8767 /hillberry-photoman/ >/dev/null & SERVER=$!
  sleep 1
  APP_URL=http://127.0.0.1:8767/hillberry-photoman/ node tests/ui-e2e.mjs "$WORK" | tail -3
  python3 tests/ui_verify.py "$WORK" 2>&1 | quiet | grep -c "^ok" | sed 's/$/ download checks ok/'
  APP_URL=http://127.0.0.1:8767/hillberry-photoman/ node tests/ui-e2e2.mjs "$WORK" | tail -2
  kill $SERVER 2>/dev/null || true
  step "Chrome: CMYK fallback";  node tests/ui-cmyk.mjs "$WORK" | tail -3
  step "Chrome: export options, broken file in a batch, cancel"; node tests/ui-e2e3.mjs "$WORK" | tail -3
  python3 tests/ui_verify2.py "$WORK" 2>&1 | quiet
else echo "(Chrome not found: skipping browser tests)"; fi
if [ -x "/Applications/Firefox.app/Contents/MacOS/firefox" ]; then
  step "Firefox, opened from file://: browser check";  node tests/selftest-firefox.mjs | head -1
fi
printf '\n\033[1;32mALL SUITES COMPLETED\033[0m\n'
