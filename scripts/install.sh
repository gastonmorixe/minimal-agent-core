#!/usr/bin/env bash
# Installer for minimal-agent.
#
# There is nothing to `bun install`. The agent runs TypeScript from source on
# Bun. This script clones (or reuses) the source tree and puts
# `minimal-agent` and `ma` on PATH. First interactive launch then signs in,
# fetches mdstream, and clones the plugins repo.
#
# bunx github:gastonmorixe/minimal-agent-core does NOT work. bunx always
# runs `bun install`, then dies on the in-tree `workspace:*` plugin-api
# dependency and would still pull the toolchain (biome, oxlint, husky).
# Skip that path.
#
# One-liner (private repo needs a GitHub token):
#   curl -fsSL -H "Authorization: Bearer $(gh auth token)" \
#     https://raw.githubusercontent.com/gastonmorixe/minimal-agent-core/main/scripts/install.sh \
#     | bash
#
# From a checkout: ./scripts/install.sh
set -euo pipefail

DEFAULT_REPO="https://github.com/gastonmorixe/minimal-agent-core.git"
MIN_BUN="1.4.2"

error() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo "$*"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

tildify() {
  local path="$1"
  if [[ -n "${HOME:-}" && "$path" == "$HOME"/* ]]; then
    echo "~/${path#"$HOME"/}"
  else
    echo "$path"
  fi
}

semver_ge() {
  # Return 0 when $1 >= $2. Extra labels after - or + are stripped.
  local a b
  a="${1%%[-+]*}"
  b="${2%%[-+]*}"
  local IFS=.
  # shellcheck disable=SC2086
  set -- $a
  local a1=${1:-0} a2=${2:-0} a3=${3:-0}
  # shellcheck disable=SC2086
  set -- $b
  local b1=${1:-0} b2=${2:-0} b3=${3:-0}
  if ((a1 != b1)); then
    ((a1 > b1))
    return
  fi
  if ((a2 != b2)); then
    ((a2 > b2))
    return
  fi
  ((a3 >= b3))
}

resolve_token() {
  if [[ -n "${MINIMAL_AGENT_GITHUB_TOKEN:-}" ]]; then
    echo "$MINIMAL_AGENT_GITHUB_TOKEN"
    return 0
  fi
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    echo "$GITHUB_TOKEN"
    return 0
  fi
  if [[ -n "${GH_TOKEN:-}" ]]; then
    echo "$GH_TOKEN"
    return 0
  fi
  if have gh; then
    local tok
    tok="$(gh auth token 2>/dev/null || true)"
    if [[ -n "$tok" ]]; then
      echo "$tok"
      return 0
    fi
  fi
  return 1
}

is_https_github() {
  [[ "$1" =~ ^https://([^/]*github\.com)/ ]]
}

run_git() {
  local token="${1-}"
  shift
  if [[ -n "$token" ]]; then
    # Token stays in MA_GIT_TOKEN. argv only references the env var.
    env GIT_TERMINAL_PROMPT=0 MA_GIT_TOKEN="$token" git \
      -c 'credential.helper=!f() { echo username=x-access-token; echo password=$MA_GIT_TOKEN; }; f' \
      "$@"
  else
    env GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}

append_path_line() {
  local file="$1"
  local line="$2"
  if [[ ! -f "$file" ]]; then
    return 1
  fi
  if grep -Fqs "$line" "$file"; then
    return 0
  fi
  if [[ ! -w "$file" ]]; then
    return 1
  fi
  {
    echo ""
    echo "# minimal-agent"
    echo "$line"
  } >>"$file"
}

case "$(uname -s)" in
  Darwin | Linux) ;;
  *) error "macOS or Linux required (got $(uname -s))" ;;
esac

if ! have bun; then
  error "bun is required. Install it with: curl -fsSL https://bun.sh/install | bash"
fi

bun_ver="$(bun --version 2>/dev/null || true)"
if [[ -z "$bun_ver" ]]; then
  error "could not read bun --version"
fi
if ! semver_ge "$bun_ver" "$MIN_BUN"; then
  error "bun >= $MIN_BUN required (found $bun_ver). Upgrade with: bun upgrade"
fi

agent_home="${MINIMAL_AGENT_HOME:-${HOME:?HOME is not set}/.minimal-agent}"
bin_dir="${MINIMAL_AGENT_BIN_DIR:-$agent_home/bin}"
src_dir="${MINIMAL_AGENT_SRC:-}"
repo="${MINIMAL_AGENT_REPO:-$DEFAULT_REPO}"
skip_path="${MINIMAL_AGENT_INSTALL_NO_PATH:-}"
force_clone="${MINIMAL_AGENT_FORCE_CLONE:-}"

this="${BASH_SOURCE[0]:-}"
if [[ -z "$src_dir" && -z "$force_clone" && -n "$this" && -f "$this" ]]; then
  root="$(cd "$(dirname "$this")/.." && pwd)"
  if [[ -f "$root/src/index.ts" && -f "$root/minimal-agent" ]]; then
    src_dir="$root"
  fi
fi

if [[ -z "$src_dir" ]]; then
  if ! have git; then
    error "git is required to clone $repo"
  fi
  src_dir="$agent_home/src"
  token=""
  if token="$(resolve_token)"; then
    :
  else
    token=""
  fi
  use_helper=0
  if [[ -n "$token" ]] && is_https_github "$repo"; then
    use_helper=1
  fi
  mkdir -p "$(dirname "$src_dir")"
  if [[ -d "$src_dir/.git" ]]; then
    info "updating $(tildify "$src_dir")"
    if [[ "$use_helper" == "1" ]]; then
      run_git "$token" -C "$src_dir" fetch --depth 1 -- origin
    else
      run_git "" -C "$src_dir" fetch --depth 1 -- origin
    fi
    if ! git -C "$src_dir" diff --quiet --ignore-submodules; then
      error "$(tildify "$src_dir") has local changes. Commit or stash them, then re-run."
    fi
    if ! git -C "$src_dir" merge --ff-only FETCH_HEAD >/dev/null; then
      error "$(tildify "$src_dir") cannot fast-forward. Delete it and re-run, or pull by hand."
    fi
  elif [[ -e "$src_dir" ]]; then
    error "$(tildify "$src_dir") exists and is not a git checkout"
  else
    info "cloning $repo -> $(tildify "$src_dir")"
    if [[ "$use_helper" == "1" ]]; then
      if ! run_git "$token" clone --depth 1 -- "$repo" "$src_dir"; then
        error "clone failed. For a private repo set MINIMAL_AGENT_GITHUB_TOKEN or run: gh auth login"
      fi
    else
      if ! run_git "" clone --depth 1 -- "$repo" "$src_dir"; then
        error "clone failed. For a private repo set MINIMAL_AGENT_GITHUB_TOKEN or run: gh auth login"
      fi
    fi
  fi
fi

if [[ ! -f "$src_dir/src/index.ts" ]]; then
  error "no src/index.ts in $(tildify "$src_dir")"
fi
if [[ ! -f "$src_dir/minimal-agent" ]]; then
  error "no minimal-agent wrapper in $(tildify "$src_dir")"
fi

chmod +x "$src_dir/minimal-agent"
mkdir -p "$bin_dir"
ln -sfn "$src_dir/minimal-agent" "$bin_dir/minimal-agent"
ln -sfn "$src_dir/minimal-agent" "$bin_dir/ma"
chmod +x "$bin_dir/minimal-agent" "$bin_dir/ma"

# Also link into a user bin that is already on PATH when we can, so
# `minimal-agent` / `ma` work in this shell without a restart.
# Prefer ~/.local/bin (XDG, Linux + modern macOS). Never overwrite a
# foreign file that is not our symlink.
link_user_bin() {
  local dest="$1"
  mkdir -p "$dest"
  local name
  for name in minimal-agent ma; do
    local target="$dest/$name"
    if [[ -e "$target" || -L "$target" ]]; then
      if [[ -L "$target" ]]; then
        ln -sfn "$src_dir/minimal-agent" "$target"
      else
        info "skip $(tildify "$target"): exists and is not a symlink"
      fi
    else
      ln -sfn "$src_dir/minimal-agent" "$target"
    fi
  done
}

path_has() {
  local dir="$1"
  [[ ":$PATH:" == *":$dir:"* ]]
}

user_bin=""
if [[ -z "$skip_path" ]]; then
  if path_has "$HOME/.local/bin" || [[ ! -e "$HOME/.local/bin" ]]; then
    user_bin="$HOME/.local/bin"
  elif path_has "$HOME/bin"; then
    user_bin="$HOME/bin"
  else
    user_bin="$HOME/.local/bin"
  fi
  link_user_bin "$user_bin"
fi

if [[ -e "$src_dir/node_modules" ]]; then
  info "note: $(tildify "$src_dir") already has node_modules (dev checkout). Runtime does not need it."
fi

if [[ -z "$skip_path" ]]; then
  export_line="export PATH=\"$bin_dir:\$PATH\""
  fish_line="set --export PATH $bin_dir \$PATH"
  case "$(basename "${SHELL:-}")" in
    fish)
      fish_config="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
      if [[ ! -f "$fish_config" ]]; then
        mkdir -p "$(dirname "$fish_config")"
        : >"$fish_config"
      fi
      if append_path_line "$fish_config" "$fish_line"; then
        info "added $(tildify "$bin_dir") to PATH in $(tildify "$fish_config")"
      fi
      ;;
    zsh)
      if [[ ! -f "$HOME/.zshrc" ]]; then
        : >"$HOME/.zshrc"
      fi
      if append_path_line "$HOME/.zshrc" "$export_line"; then
        info "added $(tildify "$bin_dir") to PATH in ~/.zshrc"
      fi
      ;;
    bash)
      bash_rc=""
      for cand in "$HOME/.bashrc" "$HOME/.bash_profile"; do
        if [[ -f "$cand" ]]; then
          bash_rc="$cand"
          break
        fi
      done
      if [[ -z "$bash_rc" ]]; then
        bash_rc="$HOME/.bashrc"
        : >"$bash_rc"
      fi
      if append_path_line "$bash_rc" "$export_line"; then
        info "added $(tildify "$bin_dir") to PATH in $(tildify "$bash_rc")"
      fi
      ;;
    *)
      if [[ ! -f "$HOME/.profile" ]]; then
        : >"$HOME/.profile"
      fi
      if append_path_line "$HOME/.profile" "$export_line"; then
        info "added $(tildify "$bin_dir") to PATH in ~/.profile"
      fi
      ;;
  esac
  if [[ -n "$user_bin" ]] && ! path_has "$user_bin"; then
    user_export="export PATH=\"$user_bin:\$PATH\""
    user_fish="set --export PATH $user_bin \$PATH"
    case "$(basename "${SHELL:-}")" in
      fish)
        append_path_line "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" "$user_fish" || true
        ;;
      zsh)
        append_path_line "$HOME/.zshrc" "$user_export" || true
        ;;
      bash)
        append_path_line "${bash_rc:-$HOME/.bashrc}" "$user_export" || true
        ;;
      *)
        append_path_line "$HOME/.profile" "$user_export" || true
        ;;
    esac
  fi
fi

info ""
info "installed $(tildify "$bin_dir/minimal-agent") and $(tildify "$bin_dir/ma")"
if [[ -n "$user_bin" ]]; then
  info "also    $(tildify "$user_bin/minimal-agent") and $(tildify "$user_bin/ma")"
fi
info "source  $(tildify "$src_dir")"
info "no bun install ran. there are no runtime npm deps."
info ""
info "start:"
if have minimal-agent || path_has "$bin_dir" || { [[ -n "$user_bin" ]] && path_has "$user_bin"; }; then
  info "  minimal-agent"
  info "  ma"
else
  info "  $bin_dir/minimal-agent"
  info "  $bin_dir/ma"
  info "  (open a new shell, or add $(tildify "$bin_dir") to PATH)"
fi
