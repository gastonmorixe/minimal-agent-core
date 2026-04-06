#!/usr/bin/env bash
# Test minimal-agent against every available model with network logging.
# Records terminal session + saves raw network captures to disk.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TIMESTAMP="$(date -Iseconds)"
RECORDING="/tmp/recording-all-models-${TIMESTAMP}.recording"
NET_DBG_DIR="${PROJECT_DIR}/.node-net-dbg"
# Optional: set INSPECTOR to the absolute path of a bun --preload module that
# writes fetch captures to NETLOG_DIR (e.g. a node-network-inspector-style tool).
# Leave unset to run without network capture.
INSPECTOR="${INSPECTOR:-}"
ENTRY="${PROJECT_DIR}/src/index.ts"
PROMPT="Reply with exactly one word: PONG"

MODELS=(
  claude-3-haiku-20240307
  claude-haiku-4-5-20251001
  claude-sonnet-4-20250514
  claude-sonnet-4-5-20250929
  claude-sonnet-4-6
  claude-opus-4-20250514
  claude-opus-4-1-20250805
  claude-opus-4-5-20251101
  claude-opus-4-6
)

echo "=== Testing ${#MODELS[@]} models ==="
echo "Net captures: ${NET_DBG_DIR}"
echo "Recording:    ${RECORDING}"
echo ""

PASS=0
FAIL=0
RESULTS=""

for model in "${MODELS[@]}"; do
  printf "%-40s " "${model}"

  if [[ -n "${INSPECTOR}" ]]; then
    preload_args=(--preload="${INSPECTOR}")
  else
    preload_args=()
  fi

  output=$(echo "${PROMPT}" | \
    NETLOG_DISK=1 NETLOG_FETCH=1 NETLOG_DIR="${NET_DBG_DIR}" \
    bun "${preload_args[@]}" "${ENTRY}" --model "${model}" 2>/dev/null \
    | grep -v "^>" | grep -v "^minimal-agent" | grep -v "^$" | grep -v "^Bye" | head -5)

  if echo "${output}" | grep -qi "PONG"; then
    printf "\033[32mPASS\033[0m\n"
    PASS=$((PASS + 1))
    RESULTS="${RESULTS}PASS ${model}\n"
  else
    printf "\033[31mFAIL\033[0m  %s\n" "$(echo "${output}" | head -1 | cut -c1-60)"
    FAIL=$((FAIL + 1))
    RESULTS="${RESULTS}FAIL ${model}: ${output}\n"
  fi
done

echo ""
echo "=== Results: ${PASS} pass, ${FAIL} fail out of ${#MODELS[@]} ==="
echo ""
printf "${RESULTS}"
echo ""
echo "Net captures saved to: ${NET_DBG_DIR}"
