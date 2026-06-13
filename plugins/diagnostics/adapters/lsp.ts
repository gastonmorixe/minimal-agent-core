/**
 * Adapter: LSP `Diagnostic[]` (from a pull `textDocument/diagnostic` or a push
 * `publishDiagnostics`) → {@link Finding}[].
 *
 * LSP shape:
 *   `{ range:{ start:{line,character}, end }, severity:1|2|3|4, code?, message, source? }`
 *
 * LSP positions are 0-BASED; we convert to the 1-based line/col the rest of the
 * pipeline (and the editor's gutter) uses. Numeric TypeScript codes are
 * prefixed `TS` (so `2322` → `TS2322`); string codes pass through. `source`
 * parameter labels the producer (`"tsgo"`).
 *
 * Pure + total: a non-array input yields `[]`.
 *
 * @module plugins/diagnostics/adapters/lsp
 */
import type { Finding, FindingSeverity } from "../lib/types.ts"

/** LSP DiagnosticSeverity: 1=Error 2=Warning 3=Information 4=Hint. */
function severityOf(n: unknown): FindingSeverity {
  if (n === 1) return "error"
  if (n === 2) return "warning"
  return "info"
}

function codeOf(code: unknown): string | undefined {
  if (typeof code === "number") return `TS${code}`
  if (typeof code === "string" && code.length > 0) return code
  return undefined
}

/**
 * Converts an LSP `Diagnostic[]` payload into neutral {@link Finding}s tagged
 * with `source` (e.g. `"tsgo"`). Tolerates malformed entries by skipping
 * them, maps LSP severity 1/2 to error/warning (everything else info), and
 * converts the 0-based LSP positions to 1-based line/column.
 */
export function adaptLspDiagnostics(items: unknown, source: string): Finding[] {
  if (!Array.isArray(items)) return []
  const out: Finding[] = []
  for (const d of items) {
    if (!d || typeof d !== "object") continue
    const rec = d as Record<string, unknown>
    const message = typeof rec.message === "string" ? rec.message : ""
    if (!message) continue
    const range = rec.range as Record<string, unknown> | undefined
    const start = range?.start as Record<string, unknown> | undefined
    const code = codeOf(rec.code)
    const finding: Finding = {
      source,
      severity: severityOf(rec.severity),
      message,
      ...(code !== undefined ? { code } : {}),
      ...(start && typeof start.line === "number" ? { line: start.line + 1 } : {}),
      ...(start && typeof start.character === "number" ? { col: start.character + 1 } : {}),
    }
    out.push(finding)
  }
  return out
}
