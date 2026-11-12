#!/usr/bin/env bash
# carls-code universal Linux installer.
#
# Works on any Linux distribution, with or without a package manager, root or
# not. It installs Node (from the distro, or from the official static tarball
# when no package manager is usable) and carls itself under a self-contained
# prefix that every user can reach.
#
# Usage:
#   ./scripts/install.sh                    interactive panel
#   ./scripts/install.sh --yes              accept all defaults, no prompts
#   ./scripts/install.sh --prefix /opt/carls --mode build
#   ./scripts/install.sh --uninstall        remove carls
#
# Flags:
#   -y, --yes            non-interactive; use defaults for anything unspecified
#   -p, --prefix <dir>   install prefix (default: /opt/carls, ~/.local/carls for non-root)
#   -m, --mode <mode>    default permission mode written to the config
#       --model <id>     default model written to the config
#       --provider <p>   any id from `carls --providers`, e.g. anthropic, nvidia,
#                        openrouter, ollama (auto-detected from the environment)
#       --effort <level> minimal | low | medium | high (default: low)
#       --base-url <url> default API base URL written to the config
#       --api-key <key>  API key written to the config (prefer the env var)
#       --context-window <n>  model context window in tokens (default 200000)
#       --no-node        never install Node, fail if it is missing
#       --uninstall      remove the install prefix and symlinks
#   -h, --help           show this help

set -o pipefail

PREFIX="${CARLS_PREFIX:-}"

# Shared helpers that have their own tests. Sourcing keeps them honest.
carls_script_dir="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/node-bin.sh
. "$carls_script_dir/lib/node-bin.sh"
MODE=""
MODEL=""
BASE_URL=""
API_KEY=""
PROVIDER=""
EFFORT=""
CONTEXT_WINDOW=""
ASSUME_YES=0
INSTALL_NODE=1
DO_UNINSTALL=0
NODE_MAJOR=24

CARLS_APP_DIR=""
CARLS_NODE_DIR=""
LOG_FILE="${TMPDIR:-/tmp}/carls-install-$$.log"

# ---------------------------------------------------------------- presentation

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET="$(printf '\033[0m')"; C_BOLD="$(printf '\033[1m')"
  C_CYAN="$(printf '\033[36m')"; C_GREEN="$(printf '\033[32m')"
  C_YELLOW="$(printf '\033[33m')"; C_RED="$(printf '\033[31m')"
  C_GRAY="$(printf '\033[90m')"
else
  C_RESET=""; C_BOLD=""; C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_GRAY=""
fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s\n' "${C_CYAN}·${C_RESET} $*"; }
ok()   { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}!${C_RESET} $*" >&2; }
die()  { printf '%s\n' "${C_RED}✗${C_RESET} $*" >&2; exit 1; }

panel() {
  # panel <title> <line>...
  title="$1"; shift
  say "${C_BOLD}${C_CYAN}$title${C_RESET}"
  say "${C_GRAY}$(printf '─%.0s' $(seq 1 58))${C_RESET}"
  for line in "$@"; do say "  $line"; done
  say ""
}

# ------------------------------------------------------------------- utilities

have() { command -v "$1" >/dev/null 2>&1; }

run_logged() {
  # Runs a command, hiding output unless it fails.
  if ! "$@" >>"$LOG_FILE" 2>&1; then
    warn "command failed: $*"
    warn "last lines of $LOG_FILE:"
    tail -n 15 "$LOG_FILE" >&2 || true
    return 1
  fi
  return 0
}

sudo_cmd() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

need_root_for() {
  # Returns 0 when we can write to $1 (directly or via sudo).
  target="$1"
  if [ -w "$target" ]; then return 0; fi
  if have sudo && sudo -n true 2>/dev/null; then return 0; fi
  return 1
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7l|armv6l) echo "armv7l" ;;
    ppc64le) echo "ppc64le" ;;
    s390x) echo "s390x" ;;
    *) echo "" ;;
  esac
}

