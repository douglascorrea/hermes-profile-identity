#!/usr/bin/env bash
# install.sh — install the profile-identity desktop plugin for Hermes Agent.
#
# Usage:
#   ./install.sh                    install into the default Hermes home
#   ./install.sh --all-profiles     also install into every ~/.hermes/profiles/<name>
#   ./install.sh --home <path>      install into a specific Hermes home
#   curl -fsSL <raw-url>/install.sh | bash        # remote install (default home)
#   curl -fsSL <raw-url>/install.sh | bash -s -- --all-profiles
#
# The desktop app watches desktop-plugins/ and hot-loads the file within
# seconds (fallback: Cmd+K -> "Reload desktop plugins").
set -euo pipefail

PLUGIN_ID="profile-identity"
RAW_BASE="https://raw.githubusercontent.com/douglascorrea/hermes-profile-identity/main"

HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"
ALL_PROFILES=0

usage() {
  cat <<'EOF'
install.sh — install the profile-identity desktop plugin for Hermes Agent.

  ./install.sh                    install into the default Hermes home
  ./install.sh --all-profiles     also install into every ~/.hermes/profiles/<name>
  ./install.sh --home <path>      install into a specific Hermes home
  curl -fsSL <raw-url>/install.sh | bash        # remote install (default home)
  curl -fsSL <raw-url>/install.sh | bash -s -- --all-profiles
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --all-profiles) ALL_PROFILES=1 ;;
    --home)
      shift
      [ $# -gt 0 ] || { echo "error: --home needs a path" >&2; exit 2; }
      HERMES_ROOT="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# When pointed at a profile home (~/.hermes/profiles/<name>), resolve the
# Hermes root two levels up so --all-profiles can find its siblings.
if [ "$(basename "$(dirname "$HERMES_ROOT")")" = "profiles" ]; then
  HERMES_ROOT="$(dirname "$(dirname "$HERMES_ROOT")")"
fi

# Prefer the plugin.js sitting next to this script (cloned repo); fall back to
# fetching the pinned raw file (curl-pipe-bash usage). When piped, BASH_SOURCE
# is meaningless ('bash'/empty) — never trust a stray ./plugin.js from the CWD.
SCRIPT_DIR=""
case "${BASH_SOURCE[0]:-}" in
  "" | bash | /dev/stdin | stdin) ;;
  *) SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)" ;;
esac

install_into() {
  local home="$1"
  local dest="$home/desktop-plugins/$PLUGIN_ID"
  mkdir -p "$dest"
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/plugin.js" ]; then
    cp "$SCRIPT_DIR/plugin.js" "$dest/plugin.js"
  else
    curl -fsSL "$RAW_BASE/plugin.js" -o "$dest/plugin.js"
  fi
  echo "installed -> $dest/plugin.js"
}

install_into "$HERMES_ROOT"

if [ "$ALL_PROFILES" = "1" ] && [ -d "$HERMES_ROOT/profiles" ]; then
  for profile_home in "$HERMES_ROOT"/profiles/*/; do
    # No nullglob: an empty profiles/ dir would iterate the literal '*/'.
    [ -d "${profile_home%/}" ] || continue
    install_into "${profile_home%/}"
  done
fi

cat <<EOF

Done. The desktop app hot-loads desktop plugins within seconds.
If it does not appear: Cmd+K -> "Reload desktop plugins".
Manage or disable it any time in Settings -> Plugins.
EOF
