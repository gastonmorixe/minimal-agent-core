/**
 * The interactive resume decision for the CLI entry point.
 *
 * A resume paints the human resume header and replays the history to
 * stdout only when the run enters the REPL. A run with any prompt source
 * (`--prompt`, `-p`, `--prompt=x`, a positional prompt, or `-` for stdin)
 * is non-interactive. Its stdout must stay clean, for example for
 * stream-json, where every line is JSON.
 *
 * The decision reads the parsed prompt source, the same value that picks
 * the REPL path. So the two can never disagree.
 *
 * @module host/startup/resume-mode
 */

import type { PromptSource } from "../../cli/extract-prompt.ts"

/**
 * True when a resumed run enters the REPL.
 *
 * @param resumeSid - The resolved resume source id, or null when not resuming.
 * @param promptSource - The parsed prompt source for this argv.
 */
export function isInteractiveResumeRun(
  resumeSid: string | null,
  promptSource: PromptSource,
): boolean {
  return resumeSid !== null && promptSource.kind === "none"
}

/**
 * True when a failure should end stdout with the stream-json failure lines.
 * It reads the same parsed prompt source as {@link isInteractiveResumeRun}.
 * A run with no prompt enters the REPL, so it never gets JSON on the TTY,
 * even with `--output-format stream-json`. `--output-schema` stays on the
 * legacy route, so it never gets them either.
 */
export function wantsStreamJsonFailureLines(opts: {
  readonly outputFormat: string
  readonly hasOutputSchema: boolean
  readonly promptSource: PromptSource
}): boolean {
  return (
    opts.outputFormat === "stream-json" &&
    !opts.hasOutputSchema &&
    opts.promptSource.kind !== "none"
  )
}
