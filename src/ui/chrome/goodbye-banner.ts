/**
 * Goodbye banner — printed on REPL quit (confirmed or escape-hatch).
 *
 * The banner mirrors the startup banner's frame chrome (`╭│╰` with
 * `c.faintWhite` rails, brand-pink heading) so the session reads as a
 * matched bracket: a small block at the start, a small block at the end.
 *
 * The session id appears on its own line as part of a ready-to-paste
 * `minimal-agent --resume <id>` command, so the user can triple-click
 * the line, copy, and paste into their next shell.
 *
 * The rendering is pure — it returns the lines as `string[]`. The host
 * (REPL quit path) concatenates with `\n`, writes to stdout, and exits.
 * This makes the banner trivial to snapshot-test.
 *
 * @module goodbye-banner
 */

import { c } from "../style/ansi.ts"

export interface GoodbyeOptions {
  /** Session id to include in the resume hint. Empty/missing → degraded copy. */
  sessionId?: string | null
  /** Command name to embed in the resume line. Default `"minimal-agent"`. */
  command?: string
  /** Optional reason — affects only the heading. Default no suffix. */
  reason?: "confirmed" | "escape-hatch"
}

/**
 * Build the goodbye banner lines.
 *
 * @returns array of fully-styled lines (no trailing `\n` on the last one;
 *   caller decides whether to append).
 */
export function formatGoodbye(opts: GoodbyeOptions = {}): string[] {
  const sid = (opts.sessionId ?? "").trim()
  const cmd = opts.command ?? "minimal-agent"
  const escapeHatch = opts.reason === "escape-hatch"

  const rail = c.faintWhite
  const head = `${rail("╭")} ${c.bold(c.pink("bye"))} ${c.lime("✦")}`

  const lines: string[] = []
  lines.push("")
  lines.push(`  ${head}`)
  if (sid) {
    lines.push(`  ${rail("│")} ${c.sky("session".padEnd(7))}  ${sid}`)
    lines.push(`  ${rail("│")} ${c.sky("resume".padEnd(7))}   ${cmd} --resume ${sid}`)
  } else {
    // No session id available — print a degraded footer.
    lines.push(`  ${rail("│")} ${c.dim("(no session id available — start fresh next time)")}`)
  }
  const closer = escapeHatch
    ? `${rail("╰")} ${c.dim("force-quit — see you")}`
    : `${rail("╰")} ${c.dim("thanks for using minimal-agent")}`
  lines.push(`  ${closer}`)
  lines.push("")

  return lines
}

/**
 * Print the goodbye banner to the given stream (default stderr to match
 * the startup banner). Caller is responsible for any cursor/compositor
 * teardown beforehand.
 */
export function printGoodbye(
  opts: GoodbyeOptions = {},
  stream: { write: (s: string) => void } = process.stderr,
): void {
  stream.write(`${formatGoodbye(opts).join("\n")}\n`)
}
