#!/usr/bin/env bash
# End-to-end check of the Linux/macOS installer into a throwaway prefix.
#
# Installs, then proves the result works: the launcher runs, the version is
# readable, the config was written and the bundled skills were deployed. Any
# failure prints the installer log, because that is where the real error is.
#
# Usage: bash scripts/test-install.sh   (CI runs exactly this)

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
stage="$(mktemp -d)"
prefix="$stage/carls"
log="$stage/install.log"

cleanup() {
  bash "$here/install.sh" --uninstall --prefix "$prefix" >/dev/null 2>&1 || true
  rm -rf "$stage"
}
trap cleanup EXIT

echo "· installing into $prefix"
if ! bash "$here/install.sh" --yes --no-node --prefix "$prefix" >"$log" 2>&1; then
  echo "✗ installer failed; last lines of the log:"
  tail -40 "$log"
  exit 1
fi

fail() {
  echo "✗ $1"
  echo "--- installer log (tail) ---"
  tail -30 "$log"
  exit 1
}

[ -x "$prefix/bin/carls" ] || fail "installer did not create an executable launcher"

version="$("$prefix/bin/carls" --version 2>/dev/null)" || fail "carls --version failed"
[ -n "$version" ] || fail "carls --version printed nothing"

"$prefix/bin/carls" --help >/dev/null 2>&1 || fail "carls --help failed"
"$prefix/bin/carls" --providers >/dev/null 2>&1 || fail "carls --providers failed"
"$prefix/bin/carls" update --ref v9.9.9 --dry-run >/dev/null 2>&1 || fail "carls update --dry-run failed"

[ -f "$prefix/.carlsrc.json" ] || fail "installer did not write a config"
CARLS_SYSTEM_CONFIG="$stage/missing.json" "$prefix/bin/carls" --doctor >/dev/null 2>&1 \
  || fail "carls --doctor failed"

[ -d "$prefix/app/skills" ] || fail "skills directory is missing from the install"
skills="$(ls "$prefix/app/skills" | wc -l | tr -d ' ')"
[ "$skills" -ge 20 ] || fail "expected the bundled skills, found $skills"

# Uninstall must remove what it created and leave the stage otherwise intact.
bash "$here/install.sh" --uninstall --prefix "$prefix" >/dev/null 2>&1 || fail "uninstall failed"
[ ! -d "$prefix" ] || fail "uninstall left $prefix behind"

echo "✓ installer ok — carls $version, $skills skills, config written, uninstall clean"
