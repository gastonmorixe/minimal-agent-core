#!/usr/bin/env bash
# Test a single model. Used by parallel runner.
# Optional: set INSPECTOR to the absolute path of a bun --preload module that
# writes fetch captures to NETLOG_DIR (e.g. node-network-inspector). If unset,
# the script runs without network capture.
set -euo pipefail
model="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

INSPECTOR="${INSPECTOR:-}"
if [[ -n "${INSPECTOR}" ]]; then
  preload_args=(--preload="${INSPECTOR}")
else
  preload_args=()
fi

output=$(echo "Reply with exactly one word: PONG" | \
  NETLOG_DISK=1 NETLOG_FETCH=1 NETLOG_CONSOLE=0 NETLOG_DIR=".node-net-dbg" \
  bun "${preload_args[@]}" \
  src/index.ts --model "$model" 2>/dev/null \
  | grep -v "^>" | grep -v "^minimal" | grep -v "^$" | grep -v "^Bye" | grep -v "^╭\|^│\|^├\|^╰\|^  " | head -3)
if echo "$output" | grep -qi "PONG"; then
  printf "\033[32mPASS\033[0m  %s\n" "$model"
else
  printf "\033[31mFAIL\033[0m  %s  %s\n" "$model" "$(echo "$output" | head -1 | cut -c1-60)"
fi