detect_distro() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "${ID:-unknown}"
  elif have lsb_release; then
    lsb_release -si 2>/dev/null | tr '[:upper:]' '[:lower:]'
  elif [ -r /etc/debian_version ]; then
    echo debian
  elif [ -r /etc/redhat-release ]; then
    echo rhel
  else
    echo unknown
  fi
}

detect_pm() {
  for pm in apt-get dnf yum pacman zypper apk xbps-install emerge eopkg swupd tdnf; do
    if have "$pm"; then echo "$pm"; return 0; fi
  done
  echo ""
}

# -------------------------------------------------------------------- Node.js

node_major_of() {
  "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

install_node_via_pm() {
  pm="$1"
  info "Installing Node.js with $pm…"
  case "$pm" in
    apt-get)
      sudo_cmd apt-get update -y >>"$LOG_FILE" 2>&1 || true
      sudo_cmd apt-get install -y nodejs npm >>"$LOG_FILE" 2>&1
      ;;
    dnf|yum|tdnf)
      sudo_cmd "$pm" install -y nodejs npm >>"$LOG_FILE" 2>&1
      ;;
    pacman)
      sudo_cmd pacman -Sy --noconfirm nodejs npm >>"$LOG_FILE" 2>&1
      ;;
    zypper)
      sudo_cmd zypper --non-interactive install nodejs npm >>"$LOG_FILE" 2>&1
      ;;
    apk)
      sudo_cmd apk add --no-cache nodejs npm >>"$LOG_FILE" 2>&1
      ;;
    xbps-install)
      sudo_cmd xbps-install -Sy nodejs >>"$LOG_FILE" 2>&1
      ;;
    emerge)
      sudo_cmd emerge --quiet dev-lang/node >>"$LOG_FILE" 2>&1
      ;;
    eopkg)
      sudo_cmd eopkg install -y nodejs >>"$LOG_FILE" 2>&1
      ;;
    swupd)
      sudo_cmd swupd bundle-add nodejs-basic >>"$LOG_FILE" 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

install_node_tarball() {
  # Distribution-independent fallback: the official static build.
  arch="$(detect_arch)"
  [ -n "$arch" ] || return 1
  have curl || have wget || return 1

  version="$(resolve_latest_node)" || return 1
  url="https://nodejs.org/dist/${version}/node-${version}-linux-${arch}.tar.xz"
  info "Downloading ${version} (${arch}) from nodejs.org…"

  dest="$CARLS_NODE_DIR"
  mkdir -p "$dest" || return 1
  tmp="${TMPDIR:-/tmp}/node-${version}.tar.xz"
  if have curl; then
    curl -fsSL "$url" -o "$tmp" >>"$LOG_FILE" 2>&1 || return 1
  else
    wget -qO "$tmp" "$url" >>"$LOG_FILE" 2>&1 || return 1
  fi
  tar -xJf "$tmp" -C "$dest" --strip-components=1 >>"$LOG_FILE" 2>&1 || return 1
  rm -f "$tmp"
  [ -x "$dest/bin/node" ] || return 1
  return 0
}

resolve_latest_node() {
  # Ask nodejs.org for the newest release in the target major line.
  index="https://nodejs.org/dist/index.json"
  raw=""
  if have curl; then
    raw="$(curl -fsSL --max-time 20 "$index" 2>/dev/null)" || raw=""
  elif have wget; then
    raw="$(wget -qO- --timeout=20 "$index" 2>/dev/null)" || raw=""
  fi
  if [ -n "$raw" ]; then
    # First entry whose version starts with v<major>.
    picked="$(printf '%s' "$raw" | tr '{' '\n' | grep "\"version\":\"v${NODE_MAJOR}\." | head -n 1 |
      sed 's/.*"version":"\(v[^"]*\)".*/\1/')"
    if [ -n "$picked" ]; then echo "$picked"; return 0; fi
  fi
  echo ""; return 1
}

