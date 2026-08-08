#!/usr/bin/env bash
# Package the extension into a loadable/uploadable zip.
# Usage: bash release.sh
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="releases/eilatan-lingo-v${VERSION}.zip"
mkdir -p releases
rm -f "$OUT"

FILES="manifest.json background.js content.js interceptor.js popup icons"

if command -v zip >/dev/null 2>&1; then
  zip -r "$OUT" $FILES -x '*.DS_Store' >/dev/null
else
  python3 - "$OUT" "$FILES" <<'PY'
import os, sys, zipfile
out = sys.argv[1]
files = [f for f in sys.argv[2].split() if os.path.isfile(f)]
for root, _, fs in os.walk('popup'):
    files += [os.path.join(root, f) for f in fs]
for root, _, fs in os.walk('icons'):
    files += [os.path.join(root, f) for f in fs]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in sorted(files):
        z.write(f)
PY
fi

echo "Built $OUT"
