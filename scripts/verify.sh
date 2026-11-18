#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
gates=0
fail() { echo "VERIFY {\"verdict\":\"fail\",\"failed\":\"$1\"}"; exit 1; }
command -v node >/dev/null 2>&1 || fail node
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || fail node-version; gates=$((gates+1))
for f in src/*.mjs scripts/*.mjs; do node --check "$f" >&2 || fail "syntax:$f"; done; gates=$((gates+1))
npm test >&2 || fail test; gates=$((gates+1))
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
node scripts/make-synthetic-run.mjs "$tmp" >&2 || fail fixture; gates=$((gates+1))
node src/analyze.mjs "$tmp" > "$tmp/report.md" || fail report
grep -q '^## Pareto-optimal cells' "$tmp/report.md" || fail report-content; gates=$((gates+1))
echo "VERIFY {\"verdict\":\"pass\",\"gates\":$gates}"