ensure_node() {
  if have node; then
    major="$(node_major_of node)"
    if [ -n "$major" ] && [ "$major" -ge 20 ] 2>/dev/null; then
      ok "Node.js $(node -v) already installed"
      return 0
    fi
    warn "Node.js $(node -v 2>/dev/null) is older than v20."
  fi

  if [ "$INSTALL_NODE" -eq 0 ]; then
    die "Node.js >= 20 is required and --no-node was given."
  fi

  pm="$(detect_pm)"
  if [ -n "$pm" ]; then
    if install_node_via_pm "$pm" && have node; then
      major="$(node_major_of node)"
      if [ -n "$major" ] && [ "$major" -ge 20 ] 2>/dev/null; then
        ok "Installed Node.js $(node -v) via $pm"
        return 0
      fi
      warn "$pm provided Node.js $(node -v 2>/dev/null), which is too old; using the static build instead."
    else
      warn "$pm could not install Node.js; falling back to the static build."
    fi
  else
    info "No package manager detected; using the static Node.js build."
  fi

  install_node_tarball || die "Could not install Node.js automatically. Install Node >= 20 and re-run."
  export PATH="$CARLS_NODE_DIR/bin:$PATH"
  ok "Installed Node.js $("$CARLS_NODE_DIR/bin/node" -v) into $CARLS_NODE_DIR"
  return 0
}

# ----------------------------------------------------------------------- panel

prompt_effort() {
  say "Reasoning effort (used by reasoning-capable models):"
  say "  1) off    ${C_GRAY}do not send an effort hint${C_RESET}"
  say "  2) minimal ${C_GRAY}fastest${C_RESET}"
  say "  3) low    ${C_GRAY}light reasoning${C_RESET}"
  say "  4) medium ${C_GRAY}balanced${C_RESET}"
  say "  5) high   ${C_GRAY}deepest, slowest${C_RESET}"
  printf 'Choose [3]: '
  read -r answer || answer=""
  case "$answer" in
    1|off) EFFORT="" ;;
    2|minimal) EFFORT="minimal" ;;
    4|medium) EFFORT="medium" ;;
    5|high) EFFORT="high" ;;
    *) EFFORT="low" ;;
  esac
  say ""
}

prompt_mode() {
  say "Permission mode for the default config:"
  say "  ${C_CYAN}1)${C_RESET} plan   ${C_GRAY}read-only, mutations refused${C_RESET}"
  say "  2) ask    ${C_GRAY}prompt for writes and shell (default)${C_RESET}"
  say "  3) build  ${C_GRAY}writes auto-approved, shell prompts${C_RESET}"
  say "  4) auto   ${C_GRAY}everything but the deny-list runs${C_RESET}"
  say "  5) yolo   ${C_GRAY}everything runs${C_RESET}"
  printf 'Choose [2]: '
  read -r answer || answer=""
  case "$answer" in
    1|plan) MODE="plan" ;;
    3|build) MODE="build" ;;
    4|auto) MODE="auto" ;;
    5|yolo) MODE="yolo" ;;
    *) MODE="ask" ;;
  esac
}

show_panel() {
  panel "${C_BOLD}carls-code installer" \
    "distro    ${C_GRAY}$(detect_distro)${C_RESET}" \
    "arch      ${C_GRAY}$(uname -m)${C_RESET}" \
    "package   ${C_GRAY}$(detect_pm || echo none)${C_RESET}" \
    "prefix    ${C_GRAY}${PREFIX}${C_RESET}" \
    "provider  ${C_GRAY}$(detect_provider)${C_RESET}" \
    "mode      ${C_GRAY}${MODE}${C_RESET}" \
    "effort    ${C_GRAY}${EFFORT:-off}${C_RESET}" \
    "model     ${C_GRAY}${MODEL:-<provider default>}${C_RESET}"
}

# ------------------------------------------------------------------- install

