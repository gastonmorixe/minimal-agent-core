/**
 * Adapter: oxlint `-f json` output → {@link Finding}[].
 *
 * oxlint shape (captured from the real binary):
 * ```
 *   { diagnostics: [ { message, code:"eslint(no-debugger)", severity:"error"|"warning",
 *     help?, filename, labels:[{ span:{ offset, length, line, column } }] } ] }
 * ```
 *
 * Pure + total: any parse failure yields `[]` (the runner degrades, never
 * throws). The 1-based line/column from oxlint's span is used directly.
 *
 * @module plugins/diagnostics/adapters/oxlint
 */
import type { Finding, FindingSeverity } from "../lib/types.ts"

function severityOf(s: unknown): FindingSeverity {
  return s === "error" ? "error" : s === "warning" ? "warning" : "info"
}

/**
 * Converts `oxlint --format=json` stdout into neutral {@link Finding}s,
 * keeping only the first line of each message. Total function: any parse
 * failure yields `[]` so the runner degrades instead of throwing.
 */
export function adaptOxlint(stdout: string): Finding[] {
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
    const message = typeof rec.message === "string" ? rec.message.split("\n")[0] : ""
    if (!message) continue
    const span =
      Array.isArray(rec.labels) && rec.labels[0] && typeof rec.labels[0] === "object"
        ? ((rec.labels[0] as Record<string, unknown>).span as Record<string, unknown> | undefined)
        : undefined
    const finding: Finding = {
      source: "oxlint",
      severity: severityOf(rec.severity),
      message,
      ...(typeof rec.code === "string" ? { code: rec.code } : {}),
      ...(span && typeof span.line === "number" ? { line: span.line } : {}),
      ...(span && typeof span.column === "number" ? { col: span.column } : {}),
      ...(typeof rec.filename === "string" ? { path: rec.filename } : {}),
    }
    out.push(finding)
  }
  return out
}
