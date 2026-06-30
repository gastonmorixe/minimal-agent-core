/**
 * Phase 4 host adapter: the imperative shell for non-interactive output.
 *
 * Turns the pure transforms in `src/sdk/print-mode.ts` into real bytes on
 * `process.stdout` / `process.stderr`, following the Codex non-interactive
 * model my research distilled:
 *
 *   - `--json`: every {@link AgentEvent} is serialized to one JSONL line on
 *     STDOUT. Progress and the final answer are both events; nothing else
 *     touches stdout. A program parses the stream.
 *   - human (default): progress lines go to STDERR, the final answer goes to
 *     STDOUT — and only when stdout is NOT a TTY (piped / redirected). On an
 *     interactive TTY the transcript already showed the answer, so we don't
 *     double it. This is Codex's `should_print_final_message_to_stdout`.
 *
 * The split keeps the pipe convention: `agent "fix this" | pbcopy` gets just
 * the answer on stdout, never the progress noise. The decision of WHAT to
 * render lives in the functional core (`print-mode.ts`); this module only
 * decides WHERE the bytes go.
 *
 * This is a host module under `src/host/`: it is allowed to touch
 * `process.stdout` / `process.stderr`. The SDK core never does.
 *
 * @module host/print-output
 */

import type { AgentEvent } from "../sdk/events.ts"
import {
  formatFinalMessage,
  type OutputMode,
  type PrintModeOptions,
  renderEvent,
  selectOutputMode,
  shouldPrintFinalToStdout,
} from "../sdk/print-mode.ts"

/** A minimal writable sink (stdout / stderr satisfy this structurally). */
export interface WriteStream {
  write(chunk: string): unknown
  isTTY?: boolean
}

/** Streams + TTY facts a {@link PrintOutput} needs. Injected for testability. */
export interface PrintOutputDeps {
  stdout: WriteStream
  stderr: WriteStream
  /**
   * Whether stdout is a TTY. Defaults to `stdout.isTTY === true`. The host
   * for a `--print` run over a pipe passes `false`; a test passes whatever it
   * is asserting. This is the single fact that gates final-answer echoing.
   */
  stdoutIsTTY?: boolean
}

/**
 * Routes a non-interactive run's events + final answer to the right streams
 * for the selected {@link OutputMode}. Construct once per run, `emit(event)`
 * for each structured event as it arrives, then `finish(finalText)` exactly
 * once with the run's final assistant message.
 *
 * Pure-shell: it holds no agent logic, only the WHERE-to-write decision. The
 * WHAT-to-render strings come from `print-mode.ts`.
 */
export class PrintOutput {
  private readonly mode: OutputMode
  private readonly stdout: WriteStream
  private readonly stderr: WriteStream
  private readonly stdoutIsTTY: boolean
  private readonly outputSchema?: object
  /** Guards against a double `finish()` double-printing the final answer. */
  private finished = false

  constructor(opts: PrintModeOptions, deps: PrintOutputDeps) {
    this.mode = opts.mode
    this.outputSchema = opts.outputSchema
    this.stdout = deps.stdout
    this.stderr = deps.stderr
    this.stdoutIsTTY = deps.stdoutIsTTY ?? deps.stdout.isTTY === true
  }

  /** The resolved output mode for this run. */
  outputMode(): OutputMode {
    return this.mode
  }

  /**
   * Route one structured event. In `json` mode the serialized JSONL line goes
   * to STDOUT (the machine stream). In human mode the progress line goes to
   * STDERR, leaving stdout clean for the final answer. Empty renders (events
   * with no progress signal) are skipped so the host writes no blank lines.
   */
  emit(event: AgentEvent): void {
    const line = renderEvent(event, this.mode)
    if (line.length === 0) return
    if (this.mode === "json") this.stdout.write(line)
    else this.stderr.write(`${line}\n`)
  }

  /**
   * Write the run's final assistant message, exactly once, at the end.
   *
   * - `json`: the final answer is emitted as a terminal `item_completed`
   *   JSONL event on STDOUT (so a consumer reads it from the stream, not as
   *   out-of-band prose).
   * - human: the answer is written to STDOUT only when stdout is NOT a TTY
   *   (piped / redirected). On an interactive TTY it is suppressed to avoid
   *   double-printing what the transcript already showed.
   */
  finish(finalText: string): void {
    if (this.finished) return
    this.finished = true
    if (this.mode === "json") {
      // formatFinalMessage(json) already produces a JSONL item_completed line.
      this.stdout.write(formatFinalMessage(finalText, this.mode))
      return
    }
    if (!shouldPrintFinalToStdout({ mode: this.mode, isTTY: this.stdoutIsTTY })) return
    const out = formatFinalMessage(finalText, this.mode)
    if (out.length > 0) this.stdout.write(out)
  }

  /**
   * The JSON Schema the host should constrain the model's final answer to,
   * when `--output-schema FILE` was passed. Carried, not interpreted, here:
   * the caller threads it into the model request's structured-output config.
   */
  schema(): object | undefined {
    return this.outputSchema
  }
}

/**
 * Resolve {@link PrintModeOptions} from the parsed CLI flags + terminal shape.
 * A thin host wrapper over the core's {@link selectOutputMode} so index.ts has
 * one call site. `outputSchema` is the already-parsed JSON Schema object (the
 * host reads + JSON.parses the `--output-schema FILE` before calling this).
 */
export function resolvePrintModeOptions(opts: {
  jsonFlag: boolean
  stdoutIsTTY: boolean
  outputSchema?: object
}): PrintModeOptions {
  const mode = selectOutputMode({ isTTY: opts.stdoutIsTTY, jsonFlag: opts.jsonFlag })
  return opts.outputSchema === undefined ? { mode } : { mode, outputSchema: opts.outputSchema }
}