# The launcher must embed a node that actually exists; see scripts/lib/node-bin.sh.
write_launcher() {
  launcher="$PREFIX/bin/carls"
  node_bin="$(carls_resolve_node_bin)"
  mkdir -p "$PREFIX/bin"
  cat >"$launcher" <<SH
#!/bin/sh
exec "$node_bin" "$CARLS_APP_DIR/dist/src/index.js" "\$@"
SH
  chmod 755 "$launcher"
  if [ "$node_bin" = "/usr/bin/env node" ]; then
    warn "No node binary was found; the launcher relies on PATH at run time."
  else
    info "Launcher uses $node_bin"
  fi
}

link_globals() {
  # A user-scope install must never take over a system-wide link. /usr/local/bin
  # is shared: a non-root install that sudo-writes it hijacks the machine's
  # `carls` and can point it at a directory the user later deletes. Only a root
  # install may claim /usr/local/bin; everyone else gets ~/.local/bin.
  if [ "$(id -u)" -eq 0 ]; then
    dirs="/usr/local/bin"
  else
    dirs="$HOME/.local/bin"
  fi

  for dir in $dirs; do
    mkdir -p "$dir" 2>/dev/null || true
    if [ -w "$dir" ] || [ "$(id -u)" -eq 0 ]; then
      ln -sf "$PREFIX/bin/carls" "$dir/carls" 2>/dev/null && ok "Linked $dir/carls" && return 0
    fi
  done

  warn "Could not link carls into PATH. Add $PREFIX/bin to your PATH:"
  warn "  export PATH=\"$PREFIX/bin:\$PATH\""
  return 0
}

# The provider registry in dist/ is the single source of truth for ids, their
# credential variables and their default base URLs. The installer reads it so
# adding a provider never means editing this script.
registry_json() {
  node -e '
    import(process.argv[1]).then((m) => {
      const rows = m.PROVIDERS.map((p) => ({
        id: p.id, env: p.apiKeyEnv, baseUrl: p.baseUrl, model: p.defaultModel, keyless: p.keyless === true,
      }));
      process.stdout.write(JSON.stringify(rows));
    }).catch(() => process.stdout.write("[]"));
  ' "$CARLS_APP_DIR/dist/src/providers/registry.js" 2>/dev/null || printf '[]'
}

detect_provider() {
  # Prefer an explicit choice, then infer from whichever credential is present.
  [ -n "$PROVIDER" ] && { printf '%s' "$PROVIDER"; return; }
  if [ -n "$BASE_URL" ]; then printf '%s' "compatible"; return; fi
  rows="$(registry_json)"
  found="$(printf '%s' "$rows" | node -e '
    let raw = ""; process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      let list = [];
      try { list = JSON.parse(raw); } catch { list = []; }
      for (const row of list) {
        for (const name of row.env || []) {
          if ((process.env[name] || "").length > 0) { process.stdout.write(row.id); return; }
        }
      }
    });
  ' 2>/dev/null)"
  [ -n "$found" ] && { printf '%s' "$found"; return; }
  printf '%s' "anthropic"
}

detect_credential() {
  # Picks up an exported key so the install is usable with zero extra setup.
  [ -n "$API_KEY" ] && { printf '%s' "$API_KEY"; return; }
  rows="$(registry_json)"
  printf '%s' "$rows" | node -e '
    let raw = ""; process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      let list = [];
      try { list = JSON.parse(raw); } catch { list = []; }
      const names = list.flatMap((row) => row.env || []);
      names.push("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY");
      for (const name of names) {
        const value = process.env[name];
        if (value && value.length > 0) { process.stdout.write(value); return; }
      }
    });
  ' 2>/dev/null
}

