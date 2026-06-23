#!/usr/bin/env bash
# Build a distributable source tarball for minimal-agent.
#
# minimal-agent runs straight from source on Bun (no compile step), so a
# "build" is a clean snapshot of the tracked source tree. `git archive` gives
# us exactly that: only committed files, no node_modules, no local cruft,
# deterministic for a given commit.
#
# Usage:
#   scripts/build-tarball.sh <ref-label> [out-dir]
#
#   <ref-label>  Version label baked into the file name and tar prefix,
#                e.g. "0.1.0" or "0.1.0-nightly.20260623T064512Z".
#   [out-dir]    Where to write the artifacts (default: ./dist).
#
# Outputs (in <out-dir>):
#   minimal-agent-<ref-label>.tar.gz         the source tarball
#   minimal-agent-<ref-label>.tar.gz.sha256  its SHA-256 checksum
#
# The extracted tree has a single top-level dir `minimal-agent/` so a user can:
#   tar -xzf minimal-agent-<ref>.tar.gz && cd minimal-agent && bun install && ./minimal-agent
set -euo pipefail

REF_LABEL="${1:-}"
OUT_DIR="${2:-dist}"

if [[ -z "${REF_LABEL}" ]]; then
  echo "error: missing <ref-label>" >&2
  echo "usage: scripts/build-tarball.sh <ref-label> [out-dir]" >&2
  exit 2
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: not inside a git work tree" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

NAME="minimal-agent-${REF_LABEL}"
TARBALL="${OUT_DIR}/${NAME}.tar.gz"
PREFIX="minimal-agent/"

# Pin the commit we are archiving so the log line is unambiguous.
COMMIT="$(git rev-parse HEAD)"
echo "Archiving ${COMMIT} -> ${TARBALL} (prefix ${PREFIX})"

git archive --format=tar.gz --prefix="${PREFIX}" -o "${TARBALL}" HEAD

# SHA-256 sidecar. macOS ships `shasum`, Linux runners ship `sha256sum`.
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "${OUT_DIR}" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256" )
elif command -v shasum >/dev/null 2>&1; then
  ( cd "${OUT_DIR}" && shasum -a 256 "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256" )
else
  echo "warning: no sha256 tool found, skipping checksum" >&2
fi

SIZE="$(wc -c < "${TARBALL}" | tr -d ' ')"
echo "Built ${TARBALL} (${SIZE} bytes)"
if [[ -f "${TARBALL}.sha256" ]]; then
  echo "Checksum: $(cat "${TARBALL}.sha256")"
fi
