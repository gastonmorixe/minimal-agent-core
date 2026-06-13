/**
 * Shared unified-diff colorizer.
 *
 * Takes a unified diff string and returns an ANSI-colored version:
 * additions in modern green (lime), deletions in modern hot pink, hunk
 * headers in cyan, file headers bold. Keeps everything else untouched.
 *
 * Host code and the diff-view plugin both import this leaf implementation,
 * so their previews cannot drift while preserving the plugin boundary
 * (`src/` never imports from `plugins/`).
 *
 * # Color sourcing
 *
 * The agent owns its palette in `plugin-api/src/utils/palette.ts` and exposes
 * it to subprocess consumers as a JSON map in `MINIMAL_AGENT_PALETTE`. This
 * renderer prefers those tokens and falls back to the shared palette constants
 * so direct callers (tests, CLIs) get the same look without any setup.
 *
 * Minimal and dependency-free. Not a full patch parser; it just
 * decorates lines by their first-character prefix, which is enough for
 * unified-diff output from `git diff` and friends.
 *
 * @module unified-diff
 */

import { ANSI_CODES } from "./ansi.ts"
import { PALETTE } from "./palette.ts"

const { BOLD, DIM, RESET } = ANSI_CODES

// Local fallback defaults. These match the agent's modern palette
// (`pink` = 199, `lime` = 118) so the look is consistent even when
// `MINIMAL_AGENT_PALETTE` isn't injected.
const FALLBACK_REMOVAL = PALETTE.pink
const FALLBACK_ADDITION = PALETTE.lime
const FALLBACK_HUNK = PALETTE.cyan

interface DiffPalette {
  removal: string
  addition: string
  hunk: string
}

/**
 * Resolve the diff colors. Reads `MINIMAL_AGENT_PALETTE` from the
 * environment (semantic tokens `removal`, `addition`, `accent-soft`),
 * falling back to the modern Cool-Summer defaults above.
 */
function resolvePalette(): DiffPalette {
  const raw = typeof process !== "undefined" ? process.env?.MINIMAL_AGENT_PALETTE : undefined
  if (raw) {
    try {
      const p = JSON.parse(raw) as Record<string, string>
      if (p && typeof p === "object") {
        return {
          removal: p.removal ?? p.error ?? p.pink ?? FALLBACK_REMOVAL,
          addition: p.addition ?? p.success ?? p.lime ?? FALLBACK_ADDITION,
          hunk: p["accent-soft"] ?? p.cyan ?? FALLBACK_HUNK,
        }
      }
    } catch {
      /* fall through to defaults */
    }
  }
  return {
    removal: FALLBACK_REMOVAL,
    addition: FALLBACK_ADDITION,
    hunk: FALLBACK_HUNK,
  }
}

/**
 * Colorize a unified-diff string with the agent palette. Optional
 * `title` renders as a bold first line with a dim underline (capped at
 * 64 cells), e.g. `New file: /abs/path`.
 */
export function renderUnifiedDiff(patch: string, title?: string): string {
  const lines = patch.split("\n")
  const out: string[] = []
  const { removal, addition, hunk } = resolvePalette()

  if (title) {
    out.push(`${BOLD}${title}${RESET}`)
    out.push(`${DIM}${"─".repeat(Math.min(title.length + 4, 64))}${RESET}`)
  }

  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      out.push(`${BOLD}${line}${RESET}`)
      continue
    }
    if (line.startsWith("@@")) {
      out.push(`${hunk}${line}${RESET}`)
      continue
    }
    if (line.startsWith("+")) {
      out.push(`${addition}${line}${RESET}`)
      continue
    }
    if (line.startsWith("-")) {
      out.push(`${removal}${line}${RESET}`)
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}