write_config() {
  config="$PREFIX/.carlsrc.json"
  key="$(detect_credential)"
  node "$CARLS_APP_DIR/dist/src/setup/writeConfig.js" \
    --out "$config" --mode "$MODE" \
    --provider "$(detect_provider)" \
    ${EFFORT:+--effort "$EFFORT"} \
    ${CONTEXT_WINDOW:+--context-window "$CONTEXT_WINDOW"} \
    ${MODEL:+--model "$MODEL"} \
    ${BASE_URL:+--base-url "$BASE_URL"} \
    ${key:+--api-key "$key"} >>"$LOG_FILE" 2>&1 \
    || die "Failed to write $config (see $LOG_FILE)"

  # This file is shared, not private: every user reads it through
  # /etc/carls/.carlsrc.json, and it must not be readable only by root. When it
  # holds a key the API key is what needs protecting, and that is enforced with
  # the directory mode below plus a warning at load time.
  chmod 644 "$config" 2>/dev/null || true

  ok "Wrote default config $config"
  [ -n "$key" ] && ok "Reused an API key found in your environment" || true
  if [ -n "$key" ]; then
    warn "The default config contains an API key and is readable by every user on this machine."
    warn "Prefer the environment variable: unset the key in $config and export $(api_key_env_for "$(detect_provider)") instead."
  fi
}

# First credential variable of a registry provider, read from the built registry
# so the advice matches the code.
api_key_env_for() {
  node -e 'import(process.argv[1]).then((m) => { const p = m.providerById(process.argv[2]); process.stdout.write((p && p.apiKeyEnv[0]) || ""); })' \
    "$CARLS_APP_DIR/dist/src/providers/registry.js" "$1" 2>/dev/null || printf '%s' "the provider key"
}

link_system_config() {
  # Point the system-wide config at the installed default so every user works
  # with no setup of their own.
  sys="/etc/carls/.carlsrc.json"
  if [ "$(id -u)" -eq 0 ] || (have sudo && sudo -n true 2>/dev/null); then
    sudo_cmd mkdir -p /etc/carls
    # The directory is world-readable and the config inside is 644, so every
    # user resolves /etc/carls/.carlsrc.json. Making the directory 700 would
    # break the link for everyone but root.
    sudo_cmd chmod 755 /etc/carls 2>/dev/null || true
    sudo_cmd ln -sf "$PREFIX/.carlsrc.json" "$sys"
    sudo_cmd chmod 644 "$PREFIX/.carlsrc.json" 2>/dev/null || true
    ok "Linked system config $sys"
  else
    info "Skipping the system-wide config (no root). Per-user config still applies."
  fi
}

