/**
 * Model-facing note formatting + finding filtering.
 *
 * Keeps diagnostics compact so they don't pollute the model's context: a
 * severity floor (allowlist), dedup, and a hard cap with errors prioritized
 * over warnings. Each kept finding renders as one terse line the agent wraps in
 * the `<ma::agent::diagnostics>` annotation.
 *
 * Pure functions, trivially unit-tested.
 *
 * @module plugins/diagnostics/lib/format-notes
 */
import type { Finding, FindingSeverity } from "./types.ts"

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 }

export interface FilterOptions {
  /** Minimum severity to keep: `"error"` | `"warning"` | `"info"`. */
  severityFloor: FindingSeverity
  /** Maximum findings to keep (errors before warnings before info). */
  max: number
}

/** A stable identity for dedup: same place + same code + same text. */
function identity(f: Finding): string {
  return `${f.source}|${f.line ?? ""}|${f.col ?? ""}|${f.code ?? ""}|${f.message}`
}

/**
 * Apply the severity floor, dedup, sort (errors first), and cap. Returns a new
 * array; the input is not mutated.
 */
export function filterFindings(findings: Finding[], opts: FilterOptions): Finding[] {
  const floor = SEVERITY_RANK[opts.severityFloor]
  const seen = new Set<string>()
  const kept: Finding[] = []
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > floor) continue
    const id = identity(f)
    if (seen.has(id)) continue
    seen.add(id)
    kept.push(f)
  }
  // Stable sort by severity so the cap keeps errors first.
  kept.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  return kept.slice(0, Math.max(0, opts.max))
}

/** Render one finding as `[scope] [line:col] severity [code] message`. */
export function formatNote(f: Finding): string {
  const scope = f.scope === "ad-hoc" ? "[ad-hoc] " : ""
  const loc =
    typeof f.line === "number"
      ? typeof f.col === "number"
        ? `${f.line}:${f.col} `
        : `${f.line} `
      : ""
  const code = f.code ? `${f.code} ` : ""
  return `${scope}${loc}${f.severity} ${code}${f.message}`
}
