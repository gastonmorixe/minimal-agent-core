/**
 * Adapter: `tsc --noEmit --pretty false` output → {@link Finding}[].
 *
 * tsc stdout format (--pretty false):
 *   relative/path(line,col): error TS2322: message
 *   relative/path(line,col): warning TS6133: message
 *
 * Multi-line messages (e.g. assignability errors) continue on indented
 * lines. Those are folded into the preceding finding's message.
 *
 * Pure function: string in, Finding[] out. Tolerates empty input and
 * garbled lines by skipping them. The caller handles exiting the process.
 *
 * @module plugins/diagnostics/adapters/tsc
 */
import type { Finding, FindingSeverity } from "../lib/types.ts"

/** Regex for a tsc error/warning line: path(line,col): severity TScode: message */
const LINE_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/

/** Regex for a continuation line: starts with whitespace */
const CONT_RE = /^\s{2,}(.+)$/

function severityOf(word: string): FindingSeverity {
  return word === "error" ? "error" : "warning"
}

/**
 * Parse `tsc --noEmit --pretty false` output into {@link Finding}[],
 * optionally filtering to a specific `filePath`. Multi-line messages
 * are folded into the preceding finding.
 */
export function adaptTscOutput(stdout: string, source = "tsc", filePath?: string): Finding[] {
  const lines = stdout.split("\n")
  const findings: Finding[] = []

  for (const line of lines) {
    const trimmed = line.trimEnd()
    const errMatch = trimmed.match(LINE_RE)
    if (errMatch) {
      const [, path, lineStr, colStr, sevWord, codeNum, msg] = errMatch
      // Skip if filtering to a specific file and this isn't it.
      // Match against the suffix so both "steps/foo.ts" and
      // "/abs/path/steps/foo.ts" match a filter of "steps/foo.ts".
      if (filePath && !path.endsWith(filePath) && !filePath.endsWith(path)) continue

      findings.push({
        source,
        severity: severityOf(sevWord),
        line: Number(lineStr),
        col: Number(colStr),
        code: `TS${codeNum}`,
        message: msg,
      })
      continue
    }

    // Continuation line: append to previous finding's message.
    const contMatch = trimmed.match(CONT_RE)
    if (contMatch && findings.length > 0) {
      const prev = findings[findings.length - 1]
      prev.message += ` ${contMatch[1]}`
    }
    // Everything else (blank lines, summary lines like "Found 5 errors.") is skipped.
  }

  return findings
}