do_install() {
  say ""
  say "${C_BOLD}${C_CYAN}carls-code installer${C_RESET}"
  say ""

  ensure_node
  export PATH="$CARLS_NODE_DIR/bin:$PATH"

  if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ] && [ -z "$MODE" ]; then
    show_panel
    prompt_mode
    prompt_effort
  fi
  [ -n "$MODE" ] || MODE="ask"

  info "Installing into $PREFIX"
  mkdir -p "$PREFIX" || die "Cannot create $PREFIX"
  mkdir -p "$CARLS_APP_DIR" || die "Cannot create $CARLS_APP_DIR"

  repo_root="$(cd "$(dirname "$0")/.." && pwd)"

  # Build from source when the TypeScript sources are present, otherwise use a
  # prebuilt dist/ shipped in the package.
  if [ -f "$repo_root/package.json" ] && [ -d "$repo_root/src" ]; then
    info "Building from source in $repo_root"
    mkdir -p "$CARLS_APP_DIR"
    # Copy sources only; node_modules and previous builds are rebuilt below.
    ( cd "$repo_root" && tar cf - \
        --exclude=node_modules --exclude=dist --exclude=.git --exclude='*.log' . ) \
      | ( cd "$CARLS_APP_DIR" && tar xf - ) >>"$LOG_FILE" 2>&1 || die "Copy failed"
    # Full install (not --omit=dev): the build needs typescript and vitest.
    ( cd "$CARLS_APP_DIR" && npm install --no-audit --no-fund >>"$LOG_FILE" 2>&1 ) \
      || die "npm install failed (see $LOG_FILE)"
    ( cd "$CARLS_APP_DIR" && npm run build >>"$LOG_FILE" 2>&1 ) \
      || die "build failed (see $LOG_FILE)"
    # Trim the tree to production deps now that dist/ exists.
    ( cd "$CARLS_APP_DIR" && npm prune --omit=dev >>"$LOG_FILE" 2>&1 ) || true
  else
    die "No sources found next to this script; run it from the repository root."
  fi

  chmod -R a+rX "$PREFIX"
  write_launcher
  link_globals
  write_config
  link_system_config

  say ""
  panel "${C_GREEN}Installed${C_RESET}" \
    "binary   ${C_GRAY}$PREFIX/bin/carls${C_RESET}" \
    "config   ${C_GRAY}$PREFIX/.carlsrc.json${C_RESET}" \
    "provider ${C_GRAY}$(detect_provider)${C_RESET}" \
    "mode     ${C_GRAY}$MODE${C_RESET}" \
    "effort   ${C_GRAY}${EFFORT:-off}${C_RESET}"
  say "Run ${C_BOLD}carls${C_RESET} to start, or ${C_BOLD}carls \"your task\"${C_RESET} for one shot."
  say "List providers with ${C_BOLD}carls --providers${C_RESET}; diagnose with ${C_BOLD}carls --doctor${C_RESET}."
  if [ -z "$(detect_credential)" ]; then
    say "No API key was found: the first run asks for a provider and a key."
    say "Reconfigure at any time with ${C_BOLD}carls --setup${C_RESET}; list providers with ${C_BOLD}carls --providers${C_RESET}."
  fi
  say "Inside the REPL: ${C_BOLD}/models${C_RESET} picks a model, ${C_BOLD}/mode${C_RESET} changes permissions."
  say ""
}

do_uninstall() {
  info "Removing carls…"
  # Only remove links that point at this prefix, so uninstalling a user install
  # cannot break a system-wide one (or the other way round).
  for dir in /usr/local/bin "$HOME/.local/bin"; do
    if [ -L "$dir/carls" ]; then
      target="$(readlink "$dir/carls" 2>/dev/null || true)"
      case "$target" in
        "$PREFIX/bin/carls"|"$PREFIX/bin/carls/"*)
          rm -f "$dir/carls" 2>/dev/null || sudo_cmd rm -f "$dir/carls"
          ok "Removed $dir/carls"
          ;;
        *)
          info "Left $dir/carls alone (it points at $target, not $PREFIX)."
          ;;
      esac
    fi
  done
  if [ -L /etc/carls/.carlsrc.json ]; then
    sudo_cmd rm -f /etc/carls/.carlsrc.json 2>/dev/null || true
  fi
  if [ -n "$PREFIX" ] && [ -d "$PREFIX" ]; then
    rm -rf "$PREFIX" 2>/dev/null || sudo_cmd rm -rf "$PREFIX"
    ok "Removed $PREFIX"
  fi
  ok "Uninstalled."
}

# -------------------------------------------------------------------- entry

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    -p|--prefix) PREFIX="$2"; shift ;;
    -m|--mode) MODE="$2"; shift ;;
    --model) MODEL="$2"; shift ;;
    --provider) PROVIDER="$2"; shift ;;
    --effort) EFFORT="$2"; shift ;;
    --context-window) CONTEXT_WINDOW="$2"; shift ;;
    --base-url) BASE_URL="$2"; shift ;;
    --api-key) API_KEY="$2"; shift ;;
    --no-node) INSTALL_NODE=0 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown flag $1 (try --help)" ;;
  esac
  shift
done

[ -n "$PREFIX" ] || PREFIX="$([ "$(id -u)" -eq 0 ] && echo /opt/carls || echo "$HOME/.local/carls")"
CARLS_APP_DIR="$PREFIX/app"
CARLS_NODE_DIR="$PREFIX/node"

if [ "$DO_UNINSTALL" -eq 1 ]; then do_uninstall; exit 0; fi

do_install
