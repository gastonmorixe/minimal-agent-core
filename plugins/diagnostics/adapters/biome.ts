/**
 * Adapter: biome `check --reporter=json` output → {@link Finding}[].
 *
 * biome shape (captured from the real binary):
 * ```
 *   { summary:{errors,warnings,...},
 *     diagnostics:[ { severity:"error"|"warning"|"information", category:"lint/...",
 *       description?|message?, location:{ path, start:{line,column}, end } } ] }
 * ```
 *
 * `message` may be a plain string OR an array of `{content}` spans (biome's
 * markup form); we flatten both. `description` is the fallback. 1-based
 * line/column from `location.start` are used directly.
 *
 * Pure + total: parse failure yields `[]`.
 *
 * @module plugins/diagnostics/adapters/biome
 */
import type { Finding, FindingSeverity } from "../lib/types.ts"

function severityOf(s: unknown): FindingSeverity {
  if (s === "error") return "error"
  if (s === "warning") return "warning"
  return "info"
}

/** Flatten biome's message (string OR `{content}[]`) plus description fallback. */
function messageOf(rec: Record<string, unknown>): string {
  // The bare `format` category carries a verbose, agent-unfriendly message
  // ("Formatter would have printed the following content:"). Replace it with a
  // concise, actionable line; the code (`format`) already says what it is.
  if (rec.category === "format") return "File is not formatted (run the formatter)."
  const m = rec.message
  if (typeof m === "string" && m.length > 0) return m
  if (Array.isArray(m)) {
    const joined = m
      .map((seg) =>
        seg && typeof seg === "object" ? String((seg as { content?: unknown }).content ?? "") : "",
      )
      .join("")
    if (joined.length > 0) return joined
  }
  if (typeof rec.description === "string") return rec.description
  return ""
}

/**
 * Converts `biome check --reporter=json` stdout into neutral {@link Finding}s.
 * Total function: malformed or empty JSON yields `[]` so the runner degrades
 * instead of throwing. Biome's 0-based sourceSpan offsets are translated to
 * the 1-based line/column findings use.
 */
export function adaptBiome(stdout: string): Finding[] {
  if (!stdout || stdout.trim().length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  const diags = (parsed as { diagnostics?: unknown }).diagnostics
  if (!Array.isArray(diags)) return []
  const out: Finding[] = []
  for (const d of diags) {
    if (!d || typeof d !== "object") continue
    const rec = d as Record<string, unknown>
    const message = messageOf(rec)
    if (!message) continue
    const loc = rec.location as Record<string, unknown> | undefined
    const start = loc?.start as Record<string, unknown> | undefined
    const finding: Finding = {
      source: "biome",
      severity: severityOf(rec.severity),
      message,
      ...(typeof rec.category === "string" ? { code: rec.category } : {}),
      // biome reports whole-file findings (e.g. `format`) at 0:0, which isn't a
      // valid 1-based position : omit the location so it doesn't render as 0:0.
      ...(start && typeof start.line === "number" && start.line > 0 ? { line: start.line } : {}),
      ...(start && typeof start.column === "number" && start.column > 0
        ? { col: start.column }
        : {}),
      ...(loc && typeof loc.path === "string" ? { path: loc.path } : {}),
    }
    out.push(finding)
  }
  return out
}
