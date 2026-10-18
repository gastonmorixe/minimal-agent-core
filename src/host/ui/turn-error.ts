/**
 * Render a failed turn as the red `error <message>` line, plus the provider
 * hint (see `llm/error-hint.ts`) on its own dim line under it.
 *
 * Shared by the live-area REPL, the plain REPL, and the non-interactive path,
 * so every surface shows the hint the same way.
 *
 * @module host/ui/turn-error
 */

import { errorCode, errorHint } from "../../llm/error-hint.ts"

import { c } from "./style/ansi.ts"

export { errorCode, errorHint }

/** Indent that aligns the hint under the message (after `  error `). */
const HINT_INDENT = "        "

/** The dim hint line for `err` (with trailing newline), or `""` when none. */
export function formatErrorHintLine(err: unknown): string {
  const hint = errorHint(err)
  return hint ? `${HINT_INDENT}${c.dim(hint)}\n` : ""
}

/** `\n  error <message>\n` plus the dim hint line when the error has one. */
export function formatTurnError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `\n  ${c.boldRed("error")} ${msg}\n${formatErrorHintLine(err)}`
}

/**
 * The process-level `fatal: <message>` text (non-interactive runs), plus the
 * dim hint line when the error has one. No trailing newline.
 */
export function formatFatalError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const hint = errorHint(err)
  return hint ? `fatal: ${msg}\n  ${c.dim(hint)}` : `fatal: ${msg}`
}
