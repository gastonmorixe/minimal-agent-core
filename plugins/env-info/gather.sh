#!/usr/bin/env bash
#
# Parallel environment-snapshot probe.
#
# Each probe runs in the background and prints a single `key=value` line to
# its own temp file, then `wait` joins them. Wall time ≈ slowest probe.
# Failures are swallowed (missing binary, non-zero exit, empty output) — the
# probe just emits an empty value rather than blowing up the whole snapshot.
#
# Output format is a fenced markdown block so the assistant sees it as data,
# not prose. The producer is the loader's prompt-fragment subprocess path:
# stdout is captured verbatim and embedded inside the env-info plugin's
# <plugin id="env-info"> block in the system prompt.
#
# Stays under the 2s default fragment timeout on a typical mac/linux box.

set -u

# A consumer that closes its pipe early (e.g. a test that cancels the
# loader before reading stdout) causes SIGPIPE on write. Silence the
# resulting "broken pipe" diagnostics so they don't pollute test output.
trap '' PIPE

# Run a single probe in the background. Args:
#   $1  key name
#   $@  command (arrays preserved via "$@")
#
# Newlines in the value are collapsed to spaces so each probe always emits
# exactly one line. Errors → empty value.
probe() {
  local key="$1"; shift
  local val
  val="$("$@" 2>/dev/null)" || val=""
  # Collapse any embedded newlines and trim trailing whitespace.
  val="${val//$'\n'/ }"
  val="${val%"${val##*[![:space:]]}"}"
  printf '%s=%s\n' "$key" "$val"
}

# All probes run concurrently. `&` + `wait` is the simplest portable
# fan-out/join on stock bash (no GNU parallel, no xargs gymnastics).
{
  probe os_name        uname -s &
  probe os_arch        uname -m &
  probe os_kernel      uname -r &
  probe os_product     bash -c 'sw_vers -productVersion 2>/dev/null || (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")' &
  probe hostname       uname -n &
  probe user           bash -c 'echo "${USER:-$(id -un)}"' &
  probe home           bash -c 'echo "$HOME"' &
  probe shell          bash -c 'echo "$SHELL"' &
  probe cwd            bash -c 'echo "$PWD"' &
  probe term           bash -c 'echo "$TERM"' &
  probe term_program   bash -c 'echo "${TERM_PROGRAM:-}"' &
  probe colorterm      bash -c 'echo "${COLORTERM:-}"' &
  probe in_tmux        bash -c '[ -n "${TMUX:-}" ] && echo yes || echo no' &
  probe lang           bash -c 'echo "${LANG:-}"' &
  probe editor         bash -c 'echo "${EDITOR:-${VISUAL:-}}"' &
  probe date_iso       bash -c 'date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S%z' &
  probe timezone       date +%Z &
  # tput defaults to fd 1 (stdout) for the ioctl; that's a pipe here, so
  # ask the controlling tty directly via stty. Env vars LINES/COLUMNS win
  # if the agent set them (preferred path — they reflect the live size).
  probe term_cols      bash -c '
    if [ -n "${COLUMNS:-}" ]; then echo "$COLUMNS"
    elif [ -r /dev/tty ]; then stty size </dev/tty 2>/dev/null | awk "{print \$2}"
    else tput cols
    fi
  ' &
  probe term_lines     bash -c '
    if [ -n "${LINES:-}" ]; then echo "$LINES"
    elif [ -r /dev/tty ]; then stty size </dev/tty 2>/dev/null | awk "{print \$1}"
    else tput lines
    fi
  ' &
  probe cpu_count      bash -c 'sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null' &
  probe hw_model       bash -c 'sysctl -n hw.model 2>/dev/null || cat /sys/class/dmi/id/product_name 2>/dev/null' &
  # Chassis classification: mac → MacBook? = laptop, else desktop.
  # Linux → /sys/class/dmi/id/chassis_type (3=desktop, 9/10/14=laptop).
  probe chassis        bash -c '
    m=$(sysctl -n hw.model 2>/dev/null || true)
    if [ -n "$m" ]; then
      case "$m" in
        MacBook*) echo laptop ;;
        iMac*|Macmini*|MacPro*|MacStudio*|Mac1*|Mac14*|Mac15*) echo desktop ;;
        *) echo "$m" ;;
      esac
      exit 0
    fi
    t=$(cat /sys/class/dmi/id/chassis_type 2>/dev/null || true)
    case "$t" in
      3|4|6|7) echo desktop ;;
      9|10|14) echo laptop ;;
      *) echo unknown ;;
    esac
  ' &
  probe git_branch     git symbolic-ref --short HEAD &
  probe git_dirty      bash -c '[ -n "$(git status --porcelain 2>/dev/null | head -1)" ] && echo yes || echo no' &
  probe git_default    bash -c 'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s|refs/remotes/origin/||"' &
  # Agent-supplied identifiers. Both env vars are set by the loader
  # (TUI_PLUGIN_DIR is always set; MINIMAL_AGENT_SESSION_ID is set when
  # the agent passes a sessionId to PluginLoader.load).
  probe session_id     bash -c 'echo "${MINIMAL_AGENT_SESSION_ID:-}"' &
  probe plugin_dir     bash -c 'echo "${TUI_PLUGIN_DIR:-}"' &
  # The agent (src/index.ts) sets MINIMAL_AGENT_MODEL to the resolved
  # model id (--model arg or DEFAULT_MODEL fallback) before loader.load.
  probe model          bash -c 'echo "${MINIMAL_AGENT_MODEL:-}"' &
  # Agent process id. The loader exports MINIMAL_AGENT_PID via
  # `agentContextToEnv`; $PPID is the bash-spawn fallback when this
  # script is invoked outside the agent (no MINIMAL_AGENT_PID set).
  probe pid            bash -c 'echo "${MINIMAL_AGENT_PID:-$PPID}"' &
  # Agent semver from package.json, also via agentContextToEnv.
  probe version        bash -c 'echo "${MINIMAL_AGENT_VERSION:-}"' &
  wait
} > /tmp/env-info-$$.out

# Sort for deterministic output (stable system-prompt hash if we ever
# wanted it, and easier diffing across sessions).
sort /tmp/env-info-$$.out > /tmp/env-info-$$.sorted
rm -f /tmp/env-info-$$.out

# Emit a fenced ini-ish block so the model sees it as structured data. The
# loader composes this fragment into a <ma::sys::context name="environment">
# section, so we do NOT add our own wrapper tag here (a bare <env> would be
# the lone tag in the whole prompt outside the <ma::*> namespace).
# stderr is redirected for the whole emit so a closed pipe (test cancellation,
# loader teardown) doesn't print "broken pipe" diagnostics.
{
  echo '```ini'
  cat /tmp/env-info-$$.sorted
  echo '```'
} 2>/dev/null
rm -f /tmp/env-info-$$.sorted
