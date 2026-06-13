/**
 * Shared diff renderer for the diff-view plugin.
 *
 * Takes a unified diff string and returns an ANSI-colored version:
 * additions in modern green (lime), deletions in modern hot pink, hunk
 * headers in cyan, file headers bold. Keeps everything else untouched.
 *
 * # Color sourcing
 *
 * The agent owns its palette in `src/palette.ts` and exposes it to plugins
 * as a JSON map in `MINIMAL_AGENT_PALETTE`. This renderer prefers those
 * tokens (so we always match the agent's chrome — the prompt arrow,
 * banner, etc.) and falls back to local defaults that *also* point at the
 * Cool-Summer modern palette so direct callers (tests, CLIs) get the
 * same look without any setup.
 *
 * Plugins are encouraged but not required to read `MINIMAL_AGENT_PALETTE`
 * — every entry is a plain SGR-open string and ignoring it just means
 * picking your own colors.
 *
 * Minimal and dependency-free. Not a full patch parser; it just decorates
 * lines by their first-character prefix, which is enough for unified-diff
 * output from `git diff` and friends.
 */

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"

// Local fallback defaults. These match the agent's modern palette
// (`pink` = 199, `lime` = 118) so the look is consistent even when
// `MINIMAL_AGENT_PALETTE` isn't injected.
const FALLBACK_REMOVAL = "\x1b[38;5;199m" // hot pink / magenta
const FALLBACK_ADDITION = "\x1b[38;5;118m" // vivid spring green
const FALLBACK_HUNK = "\x1b[36m" // cyan

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
 * Render a unified diff as ANSI-colored lines (additions lime, deletions
 * pink, hunk headers cyan), with an optional title heading.
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
